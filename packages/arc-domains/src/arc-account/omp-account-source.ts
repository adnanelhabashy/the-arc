import { randomUUID } from "node:crypto";
import type { ArcAgentId } from "../arc-agent/types.js";
import {
  buildArcManagedRuntimeEnvironment,
  resolveActiveArcRuntimes,
} from "../arc-runtime/environment.js";
import type { ArcRuntimePaths } from "../arc-runtime/paths.js";
import {
  ArcAccountError,
  type ArcAccount,
  type ArcAccountProviderFamily,
  type ArcAccountSource,
  type ArcClaudeLoginChallenge,
  type ArcOmpLoginChallenge,
  type ArcOmpLoginPoll,
  type ArcOmpProvider,
  type ArcOpenAiLoginChallenge,
  type ArcOpenAiLoginPoll,
} from "./types.js";

// ─── Investigation record (oh-my-pi v18.2.6, verified live + source) ──────
//
// Provider discovery: `omp auth-broker list --json` returns the static OAuth
// registry ([{id, name}], 75 providers in 18.2.6). It is NOT an account
// list — a fresh isolated config still reports all 75.
//
// Account discovery: the auth broker's `GET /v1/snapshot` returns every
// stored credential (id, provider, type oauth|api_key, identity fields,
// credential blocks, identityKey) from OMP's own SQLite store. That is the
// only complete machine-readable inventory: `omp usage --json` culls
// providers without usage endpoints. Arc therefore lazily starts a loopback
// broker (ephemeral port, bearer token from `omp auth-broker token`), reads
// the snapshot, and maps metadata only — access/refresh tokens and api keys
// in the response are never retained, logged, or forwarded.
//
// Login: `omp auth-broker login <provider>` drives the official provider
// flow in-process: it prints an authorize URL (OAuth) or prompts for an API
// key, then persists into the same store. Arc captures the URL/prompt, lets
// the user authenticate on the provider's surface, and polls the process
// exit. Cancel = SIGTERM.
//
// Logout: `omp auth-broker logout <provider>` removes ALL credentials for a
// provider; per-account removal does not exist in 18.2.6. Enable/disable and
// priority/reorder have no native OMP equivalent either — those operations
// fail honestly instead of inventing semantics.

const BROKER_BIND_HOST = "127.0.0.1";
const DEFAULT_BROKER_IDLE_TTL_MS = 60_000;
// A pinned OMP execution resolves its credentials through the broker for the
// whole life of its provider process, so a hold has to outlive the single env
// resolution that created it. Renewals come from each later resolution and
// health check for that provider; past this window without one, the broker
// returns to its normal idle shutdown rather than living forever.
const DEFAULT_BROKER_HOLD_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_BROKER_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_SNAPSHOT_TTL_MS = 5_000;
const LOGIN_START_TIMEOUT_MS = 15_000;

// Kimi's device flow points at www.kimi.com (mainland site: WeChat QR /
// phone login). Arc users hold accounts on the international site, so the
// challenge URL is rewritten to kimi.ai before it reaches the UI.
const OMP_AUTHORIZE_HOST_OVERRIDES: Record<string, string> = {
  "kimi-code": "kimi.ai",
};

function applyAuthorizeUrlOverride(
  provider: string,
  url: string | null,
): string | null {
  const host = OMP_AUTHORIZE_HOST_OVERRIDES[provider];
  if (url === null || host === undefined) return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "www.kimi.com" || parsed.hostname === "kimi.com") {
      parsed.hostname = host;
      return parsed.toString();
    }
  } catch {
    // Not a parseable URL — forward it unchanged.
  }
  return url;
}

export interface ArcOmpRuntime {
  executablePath: string;
  env: NodeJS.ProcessEnv;
}

export type ResolveArcOmpRuntime = () => Promise<ArcOmpRuntime | null>;

export interface CreateArcOmpRuntimeResolverArgs {
  createdByArcVersion: string;
  homeDirectory?: string;
  platform: string;
  runtimePaths: ArcRuntimePaths;
  // Base environment for OMP children. Defaults to process.env in the
  // desktop app; tests inject a controlled environment. Only used to build
  // the Arc-managed child environment (PATH + OMP isolation variables).
  env?: NodeJS.ProcessEnv;
}

// Resolves the Arc-managed OMP runtime from the runtime manifest. Returns
// null when OMP is not prepared (the caller maps that to
// "omp-runtime-unavailable"). A fake/global OMP on PATH can never win: the
// executable path comes from the manifest and the child environment applies
// Arc's private PI_CONFIG_DIR / PI_CODING_AGENT_DIR isolation.
export function createArcOmpRuntimeResolver(
  args: CreateArcOmpRuntimeResolverArgs,
): ResolveArcOmpRuntime {
  return async () => {
    const activeRuntimes = await resolveActiveArcRuntimes({
      createdByArcVersion: args.createdByArcVersion,
      platform: args.platform,
      runtimePaths: args.runtimePaths,
    });
    const omp = activeRuntimes.find((runtime) => runtime.id === "omp");
    if (omp === undefined) {
      return null;
    }
    const env = buildArcManagedRuntimeEnvironment({
      activeRuntimes,
      env: { ...(args.env ?? process.env) },
      homeDirectory: args.homeDirectory,
      platform: args.platform as NodeJS.Platform,
      runtimePaths: args.runtimePaths,
    });
    return { executablePath: omp.executablePath, env };
  };
}

// ─── Process seam ─────────────────────────────────────────────────────────

export interface OmpChildProcess {
  pid: number | null;
  writeLine(line: string): void;
  kill(signal?: NodeJS.Signals): void;
  // Raw stdout/stderr chunks (not line-buffered): interactive prompts such
  // as "Paste your API key (sk-...): " have no trailing newline, so
  // consumers must handle partial lines.
  onStdoutData(listener: (chunk: string) => void): void;
  onStderrData(listener: (chunk: string) => void): void;
  wait(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export interface OmpSpawnArgs {
  executablePath: string;
  env: NodeJS.ProcessEnv;
  argv: string[];
}

export type OmpSpawn = (args: OmpSpawnArgs) => OmpChildProcess;

export interface OmpBrokerOwnershipRecord {
  pid: number;
  executablePath: string;
  startedAt: string;
}

export interface OmpBrokerOwnership {
  record(record: OmpBrokerOwnershipRecord): Promise<void>;
  clear(pid: number): Promise<void>;
}

// Splits a raw chunk stream into newline-terminated lines while keeping the
// unterminated tail accessible — interactive prompts ("Paste your API key:
// ") never end with a newline and would be invisible to pure line parsing.
class StreamLines {
  private tail = "";

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: string): void {
    this.tail += chunk;
    let index: number;
    while ((index = this.tail.indexOf("\n")) >= 0) {
      const line = this.tail.slice(0, index);
      this.tail = this.tail.slice(index + 1);
      this.onLine(line);
    }
  }

  remainder(): string {
    return this.tail;
  }
}

// ─── Wire shapes (broker /v1/snapshot, allowlisted fields only) ───────────

interface OmpSnapshotCredentialIdentity {
  email?: string;
  accountId?: string;
  projectId?: string;
  orgId?: string;
  orgName?: string;
  enterpriseUrl?: string;
  authorizedAt?: number;
}

interface OmpSnapshotBlock {
  blockScope: string;
  blockedUntilMs: number;
}

interface OmpSnapshotEntry {
  id: number;
  provider: string;
  type: "oauth" | "api_key";
  identity: OmpSnapshotCredentialIdentity;
  identityKey: string | null;
  blocks: OmpSnapshotBlock[];
}

interface OmpSnapshot {
  entries: OmpSnapshotEntry[];
}

interface OmpBrokerWire {
  healthz(): Promise<{ ok: boolean }>;
  snapshot(): Promise<unknown>;
  usage(): Promise<unknown>;
  disabledCredentials(): Promise<unknown>;
}

// Maps the broker snapshot response to metadata only. Deliberately reads an
// allowlist of fields so secret material (access tokens, api keys, refresh
// sentinels) can never leak into Arc's account model even if the broker
// starts returning more.
function mapSnapshot(payload: unknown): OmpSnapshot {
  if (typeof payload !== "object" || payload === null) {
    throw new ArcAccountError(
      "account-source-unavailable",
      "OMP broker returned a malformed snapshot",
    );
  }
  const rawEntries = (payload as { credentials?: unknown }).credentials;
  if (!Array.isArray(rawEntries)) {
    throw new ArcAccountError(
      "account-source-unavailable",
      "OMP broker snapshot has no credential list",
    );
  }
  const entries: OmpSnapshotEntry[] = [];
  for (const raw of rawEntries) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as {
      id?: unknown;
      provider?: unknown;
      credential?: unknown;
      identityKey?: unknown;
      blocks?: unknown;
    };
    const credential = (
      typeof entry.credential === "object" && entry.credential !== null
        ? entry.credential
        : {}
    ) as { type?: unknown } & OmpSnapshotCredentialIdentity;
    const type = credential.type === "api_key" ? "api_key" : "oauth";
    const rawBlocks = Array.isArray(entry.blocks) ? entry.blocks : [];
    const blocks: OmpSnapshotBlock[] = [];
    for (const rawBlock of rawBlocks) {
      if (typeof rawBlock !== "object" || rawBlock === null) continue;
      const block = rawBlock as {
        blockScope?: unknown;
        blockedUntilMs?: unknown;
      };
      if (typeof block.blockedUntilMs !== "number") continue;
      blocks.push({
        blockScope:
          typeof block.blockScope === "string" ? block.blockScope : "unknown",
        blockedUntilMs: block.blockedUntilMs,
      });
    }
    entries.push({
      id: typeof entry.id === "number" ? entry.id : -1,
      provider: typeof entry.provider === "string" ? entry.provider : "unknown",
      type,
      identity: {
        email: typeof credential.email === "string" ? credential.email : undefined,
        accountId:
          typeof credential.accountId === "string" ? credential.accountId : undefined,
        projectId:
          typeof credential.projectId === "string" ? credential.projectId : undefined,
        orgId: typeof credential.orgId === "string" ? credential.orgId : undefined,
        orgName:
          typeof credential.orgId === "string" && typeof credential.orgName === "string"
            ? credential.orgName
            : undefined,
        enterpriseUrl:
          typeof credential.enterpriseUrl === "string"
            ? credential.enterpriseUrl
            : undefined,
        authorizedAt:
          typeof credential.authorizedAt === "number"
            ? credential.authorizedAt
            : undefined,
      },
      identityKey:
        typeof entry.identityKey === "string" ? entry.identityKey : null,
      blocks,
    });
  }
  return { entries };
}

export function mapOmpSnapshotEntry(
  entry: OmpSnapshotEntry,
  providerLabel: string,
  now: number,
): ArcAccount {
  const identity = entry.identity;
  // Canonical identity is provider-issued only (Phase 7 ADR-039). OMP's
  // accountId is the provider account id when the provider reports one;
  // email is presentation metadata and is never used as identity.
  const accountKey =
    identity.accountId !== undefined && identity.accountId.length > 0
      ? `omp:${entry.provider}:${identity.accountId}`
      : null;
  const blocked = entry.blocks.some((block) => block.blockedUntilMs > now);
  return {
    id: `omp:${entry.provider}:${entry.id}`,
    sourceId: `${entry.provider}:${entry.id}`,
    sourceKind: "omp",
    providerFamily: entry.provider as ArcAccountProviderFamily,
    providerLabel,
    accountKey,
    // OMP's own credential identity (`account:<provider account id>`), the
    // only handle OMP's account-pool filter matches on. Kept even though it is
    // not Arc's canonical key: it is what pins one OMP execution to one stored
    // credential. OMP stores an empty key for api-key credentials, which can
    // be neither pinned nor excluded — reported as absent, never as "".
    identityKey:
      entry.identityKey !== null && entry.identityKey.length > 0
        ? entry.identityKey
        : null,
    email: identity.email ?? null,
    // OMP 18.2.6 does not report plan/subscription metadata in its
    // credential snapshot; unknown stays null (never "free").
    planLabel: null,
    authState: blocked ? "disabled" : "connected",
    // OMP has no user-facing enable/disable; a blocked credential is an
    // automatic provider-side state, not user intent.
    enabled: true,
    availableThrough: ["omp" as ArcAgentId],
    observedAt: now,
  };
}

// Classifies what an OAuth login session actually is, from the live broker
// output. Device flows (Kimi, and similar OAuth device providers) print a
// verification URL carrying a `user_code` parameter and/or an
// "Enter code: XXXX-XXXX" line; the user code is surfaced so the UI can
// show it prominently. Everything else is a plain browser redirect flow.
function classifyOauthFlow(session: {
  authorizeUrl: string | null;
  instructions: string | null;
}): { flow: "browser" | "device"; userCode: string | null } {
  const url = session.authorizeUrl;
  if (url !== null) {
    try {
      const parsed = new URL(url);
      const code = parsed.searchParams.get("user_code");
      if (code !== null && code.length > 0) {
        return { flow: "device", userCode: code };
      }
    } catch {
      // Not a parseable URL; fall through to instruction sniffing.
    }
  }
  const instructions = session.instructions;
  if (instructions !== null) {
    const match = /enter code[: ]+([A-Za-z0-9-]+)/i.exec(instructions);
    if (match !== null) {
      return { flow: "device", userCode: match[1] ?? null };
    }
  }
  return { flow: "browser", userCode: null };
}

// ─── Broker session (lazy, loopback-only, idle-stopped) ───────────────────

interface OmpBrokerSession {
  url: string;
  token: string;
  wire: OmpBrokerWire;
  process: OmpChildProcess;
}

interface Scheduler {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface OmpAccountSourceArgs {
  resolveRuntime: ResolveArcOmpRuntime;
  spawn?: OmpSpawn;
  fetchImpl?: typeof fetch;
  now?: () => number;
  brokerIdleTtlMs?: number;
  brokerHoldTtlMs?: number;
  brokerStopTimeoutMs?: number;
  snapshotTtlMs?: number;
  scheduler?: Scheduler;
  loginStartTimeoutMs?: number;
  brokerOwnership?: OmpBrokerOwnership;
}

export interface ArcOmpBrokerConnection {
  url: string;
  token: string;
}

interface LoginSessionState {
  id: string;
  provider: string;
  process: OmpChildProcess;
  kind: "oauth" | "api-key";
  authorizeUrl: string | null;
  instructions: string | null;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  lastStderr: string;
  terminal: "connected" | "failed" | "cancelled" | null;
}

export class OmpAccountSource implements ArcAccountSource {
  readonly kind = "omp" as const;

  private readonly resolveRuntime: ResolveArcOmpRuntime;
  private readonly spawn: OmpSpawn | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly brokerIdleTtlMs: number;
  private readonly brokerHoldTtlMs: number;
  private readonly brokerStopTimeoutMs: number;
  private readonly snapshotTtlMs: number;
  private readonly scheduler: Scheduler;
  private readonly loginStartTimeoutMs: number;
  private readonly brokerOwnership: OmpBrokerOwnership | null;

  private brokerPromise: Promise<OmpBrokerSession> | null = null;
  private brokerIdleTimer: unknown = null;
  private brokerHeldUntil = 0;
  private snapshotCache: { at: number; snapshot: OmpSnapshot } | null = null;
  private registryCache: { at: number; providers: ArcOmpProvider[] } | null =
    null;
  private readonly loginSessions = new Map<string, LoginSessionState>();

  constructor(args: OmpAccountSourceArgs) {
    this.resolveRuntime = args.resolveRuntime;
    this.spawn = args.spawn;
    this.fetchImpl = args.fetchImpl ?? fetch;
    this.now = args.now ?? Date.now;
    this.brokerIdleTtlMs = args.brokerIdleTtlMs ?? DEFAULT_BROKER_IDLE_TTL_MS;
    this.brokerHoldTtlMs =
      args.brokerHoldTtlMs ?? DEFAULT_BROKER_HOLD_TTL_MS;
    this.brokerStopTimeoutMs =
      args.brokerStopTimeoutMs ?? DEFAULT_BROKER_STOP_TIMEOUT_MS;
    this.brokerOwnership = args.brokerOwnership ?? null;
    this.snapshotTtlMs = args.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
    this.scheduler = args.scheduler ?? {
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
    };
    this.loginStartTimeoutMs =
      args.loginStartTimeoutMs ?? LOGIN_START_TIMEOUT_MS;
  }

  // ── ArcAccountSource ────────────────────────────────────────────────

  async listAccounts(): Promise<ArcAccount[]> {
    const snapshot = await this.readSnapshot();
    const labels = await this.providerLabelMap();
    const now = this.now();
    return snapshot.entries.map((entry) =>
      mapOmpSnapshotEntry(
        entry,
        labels.get(entry.provider) ?? entry.provider,
        now,
      ),
    );
  }

  // ArcOmpUsageGateway seam: this source only ever reports its own OMP
  // accounts, so the inventory is the account list. Reads the local
  // snapshot through the lazy broker lifecycle — never a permanent process.
  async listOmpAccounts(): Promise<ArcAccount[]> {
    return this.listAccounts();
  }

  async getAccount(sourceId: string): Promise<ArcAccount> {
    const account = (await this.listAccounts()).find(
      (entry) => entry.sourceId === sourceId,
    );
    if (account === undefined) {
      throw new ArcAccountError("account-not-found", sourceId);
    }
    return account;
  }

  // OMP 18.2.6 has no native enable/disable for credentials (only automatic
  // provider-side blocks); inventing persistent disable semantics would
  // require modifying OMP-owned state, so this is reported honestly.
  async setAccountEnabled(
    _sourceId: string,
    _enabled: boolean,
  ): Promise<ArcAccount> {
    throw new ArcAccountError(
      "unsupported-provider",
      "OMP does not support enabling or disabling individual accounts",
    );
  }

  // `omp auth-broker logout <provider>` removes every credential for the
  // provider. Per-account removal only proceeds when the account is the
  // provider's sole credential; otherwise the operation fails honestly
  // rather than silently dropping the user's other accounts.
  async removeAccount(sourceId: string): Promise<void> {
    const separator = sourceId.indexOf(":");
    if (separator <= 0) {
      throw new ArcAccountError("account-not-found", sourceId);
    }
    const provider = sourceId.slice(0, separator);
    const snapshot = await this.readSnapshot();
    const siblings = snapshot.entries.filter(
      (entry) => entry.provider === provider,
    );
    const target = siblings.find(
      (entry) => `${entry.provider}:${entry.id}` === sourceId,
    );
    if (target === undefined) {
      throw new ArcAccountError("account-not-found", sourceId);
    }
    if (siblings.length > 1) {
      throw new ArcAccountError(
        "disconnect-failed",
        `OMP removes all credentials for a provider at once and "${provider}" has ${siblings.length} accounts; remove is not available per account`,
      );
    }
    const runtime = await this.requireRuntime();
    const child = this.requireSpawn()({
      argv: ["auth-broker", "logout", provider],
      env: runtime.env,
      executablePath: runtime.executablePath,
    });
    const exit = await child.wait();
    if (exit.code !== 0) {
      throw new ArcAccountError(
        "disconnect-failed",
        `omp auth-broker logout exited with code ${exit.code ?? String(exit.signal)}`,
      );
    }
    this.snapshotCache = null;
  }

  // OMP owns provider selection itself (storage order + round-robin); there
  // is no priority or reorder API in 18.2.6 and Arc invents none.
  async setAccountPriority(
    _sourceId: string,
    _priority: number,
  ): Promise<ArcAccount> {
    throw new ArcAccountError(
      "unsupported-provider",
      "OMP does not support account priority",
    );
  }

  async reorderAccounts(
    _providerFamily: ArcAccountProviderFamily,
    _orderedSourceIds: string[],
  ): Promise<void> {
    throw new ArcAccountError(
      "unsupported-provider",
      "OMP does not support account reordering",
    );
  }

  async startOpenAiLogin(): Promise<ArcOpenAiLoginChallenge> {
    throw new ArcAccountError(
      "unsupported-provider",
      "OpenAI device login is provided by the account pool, not OMP",
    );
  }

  async pollOpenAiLogin(
    _sessionId: string,
  ): Promise<ArcOpenAiLoginPoll> {
    throw new ArcAccountError(
      "unsupported-provider",
      "OpenAI device login is provided by the account pool, not OMP",
    );
  }

  async cancelOpenAiLogin(_sessionId: string): Promise<void> {
    throw new ArcAccountError(
      "unsupported-provider",
      "OpenAI device login is provided by the account pool, not OMP",
    );
  }

  async startClaudeLogin(): Promise<ArcClaudeLoginChallenge> {
    throw new ArcAccountError(
      "unsupported-provider",
      "Claude OAuth login is provided by the account pool, not OMP",
    );
  }

  async completeClaudeLogin(
    _sessionId: string,
    _code: string,
  ): Promise<ArcAccount> {
    throw new ArcAccountError(
      "unsupported-provider",
      "Claude OAuth login is provided by the account pool, not OMP",
    );
  }

  // ── OMP-specific operations ─────────────────────────────────────────

  // Supported OAuth providers straight from `omp auth-broker list --json`
  // (the static registry), merged with observed connection state from the
  // credential snapshot. Registry entries are never reported as accounts.
  async listOmpProviders(): Promise<ArcOmpProvider[]> {
    const registry = await this.readRegistry();
    const snapshot = await this.readSnapshot();
    const connected = new Set(snapshot.entries.map((entry) => entry.provider));
    const apiKeyProviders = new Set(
      snapshot.entries
        .filter((entry) => entry.type === "api_key")
        .map((entry) => entry.provider),
    );
    return registry.map((provider) => ({
      ...provider,
      authMethod: apiKeyProviders.has(provider.id)
        ? ("api-key" as const)
        : ("oauth" as const),
      connectionState: connected.has(provider.id)
        ? ("connected" as const)
        : ("not-connected" as const),
      hasAccounts: connected.has(provider.id),
    }));
  }

  // Starts OMP's official provider login (`omp auth-broker login <id>`) and
  // captures the authorize URL (OAuth providers) or key prompt (API-key
  // providers). Authentication happens on the provider's own surface; Arc
  // never sees passwords and api keys only pass through to the OMP child's
  // stdin on submitOmpLoginKey.
  async startOmpLogin(provider: string): Promise<ArcOmpLoginChallenge> {
    const registry = await this.readRegistry();
    if (!registry.some((entry) => entry.id === provider)) {
      throw new ArcAccountError(
        "provider-not-found",
        `OMP has no OAuth provider "${provider}"`,
      );
    }
    const runtime = await this.requireRuntime();
    const child = this.requireSpawn()({
      argv: ["auth-broker", "login", provider],
      env: runtime.env,
      executablePath: runtime.executablePath,
    });

    const session: LoginSessionState = {
      id: randomUUID(),
      provider,
      process: child,
      kind: "oauth",
      authorizeUrl: null,
      instructions: null,
      exit: null,
      lastStderr: "",
      terminal: null,
    };
    this.loginSessions.set(session.id, session);
    void child
      .wait()
      .then((result) => {
        session.exit = result;
      })
      .catch(() => {
        session.exit = { code: null, signal: "SIGTERM" };
      });

    const started = this.now();
    let sawAuthHeader = false;
    const detectPrompt = (text: string): void => {
      // API-key providers may print a dashboard URL first and then prompt
      // for the key (e.g. DeepSeek). An explicit key prompt always wins:
      // the flow awaits a credential, not a browser redirect. Prompts have
      // no trailing newline, so the unterminated stream tail is checked.
      if (/paste your .*api key/i.test(text)) {
        session.kind = "api-key";
        session.instructions = text.trim();
        return;
      }
      // Generic prompt fallback: a line that ends in a prompt colon with no
      // URL seen yet means the flow awaits a key.
      if (
        session.authorizeUrl === null &&
        /:\s*$/.test(text.trim()) &&
        /paste|api key|token/i.test(text)
      ) {
        session.kind = "api-key";
        session.instructions = text.trim();
      }
    };
    const stdout = new StreamLines((line) => {
      const trimmed = line.trim();
      if (/open this url in your browser/i.test(trimmed)) {
        sawAuthHeader = true;
        return;
      }
      if (
        sawAuthHeader &&
        session.authorizeUrl === null &&
        /^https?:\/\//.test(trimmed)
      ) {
        session.authorizeUrl = trimmed;
        return;
      }
      if (
        session.authorizeUrl !== null &&
        session.instructions === null &&
        trimmed.length > 0
      ) {
        session.instructions = trimmed;
      }
    });
    child.onStdoutData((chunk) => {
      stdout.push(chunk);
      detectPrompt(stdout.remainder());
    });
    const stderr = new StreamLines((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      // Stack frames and bundled-binary paths are noise, not diagnostics.
      if (/^at\s/.test(trimmed) || trimmed.includes("omp-darwin-arm64")) {
        return;
      }
      session.lastStderr = trimmed;
    });
    child.onStderrData((chunk) => {
      stderr.push(chunk);
      const tail = stderr.remainder().trim();
      if (
        tail.length > 0 &&
        !/^at\s/.test(tail) &&
        !tail.includes("omp-darwin-arm64")
      ) {
        session.lastStderr = tail;
      }
    });

    // Wait briefly for the URL/prompt so a successful start is observable
    // synchronously; slow providers simply report "waiting-for-user" until
    // poll settles. A dead process or one that never produces an authorize
    // URL/prompt fails fast rather than leaving a session that can never
    // complete.
    while (
      session.authorizeUrl === null &&
      session.kind === "oauth" &&
      session.exit === null &&
      this.now() - started < this.loginStartTimeoutMs
    ) {
      await this.tick(25);
    }
    if (session.authorizeUrl === null && session.kind === "oauth") {
      const detail =
        session.exit !== null
          ? (session.lastStderr ||
              `omp auth-broker login exited with code ${session.exit.code ?? String(session.exit.signal)}`)
          : "OMP did not produce an authorize URL or credential prompt";
      this.loginSessions.delete(session.id);
      throw new ArcAccountError("login-failed", detail);
    }

    return {
      provider,
      sessionId: session.id,
      kind: session.kind,
      ...classifyOauthFlow(session),
      authorizeUrl: applyAuthorizeUrlOverride(provider, session.authorizeUrl),
      instructions: session.instructions,
      // OMP does not expose OAuth session expiry; unknown stays null.
      expiresAt: null,
    };
  }

  // Submits an API key for an api-key-style login session. The key travels
  // only into the OMP child's stdin and is never stored, logged, or placed
  // in an ArcAccount.
  submitOmpLoginKey(sessionId: string, key: string): void {
    const session = this.loginSessions.get(sessionId);
    if (session === undefined) {
      throw new ArcAccountError("account-not-found", sessionId);
    }
    if (session.kind !== "api-key") {
      throw new ArcAccountError(
        "auth-not-supported",
        "this login session expects a browser OAuth flow, not an API key",
      );
    }
    session.process.writeLine(key);
  }

  async pollOmpLogin(sessionId: string): Promise<ArcOmpLoginPoll> {
    const session = this.loginSessions.get(sessionId);
    if (session === undefined) {
      throw new ArcAccountError("account-not-found", sessionId);
    }
    // Yield one macrotask so a just-settled child exit is observed (the
    // exit flag is recorded on the child wait promise's continuation, which
    // a single microtask would race). Executor form: this package's
    // consumers compile against a lib target without Promise.withResolvers.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (session.terminal === "cancelled") {
      this.loginSessions.delete(sessionId);
      return { state: "failed", account: null, message: "login was cancelled" };
    }
    if (session.exit === null) {
      return { state: "waiting-for-user", account: null, message: null };
    }
    const exit = session.exit;
    if (exit.code === 0) {
      // Credentials were persisted by OMP; refresh the inventory so the
      // poll can return the freshly connected account.
      this.snapshotCache = null;
      const accounts = await this.listAccounts().catch(() => []);
      const account =
        accounts.find(
          (entry) =>
            entry.providerFamily === session.provider &&
            entry.authState === "connected",
        ) ?? null;
      this.loginSessions.delete(sessionId);
      return { state: "connected", account, message: null };
    }
    this.loginSessions.delete(sessionId);
    return {
      state: "failed",
      account: null,
      message: session.lastStderr || `login exited with code ${exit.code ?? String(exit.signal)}`,
    };
  }

  async cancelOmpLogin(sessionId: string): Promise<void> {
    const session = this.loginSessions.get(sessionId);
    if (session === undefined) {
      throw new ArcAccountError("account-not-found", sessionId);
    }
    session.terminal = "cancelled";
    session.process.kill("SIGTERM");
    // The session stays in the map so a following poll observes the
    // terminal "cancelled" state instead of an account-not-found error.
  }

  // Holds the loopback broker open for a pinned OMP execution. oh-my-pi
  // resolves credentials through the broker in that mode and fails startup
  // when it is unreachable, and the provider process outlives this call, so
  // the hold is a deadline (see DEFAULT_BROKER_HOLD_TTL_MS) renewed by every
  // later resolution for the provider, not a release the caller must pair.
  async holdBrokerForExecution(): Promise<ArcOmpBrokerConnection> {
    this.brokerHeldUntil = this.now() + this.brokerHoldTtlMs;
    const broker = await this.ensureBroker();
    return { url: broker.url, token: broker.token };
  }

  // Extends a live hold. Returns false when none is live, so a caller can
  // report "not holding" instead of keeping an idle broker alive forever.
  renewBrokerHold(): boolean {
    if (this.brokerHeldUntil <= this.now()) return false;
    this.brokerHeldUntil = this.now() + this.brokerHoldTtlMs;
    this.armBrokerIdleTimer();
    return true;
  }

  // Stops the lazily-started broker immediately (idle shutdown also happens
  // automatically after brokerIdleTtlMs of inactivity). Arc never leaves an
  // OMP broker — or any OMP process — running in the background.
  async shutdown(): Promise<void> {
    this.clearBrokerIdleTimer();
    this.brokerHeldUntil = 0;
    const broker = this.brokerPromise;
    this.brokerPromise = null;
    this.snapshotCache = null;
    if (broker === null) return;
    const session = await broker.catch(() => null);
    if (session === null) return;
    await this.terminateBroker(session);
  }

  // Full teardown for plugin disposal: the broker plus any interactive login
  // child. Idle shutdown deliberately leaves login children alone, because an
  // interactive login can outlive the idle window.
  async dispose(): Promise<void> {
    for (const session of this.loginSessions.values()) {
      session.process.kill("SIGTERM");
    }
    await this.shutdown();
  }

  private async terminateBroker(session: OmpBrokerSession): Promise<void> {
    const { pid } = session.process;
    session.process.kill("SIGTERM");
    const exited = await this.waitForChildExit(
      session.process,
      this.brokerStopTimeoutMs,
    );
    if (!exited) {
      session.process.kill("SIGKILL");
    }
    if (pid === null || this.brokerOwnership === null) return;
    await this.brokerOwnership.clear(pid).catch(() => undefined);
  }

  private async waitForChildExit(
    child: OmpChildProcess,
    timeoutMs: number,
  ): Promise<boolean> {
    let timer: unknown = null;
    const timedOut = new Promise<boolean>((resolveTimeout) => {
      timer = this.scheduler.setTimer(() => resolveTimeout(false), timeoutMs);
    });
    const exited = await Promise.race([
      child.wait().then(() => true),
      timedOut,
    ]);
    if (timer !== null) {
      this.scheduler.clearTimer(timer);
    }
    return exited;
  }

  // ── internals ───────────────────────────────────────────────────────

  private async providerLabelMap(): Promise<Map<string, string>> {
    const registry = await this.readRegistry().catch(() => []);
    return new Map(registry.map((entry) => [entry.id, entry.displayName]));
  }

  private async readRegistry(): Promise<ArcOmpProvider[]> {
    if (
      this.registryCache !== null &&
      this.now() - this.registryCache.at < 60_000
    ) {
      return this.registryCache.providers;
    }
    const runtime = await this.requireRuntime();
    const child = this.requireSpawn()({
      argv: ["auth-broker", "list", "--json"],
      env: runtime.env,
      executablePath: runtime.executablePath,
    });
    let stdout = "";
    child.onStdoutData((chunk) => {
      stdout += chunk;
    });
    const exit = await child.wait();
    if (exit.code !== 0) {
      throw new ArcAccountError(
        "account-source-unavailable",
        `omp auth-broker list exited with code ${exit.code ?? String(exit.signal)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new ArcAccountError(
        "account-source-unavailable",
        "omp auth-broker list returned unreadable JSON",
      );
    }
    if (!Array.isArray(parsed)) {
      throw new ArcAccountError(
        "account-source-unavailable",
        "omp auth-broker list returned a malformed provider list",
      );
    }
    const providers: ArcOmpProvider[] = parsed.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const { id, name } = entry as { id?: unknown; name?: unknown };
      if (typeof id !== "string" || id.length === 0) return [];
      return [
        {
          id,
          displayName: typeof name === "string" && name.length > 0 ? name : id,
          authMethod: "unknown" as const,
          connectionState: "unknown" as const,
          hasAccounts: false,
        },
      ];
    });
    this.registryCache = { at: this.now(), providers };
    return providers;
  }

  private async readSnapshot(): Promise<OmpSnapshot> {
    if (
      this.snapshotCache !== null &&
      this.now() - this.snapshotCache.at < this.snapshotTtlMs
    ) {
      return this.snapshotCache.snapshot;
    }
    const broker = await this.ensureBroker();
    let payload: unknown;
    try {
      payload = await broker.wire.snapshot();
    } catch (error) {
      throw new ArcAccountError(
        "account-source-unavailable",
        `OMP broker snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const snapshot = mapSnapshot(payload);
    this.snapshotCache = { at: this.now(), snapshot };
    return snapshot;
  }

  // Usage & Limits (Phase 9): fetches the broker's /v1/usage reports and
  // /v1/credentials/disabled tombstones as raw payloads. Validation and
  // mapping into the Arc usage model live in the arc-usage adapter; this
  // method only reuses the lazy loopback broker lifecycle — the broker is
  // started on demand and still idle-shuts down, so usage reads never leave
  // a permanent OMP process running.
  async fetchUsageSnapshot(): Promise<{ usage: unknown; disabled: unknown }> {
    const broker = await this.ensureBroker();
    try {
      const [usage, disabled] = await Promise.all([
        broker.wire.usage(),
        broker.wire.disabledCredentials().catch(() => null),
      ]);
      return { usage, disabled };
    } catch (error) {
      throw new ArcAccountError(
        "account-source-unavailable",
        `OMP broker usage fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Lazily starts the OMP auth broker bound to an ephemeral loopback port.
  // The bearer token is obtained from `omp auth-broker token` and used only
  // in Authorization headers against 127.0.0.1; it never reaches ArcAccount
  // objects, logs, or any UI surface.
  private async ensureBroker(): Promise<OmpBrokerSession> {
    this.clearBrokerIdleTimer();
    if (this.brokerPromise !== null) {
      this.armBrokerIdleTimer();
      return this.brokerPromise;
    }
    this.brokerPromise = this.startBroker();
    this.armBrokerIdleTimer();
    return this.brokerPromise;
  }

  private async startBroker(): Promise<OmpBrokerSession> {
    const runtime = await this.requireRuntime();
    const spawn = this.requireSpawn();
    const child = spawn({
      argv: ["auth-broker", "serve", "--bind", `${BROKER_BIND_HOST}:0`],
      env: runtime.env,
      executablePath: runtime.executablePath,
    });

    const urlPromise = new Promise<string>((resolveUrl, rejectUrl) => {
      const startupTimer = this.scheduler.setTimer(() => {
        rejectUrl(
          new ArcAccountError(
            "account-source-unavailable",
            "OMP auth broker did not report a listening address",
          ),
        );
      }, 15_000);
      const brokerLines = new StreamLines((line) => {
        const match = /auth-broker listening"\s*,\s*"url"\s*:\s*"(http:\/\/[^"]+)"/.exec(line)
          ?? /auth-broker listening.*?(http:\/\/127\.0\.0\.1:\d+)/.exec(line);
        const candidate = match?.[1];
        if (candidate === undefined) return;
        try {
          const parsed = new URL(candidate);
          // Fail safe: the broker must stay on the loopback interface. A
          // non-loopback bind is rejected before any token is used.
          if (parsed.hostname !== BROKER_BIND_HOST) {
            rejectUrl(
              new ArcAccountError(
                "account-source-unavailable",
                `OMP auth broker reported a non-loopback address (${parsed.hostname})`,
              ),
            );
            return;
          }
          this.scheduler.clearTimer(startupTimer);
          resolveUrl(candidate);
        } catch {
          // Keep waiting for a well-formed line.
        }
      });
      child.onStdoutData((chunk) => {
        brokerLines.push(chunk);
      });
    });
    const url = await urlPromise;

    const token = await this.readBrokerToken(runtime, spawn);
    const baseUrl = url;
    const fetchImpl = this.fetchImpl;
    const wire: OmpBrokerWire = {
      async healthz() {
        const response = await fetchImpl(`${baseUrl}/v1/healthz`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
          throw new Error(`healthz returned HTTP ${response.status}`);
        }
        return (await response.json()) as { ok: boolean };
      },
      async snapshot() {
        const response = await fetchImpl(`${baseUrl}/v1/snapshot`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
          throw new Error(`snapshot returned HTTP ${response.status}`);
        }
        return await response.json();
      },
      async usage() {
        const response = await fetchImpl(`${baseUrl}/v1/usage`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
          throw new Error(`usage returned HTTP ${response.status}`);
        }
        return await response.json();
      },
      async disabledCredentials() {
        const response = await fetchImpl(
          `${baseUrl}/v1/credentials/disabled`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        if (!response.ok) {
          throw new Error(
            `disabled credentials returned HTTP ${response.status}`,
          );
        }
        return await response.json();
      },
    };
    await wire.healthz().catch((error) => {
      child.kill("SIGTERM");
      throw new ArcAccountError(
        "account-source-unavailable",
        `OMP auth broker did not become healthy: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    if (child.pid !== null && this.brokerOwnership !== null) {
      await this.brokerOwnership
        .record({
          executablePath: runtime.executablePath,
          pid: child.pid,
          startedAt: new Date(this.now()).toISOString(),
        })
        .catch(() => undefined);
    }
    return { url, token, wire, process: child };
  }

  private async readBrokerToken(
    runtime: ArcOmpRuntime,
    spawn: OmpSpawn,
  ): Promise<string> {
    const child = spawn({
      argv: ["auth-broker", "token"],
      env: runtime.env,
      executablePath: runtime.executablePath,
    });
    let stdout = "";
    child.onStdoutData((chunk) => {
      stdout += chunk;
    });
    const exit = await child.wait();
    const token = stdout.trim();
    if (exit.code !== 0 || token.length === 0) {
      throw new ArcAccountError(
        "account-source-unavailable",
        "could not obtain the OMP auth broker token",
      );
    }
    return token;
  }

  private armBrokerIdleTimer(): void {
    this.clearBrokerIdleTimer();
    const holdRemainingMs = this.brokerHeldUntil - this.now();
    if (holdRemainingMs > 0) {
      this.brokerIdleTimer = this.scheduler.setTimer(() => {
        this.brokerIdleTimer = null;
        this.armBrokerIdleTimer();
      }, holdRemainingMs);
      return;
    }
    this.brokerIdleTimer = this.scheduler.setTimer(() => {
      this.brokerIdleTimer = null;
      void this.shutdown();
    }, this.brokerIdleTtlMs);
  }

  private clearBrokerIdleTimer(): void {
    if (this.brokerIdleTimer !== null) {
      this.scheduler.clearTimer(this.brokerIdleTimer);
      this.brokerIdleTimer = null;
    }
  }

  private async requireRuntime(): Promise<ArcOmpRuntime> {
    const runtime = await this.resolveRuntime();
    if (runtime === null) {
      throw new ArcAccountError(
        "omp-runtime-unavailable",
        "the Arc-managed OMP runtime is not prepared",
      );
    }
    return runtime;
  }

  private requireSpawn(): OmpSpawn {
    if (this.spawn === undefined) {
      throw new ArcAccountError(
        "account-source-unavailable",
        "no OMP process runner is configured",
      );
    }
    return this.spawn;
  }

  private async tick(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
