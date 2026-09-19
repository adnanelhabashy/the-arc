import type { ArcAgentId } from "../arc-agent/types.js";
import type { ArcAgentAccountState } from "../arc-agent/types.js";
import {
  ArcAccountError,
  type ArcAccount,
  type ArcAccountLoginChallenge,
  type ArcAccountLoginProvider,
  type ArcAccountLoginState,
  type ArcAccountProviderFamily,
  type ArcAccountSource,
  type ArcAccountSourceStatus,
  type ArcOmpLoginChallenge,
  type ArcOmpLoginPoll,
  type ArcOmpProvider,
} from "./types.js";

interface LoginSession {
  challenge: ArcAccountLoginChallenge | ArcOmpLoginChallenge;
  state: ArcAccountLoginState;
  expiresAt: number;
}

// The pool expires unfinished login sessions after 10 minutes
// (LOGIN_SESSION_TTL_MS); Arc mirrors that bound locally so a forgotten
// pending session cannot pin the single-flight slot forever.
const PENDING_LOGIN_TTL_MS = 10 * 60 * 1_000;

export interface ArcAccountServiceArgs {
  sources: ArcAccountSource[];
  now?: () => number;
  onDiagnostic?: (message: string) => void;
}

// Source kinds that back each agent's account readiness.
const AGENT_ACCOUNT_SOURCES: Record<ArcAgentId, ArcAccountSource["kind"][]> = {
  codex: ["pool"],
  "claude-code": ["pool"],
  omp: ["omp"],
};

// Arc's account backend ("AI Accounts"). Aggregates ArcAccountSource
// implementations (Account Pool for Codex/Claude accounts, OMP for OMP
// providers) and tracks pending login operations per provider so duplicate
// Connect clicks join instead of launching parallel provider login flows.
// Inventory reads never start logins, refresh tokens, or mutate routing; a
// failing source degrades its own accounts to "unavailable" without taking
// down the other sources' accounts.
export class ArcAccountService {
  private readonly sources: ArcAccountSource[];
  private readonly now: () => number;
  private readonly onDiagnostic: ((message: string) => void) | undefined;
  private readonly pendingSessions = new Map<
    ArcAccountLoginProvider,
    LoginSession
  >();
  private readonly pendingStarts = new Map<
    ArcAccountLoginProvider,
    Promise<LoginSession>
  >();

  constructor(args: ArcAccountServiceArgs) {
    this.sources = args.sources;
    this.now = args.now ?? Date.now;
    this.onDiagnostic = args.onDiagnostic;
  }

  // Side-effect-free inventory read across sources with per-source failure
  // isolation: one source failing never destroys another source's accounts.
  // No dedup across sources (Phase 9 owns that, keyed on canonical
  // accountKey only).
  async listArcAccounts(): Promise<ArcAccount[]> {
    return (await this.listArcAccountsDetailed()).accounts;
  }

  // Same read plus per-source health. An "unavailable" source means its
  // accounts could not be queried — UNKNOWN != EMPTY.
  async listArcAccountsDetailed(): Promise<{
    accounts: ArcAccount[];
    sources: ArcAccountSourceStatus[];
  }> {
    const results = await Promise.all(
      this.sources.map(
        async (
          source,
        ): Promise<
          | { ok: true; source: ArcAccountSource; accounts: ArcAccount[] }
          | { ok: false; source: ArcAccountSource; error: unknown }
        > => {
          try {
            return { ok: true, source, accounts: await source.listAccounts() };
          } catch (error) {
            return { ok: false, source, error };
          }
        },
      ),
    );
    const accounts: ArcAccount[] = [];
    const statuses: ArcAccountSourceStatus[] = [];
    let failures = 0;
    for (const result of results) {
      const checkedAt = this.now();
      if (result.ok) {
        accounts.push(...result.accounts);
        statuses.push({
          kind: result.source.kind,
          state: "ready",
          detail: null,
          checkedAt,
        });
        continue;
      }
      failures += 1;
      const message =
        result.error instanceof Error
          ? result.error.message
          : String(result.error);
      this.onDiagnostic?.(
        `account source ${result.source.kind} failed: ${message}`,
      );
      statuses.push({
        kind: result.source.kind,
        state: "unavailable",
        detail: message,
        checkedAt,
      });
    }
    if (this.sources.length > 0 && failures === this.sources.length) {
      throw new ArcAccountError(
        "account-source-unavailable",
        `every account source failed: ${statuses
          .map((status) => `${status.kind}: ${status.detail}`)
          .join("; ")}`,
      );
    }
    return { accounts, sources: statuses };
  }

  async getArcAccount(id: string): Promise<ArcAccount> {
    for (const source of this.sources) {
      const prefix = `${source.kind}:`;
      if (!id.startsWith(prefix)) continue;
      return source.getAccount(id.slice(prefix.length));
    }
    throw new ArcAccountError("account-not-found", id);
  }

  async setAccountEnabled(id: string, enabled: boolean): Promise<ArcAccount> {
    return this.forSource(id, (source, sourceId) =>
      source.setAccountEnabled(sourceId, enabled),
    );
  }

  async removeAccount(id: string): Promise<void> {
    return this.forSource(id, (source, sourceId) =>
      source.removeAccount(sourceId),
    );
  }

  async setAccountPriority(id: string, priority: number): Promise<ArcAccount> {
    return this.forSource(id, (source, sourceId) =>
      source.setAccountPriority(sourceId, priority),
    );
  }

  // Explicit priority order for one provider family. Only sources that
  // implement reorder semantics participate (the pool does; OMP does not).
  async reorderAccounts(
    providerFamily: ArcAccountProviderFamily,
    orderedSourceIds: string[],
  ): Promise<void> {
    const reorderable = this.sources.find(
      (source): source is ArcAccountSource & {
        reorderAccounts: (
          family: ArcAccountProviderFamily,
          orderedIds: string[],
        ) => Promise<void>;
      } => typeof source.reorderAccounts === "function",
    );
    if (reorderable === undefined) {
      throw new ArcAccountError(
        "unsupported-provider",
        `no account source supports reordering for ${providerFamily}`,
      );
    }
    return reorderable.reorderAccounts(providerFamily, orderedSourceIds);
  }

  // Per-agent account readiness based on the sources that actually back the
  // agent. A relevant source that failed to read maps to "unknown" (never
  // "not-connected"); zero accounts on a healthy relevant source is honestly
  // "not-connected". One enabled, connected account suffices for readiness;
  // Arc never picks or rotates accounts on its own.
  async accountStateForAgent(
    agentId: ArcAgentId,
  ): Promise<ArcAgentAccountState> {
    const { accounts, sources } = await this.listArcAccountsDetailed();
    const relevant = AGENT_ACCOUNT_SOURCES[agentId];
    const relevantSources = sources.filter((status) =>
      relevant.includes(status.kind),
    );
    if (relevantSources.length === 0) return "unknown";
    if (relevantSources.some((status) => status.state !== "ready")) {
      return "unknown";
    }
    return accounts.some(
      (account) =>
        account.availableThrough.includes(agentId) &&
        account.enabled &&
        account.authState === "connected",
    )
      ? "connected"
      : "not-connected";
  }

  async hasConnectedAccount(agentId: ArcAgentId): Promise<boolean> {
    return (await this.accountStateForAgent(agentId)) === "connected";
  }

  getLoginState(provider: ArcAccountLoginProvider): ArcAccountLoginState {
    const session = this.pendingSessions.get(provider);
    if (session === undefined) return "idle";
    return session.state;
  }

  // Starts (or joins) the official OpenAI device login flow. Five clicks on
  // Connect ChatGPT produce one provider login attempt. The returned
  // challenge carries only presentation data (verification URL, user code) —
  // never tokens.
  startOpenAiLogin(): Promise<ArcAccountLoginChallenge> {
    return this.startExclusive("openai", async () => {
      const challenge = await this.poolSource().startOpenAiLogin();
      return {
        challenge,
        state: "waiting-for-user",
        expiresAt: challenge.expiresAt,
      };
    }).then((session) => session.challenge as ArcAccountLoginChallenge);
  }

  async pollOpenAiLogin(sessionId: string) {
    const source = this.poolSource();
    const poll = await source.pollOpenAiLogin(sessionId);
    if (poll.state !== "waiting-for-user") {
      this.pendingSessions.delete("openai");
    }
    return poll;
  }

  async cancelOpenAiLogin(sessionId: string): Promise<void> {
    const source = this.poolSource();
    try {
      await source.cancelOpenAiLogin(sessionId);
    } finally {
      this.pendingSessions.delete("openai");
    }
  }

  // Starts (or joins) the official Anthropic OAuth/PKCE flow. Arc opens the
  // authorizeUrl in the user's browser; authentication happens on
  // Anthropic's surface and the paste callback completes the session. Arc
  // never collects provider passwords.
  startClaudeLogin(): Promise<ArcAccountLoginChallenge> {
    return this.startExclusive("anthropic", async () => {
      const challenge = await this.poolSource().startClaudeLogin();
      return {
        challenge,
        state: "waiting-for-user",
        // The pool does not expose its Claude session TTL; use the same
        // documented 10-minute bound as the pool's login sessions.
        expiresAt: this.now() + PENDING_LOGIN_TTL_MS,
      };
    }).then((session) => session.challenge as ArcAccountLoginChallenge);
  }

  async completeClaudeLogin(sessionId: string, pasted: string) {
    const source = this.poolSource();
    try {
      return await source.completeClaudeLogin(sessionId, pasted);
    } finally {
      this.pendingSessions.delete("anthropic");
    }
  }

  // ── OMP provider login (Phase 8) ─────────────────────────────────────

  async listOmpProviders(): Promise<ArcOmpProvider[]> {
    return this.ompSource().listOmpProviders();
  }

  // Starts (or joins) OMP's official login for one provider
  // (`omp auth-broker login <provider>`). OAuth providers return an
  // authorizeUrl for the browser; API-key providers await a key via
  // submitOmpProviderLoginKey. Duplicate starts for the same provider join
  // the in-flight attempt.
  startOmpProviderLogin(provider: string): Promise<ArcOmpLoginChallenge> {
    return this.startExclusive(`omp:${provider}`, async () => {
      const challenge = await this.ompSource().startOmpLogin(provider);
      return {
        challenge,
        state: "waiting-for-user",
        // OMP does not expose its login session TTL; mirror the pool's
        // documented 10-minute bound.
        expiresAt: this.now() + PENDING_LOGIN_TTL_MS,
      };
    }).then((session) => session.challenge as ArcOmpLoginChallenge);
  }

  async pollOmpProviderLogin(sessionId: string): Promise<ArcOmpLoginPoll> {
    const poll = await this.ompSource().pollOmpLogin(sessionId);
    if (poll.state !== "waiting-for-user") {
      for (const [key, session] of this.pendingSessions) {
        if (
          key.startsWith("omp:") &&
          session.challenge.sessionId === sessionId
        ) {
          this.pendingSessions.delete(key);
        }
      }
    }
    return poll;
  }

  async cancelOmpProviderLogin(sessionId: string): Promise<void> {
    for (const [key, session] of this.pendingSessions) {
      if (
        key.startsWith("omp:") &&
        session.challenge.sessionId === sessionId
      ) {
        this.pendingSessions.delete(key);
      }
    }
    await this.ompSource().cancelOmpLogin(sessionId);
  }

  // Submits an API key for an OMP api-key-style login session. The key goes
  // only to the OMP child's stdin; it is never stored in Arc state.
  submitOmpProviderLoginKey(sessionId: string, key: string): void {
    this.ompSource().submitOmpLoginKey(sessionId, key);
  }

  private poolSource(): ArcAccountSource {
    const source = this.sources.find((entry) => entry.kind === "pool");
    if (source === undefined) {
      throw new ArcAccountError(
        "account-source-unavailable",
        "no account pool source is configured",
      );
    }
    return source;
  }

  private ompSource(): OmpAccountSourceLike {
    const source = this.sources.find((entry) => entry.kind === "omp");
    if (source === undefined) {
      throw new ArcAccountError(
        "account-source-unavailable",
        "no OMP account source is configured",
      );
    }
    return source as OmpAccountSourceLike;
  }

  private async forSource<T>(
    id: string,
    run: (source: ArcAccountSource, sourceId: string) => Promise<T>,
  ): Promise<T> {
    for (const source of this.sources) {
      const prefix = `${source.kind}:`;
      if (!id.startsWith(prefix)) continue;
      return run(source, id.slice(prefix.length));
    }
    throw new ArcAccountError("account-not-found", id);
  }

  private startExclusive(
    provider: ArcAccountLoginProvider,
    start: () => Promise<LoginSession>,
  ): Promise<LoginSession> {
    const inFlight = this.pendingStarts.get(provider);
    if (inFlight !== undefined) return inFlight;
    const existing = this.pendingSessions.get(provider);
    if (existing !== undefined && existing.expiresAt > this.now()) {
      return Promise.resolve(existing);
    }
    if (existing !== undefined) this.pendingSessions.delete(provider);
    const operation = (async () => {
      try {
        const session = await start();
        this.pendingSessions.set(provider, session);
        return session;
      } catch (error) {
        this.onDiagnostic?.(
          `account login start failed for ${provider}: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      } finally {
        this.pendingStarts.delete(provider);
      }
    })();
    this.pendingStarts.set(provider, operation);
    return operation;
  }
}

// Structural type for the OMP source so the service does not depend on the
// concrete adapter (tests inject fakes with the same surface).
interface OmpAccountSourceLike extends ArcAccountSource {
  listOmpProviders(): Promise<ArcOmpProvider[]>;
  startOmpLogin(provider: string): Promise<ArcOmpLoginChallenge>;
  pollOmpLogin(sessionId: string): Promise<ArcOmpLoginPoll>;
  cancelOmpLogin(sessionId: string): Promise<void>;
  submitOmpLoginKey(sessionId: string, key: string): void;
}
