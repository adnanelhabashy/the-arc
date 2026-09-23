import { rollbackArcRuntimeVersion } from "../arc-runtime/activation.js";
import { prepareArcManagedRuntimes } from "../arc-runtime/bootstrap.js";
import { checkArcRuntimeComponents } from "../arc-runtime/components.js";
import {
  defaultVerifyCodeSignature,
  prepareManagedClaudeCode,
  type PrepareManagedClaudeCodeArgs,
} from "../arc-runtime/claude-setup.js";
import {
  ARC_RUNTIME_COMPATIBILITY_POLICY,
  evaluateArcRuntimeCompatibility,
} from "../arc-runtime/compatibility.js";
import {
  readArcRuntimeManifest,
  type ArcRuntimeManifest,
  type ArcRuntimeManifestReadResult,
} from "../arc-runtime/manifest.js";
import type { ArcRuntimePaths } from "../arc-runtime/paths.js";
import {
  ARC_CLAUDE_CODE_RELEASE,
  ARC_CODEX_RELEASE,
  ARC_OMP_RELEASE,
  ARC_RUNTIME_RELEASES,
  type ArcRuntimeRelease,
} from "../arc-runtime/releases.js";
import type { ArcRuntimeId } from "../arc-runtime/types.js";
import {
  discoverArcRuntimeUpdate,
  type FetchLatestArcRuntimeRelease,
  type ArcRuntimeUpdateDiscovery,
} from "../arc-runtime/update-discovery.js";
import {
  updateArcRuntime,
  type ArcRuntimeUpdateOutcome,
} from "../arc-runtime/update.js";
import {
  ARC_AGENT_CATALOG,
  getArcAgentDescriptor,
} from "./catalog.js";
import { isExecutableFile } from "../arc-runtime/claude-discovery.js";
import {
  ArcAgentError,
  type ArcAgentAccountState,
  type ArcAgentAction,
  type ArcAgentId,
  type ArcAgentOverallState,
  type ArcAgentProviderState,
  type ArcAgentRuntimeState,
  type ArcAgentRuntimeStatus,
  type ArcAgentStatus,
} from "./types.js";

// Update discovery is a deliberate, user-initiated check against public
// release endpoints. The answer changes when the vendor publishes, not while
// a user clicks, so a bounded reuse window removes repeated identical calls
// (and GitHub's unauthenticated rate limit) without hiding a real release for
// long; an update or rollback invalidates it immediately.
const UPDATE_DISCOVERY_TTL_MS = 10 * 60 * 1_000;

// Provider health is not yet queryable from the desktop layer without
// coupling to BB internals, so the default source reports "unknown" rather
// than fabricating readiness. A real implementation (server RPC, host
// maintenance API) can be injected later without touching the manager.
export interface ArcProviderStatusSource {
  getProviderStatus(providerId: string): Promise<ArcAgentProviderState>;
}

export class UnknownArcProviderStatusSource implements ArcProviderStatusSource {
  async getProviderStatus(): Promise<ArcAgentProviderState> {
    return "unknown";
  }
}

// Account readiness per agent. Phase 7 injects a source backed by the Arc
// account service (Account Pool for Codex/Claude accounts); the default
// reports "unknown", which keeps overall state conservative.
export interface ArcAgentAccountStatusSource {
  getAccountState(agentId: ArcAgentId): Promise<ArcAgentAccountState>;
}

export class UnknownArcAccountStatusSource
  implements ArcAgentAccountStatusSource
{
  async getAccountState(): Promise<ArcAgentAccountState> {
    return "unknown";
  }
}

export interface ArcAgentManagerArgs {
  createdByArcVersion: string;
  platform: string;
  runtimePaths: ArcRuntimePaths;
  seedRoot?: string;
  providerStatusSource?: ArcProviderStatusSource;
  accountStatusSource?: ArcAgentAccountStatusSource;
  onDiagnostic?: (message: string) => void;
  now?: () => number;
  // Test seams forwarded to the lower-level runtime services.
  releases?: Partial<Record<ArcRuntimeId, ArcRuntimeRelease>>;
  download?: PrepareManagedClaudeCodeArgs["download"];
  runDoctor?: PrepareManagedClaudeCodeArgs["runDoctor"];
  verifyCodeSignature?: PrepareManagedClaudeCodeArgs["verifyCodeSignature"];
  fetchLatestRelease?: FetchLatestArcRuntimeRelease;
}

export class ArcAgentManager {
  private readonly createdByArcVersion: string;
  private readonly platform: string;
  private readonly runtimePaths: ArcRuntimePaths;
  private readonly seedRoot: string | undefined;
  private readonly providerStatusSource: ArcProviderStatusSource;
  private readonly accountStatusSource: ArcAgentAccountStatusSource;
  private readonly onDiagnostic: ((message: string) => void) | undefined;
  private readonly now: () => number;
  private readonly releases:
    | Partial<Record<ArcRuntimeId, ArcRuntimeRelease>>
    | undefined;
  private readonly download: PrepareManagedClaudeCodeArgs["download"];
  private readonly runDoctor: PrepareManagedClaudeCodeArgs["runDoctor"];
  private readonly verifyCodeSignature: PrepareManagedClaudeCodeArgs["verifyCodeSignature"];
  private readonly fetchLatestRelease: FetchLatestArcRuntimeRelease | undefined;
  private readonly inFlight = new Map<ArcAgentId, Promise<void>>();
  // Update discovery is the one read-shaped path that spends real external
  // requests (api.github.com / downloads.claude.ai). A release does not change
  // minute to minute, so a discovery is reused for a bounded window and
  // invalidated by the update/rollback that changes the answer. Concurrent
  // checks for the same runtime share one call.
  private readonly updateDiscoveries = new Map<
    ArcRuntimeId,
    { at: number; value: ArcRuntimeUpdateDiscovery }
  >();
  private readonly updateDiscoveryInFlight = new Map<
    ArcRuntimeId,
    Promise<ArcRuntimeUpdateDiscovery>
  >();

  constructor(args: ArcAgentManagerArgs) {
    this.createdByArcVersion = args.createdByArcVersion;
    this.platform = args.platform;
    this.runtimePaths = args.runtimePaths;
    this.seedRoot = args.seedRoot;
    this.providerStatusSource =
      args.providerStatusSource ?? new UnknownArcProviderStatusSource();
    this.accountStatusSource =
      args.accountStatusSource ?? new UnknownArcAccountStatusSource();
    this.onDiagnostic = args.onDiagnostic;
    this.now = args.now ?? Date.now;
    this.releases = args.releases;
    this.download = args.download;
    this.runDoctor = args.runDoctor;
    this.verifyCodeSignature = args.verifyCodeSignature;
    this.fetchLatestRelease = args.fetchLatestRelease;
  }

  // Side-effect-free: never downloads, repairs, or writes. Status reads may
  // race with an in-flight operation; the atomic manifest write means they
  // observe the manifest before or after, never a torn state.
  async listArcAgents(): Promise<ArcAgentStatus[]> {
    // One manifest read backs every row. The file is the single source of
    // truth for all three runtimes, so reading it per agent was three
    // identical disk reads for one answer.
    const manifestResult = await this.readManifest();
    return Promise.all(
      ARC_AGENT_CATALOG.map((descriptor) =>
        this.getArcAgent(descriptor.id, manifestResult),
      ),
    );
  }

  async getArcAgent(
    id: ArcAgentId,
    manifestResult?: ArcRuntimeManifestReadResult,
  ): Promise<ArcAgentStatus> {
    const descriptor = getArcAgentDescriptor(id);
    if (descriptor === undefined) {
      throw new ArcAgentError("unsupported-agent", `unknown Arc agent "${id}"`);
    }

    const preparing = this.inFlight.has(id);
    const runtime = await this.resolveRuntimeStatus(
      descriptor.runtimeId,
      preparing,
      manifestResult,
    );
    const providerState = await this.providerStatusSource.getProviderStatus(
      descriptor.providerId,
    );
    const accountState = await this.accountStatusSource.getAccountState(
      descriptor.id,
    );
    const overallState = resolveOverallState(
      runtime.state,
      accountState,
    );

    return {
      id: descriptor.id,
      displayName: descriptor.displayName,
      runtimeId: descriptor.runtimeId,
      providerId: descriptor.providerId,
      runtime,
      provider: { state: providerState },
      account: { state: accountState },
      overallState,
      actions: resolveActions(descriptor.id, runtime, accountState),
      observedAt: this.now(),
    };
  }

  // Restores an Arc-managed runtime for the agent. Idempotent: a healthy
  // runtime is reused, never re-downloaded or reinstalled. Resolves with the
  // refreshed status observed after the operation completes.
  async prepareAgent(id: ArcAgentId): Promise<ArcAgentStatus> {
    await this.runExclusive(id, async () => {
      if (id === "claude-code") {
        const result = await prepareManagedClaudeCode({
          createdByArcVersion: this.createdByArcVersion,
          download: this.download,
          onDiagnostic: this.onDiagnostic,
          platform: this.platform,
          release: this.releases?.["claude-code"] ?? ARC_CLAUDE_CODE_RELEASE,
          runDoctor: this.runDoctor,
          runtimePaths: this.runtimePaths,
          verifyCodeSignature: this.verifyCodeSignature,
        });
        if (result.state !== "ready") {
          throw new ArcAgentError("runtime-prepare-failed", result.detail);
        }
      } else {
        await this.prepareBundledManagedRuntime(
          id,
          "runtime-prepare-failed",
        );
      }
    });
    return this.getArcAgent(id);
  }

  // Repairs the currently intended managed runtime in place: same-version
  // restoration from the trusted seed (Codex/OMP) or the official setup flow
  // (Claude). Repair never changes the active version and never touches
  // credentials or account data.
  async repairAgent(id: ArcAgentId): Promise<ArcAgentStatus> {
    const current = await this.getArcAgent(id);
    if (current.runtime.state === "not-prepared") {
      throw new ArcAgentError(
        "runtime-repair-failed",
        `${id} has no managed runtime recorded; use prepare instead`,
      );
    }
    await this.runExclusive(id, async () => {
      if (id === "claude-code") {
        const result = await prepareManagedClaudeCode({
          createdByArcVersion: this.createdByArcVersion,
          download: this.download,
          onDiagnostic: this.onDiagnostic,
          platform: this.platform,
          release: this.releases?.["claude-code"] ?? ARC_CLAUDE_CODE_RELEASE,
          runDoctor: this.runDoctor,
          runtimePaths: this.runtimePaths,
          verifyCodeSignature: this.verifyCodeSignature,
        });
        if (result.state !== "ready") {
          throw new ArcAgentError("runtime-repair-failed", result.detail);
        }
      } else {
        await this.prepareBundledManagedRuntime(id, "runtime-repair-failed");
      }
    });
    return this.getArcAgent(id);
  }

  // Side-effect-free (plan 2.4): never downloads, stages, or writes.
  async checkForUpdate(id: ArcAgentId): Promise<ArcRuntimeUpdateDiscovery> {
    const descriptor = getArcAgentDescriptor(id);
    if (descriptor === undefined) {
      throw new ArcAgentError("unsupported-agent", `unknown Arc agent "${id}"`);
    }
    // A status read must not race the operation that is changing the runtime:
    // wait for it, then discover against the manifest it left behind. This
    // also stops a click during an update from spending a second request.
    const running = this.inFlight.get(id);
    if (running !== undefined) await running.catch(() => undefined);

    const cached = this.updateDiscoveries.get(descriptor.runtimeId);
    if (cached !== undefined && this.now() - cached.at < UPDATE_DISCOVERY_TTL_MS) {
      return cached.value;
    }
    const inFlight = this.updateDiscoveryInFlight.get(descriptor.runtimeId);
    if (inFlight !== undefined) return inFlight;

    const pending = this.discoverUpdate(descriptor.runtimeId)
      .then((value) => {
        this.updateDiscoveries.set(descriptor.runtimeId, {
          at: this.now(),
          value,
        });
        return value;
      })
      .finally(() => {
        if (this.updateDiscoveryInFlight.get(descriptor.runtimeId) === pending) {
          this.updateDiscoveryInFlight.delete(descriptor.runtimeId);
        }
      });
    this.updateDiscoveryInFlight.set(descriptor.runtimeId, pending);
    return pending;
  }

  private async discoverUpdate(
    runtimeId: ArcRuntimeId,
  ): Promise<ArcRuntimeUpdateDiscovery> {
    const manifestResult = await this.readManifest();
    const manifest =
      manifestResult.kind === "unsupported-version"
        ? null
        : manifestResult.manifest;
    if (manifest === null) {
      throw new ArcAgentError(
        "runtime-update-failed",
        `manifest declares unsupported schema version; cannot check for updates`,
      );
    }
    return discoverArcRuntimeUpdate({
      runtimeId,
      manifest,
      runtimePaths: this.runtimePaths,
      fetchLatestRelease: this.fetchLatestRelease,
    });
  }

  private readManifest(): Promise<ArcRuntimeManifestReadResult> {
    return readArcRuntimeManifest({
      createdByArcVersion: this.createdByArcVersion,
      manifestPath: this.runtimePaths.manifestPath,
      platform: this.platform,
    });
  }

  // The full discover→stage→verify→activate→observe→promote-or-rollback
  // lifecycle (plan 2.30), run under the same per-agent exclusive lock as
  // prepare/repair so it can never race a concurrent operation on the same
  // runtime. Never throws for an expected outcome (up to date, no trusted
  // update, staging/health failure, automatic rollback) — those are real,
  // typed results the caller inspects, not exceptions.
  async updateAgent(
    id: ArcAgentId,
  ): Promise<{ outcome: ArcRuntimeUpdateOutcome; agent: ArcAgentStatus }> {
    const descriptor = getArcAgentDescriptor(id);
    if (descriptor === undefined) {
      throw new ArcAgentError("unsupported-agent", `unknown Arc agent "${id}"`);
    }
    let outcome: ArcRuntimeUpdateOutcome | null = null;
    await this.runExclusive(id, async () => {
      const manifestResult = await readArcRuntimeManifest({
        createdByArcVersion: this.createdByArcVersion,
        manifestPath: this.runtimePaths.manifestPath,
        platform: this.platform,
      });
      if (manifestResult.kind === "unsupported-version") {
        outcome = {
          kind: "no-trusted-update",
          reason: "manifest declares unsupported schema version",
        };
        return;
      }
      outcome = await updateArcRuntime({
        runtimeId: descriptor.runtimeId,
        manifest: manifestResult.manifest,
        createdByArcVersion: this.createdByArcVersion,
        platform: this.platform,
        runtimePaths: this.runtimePaths,
        fetchLatestRelease: this.fetchLatestRelease,
        download: this.download,
        now: this.now,
        verifyExecutable:
          id === "claude-code" ? defaultVerifyCodeSignature : undefined,
      });
    });
    // The runtime just changed: the cached "latest release" answer for it is
    // no longer the answer.
    this.updateDiscoveries.delete(descriptor.runtimeId);
    const agent = await this.getArcAgent(id);
    return {
      outcome: outcome ?? {
        kind: "no-trusted-update",
        reason: "update produced no result",
      },
      agent,
    };
  }

  // Reactivates the recorded knownGoodVersion without redownloading (plan
  // 2.14). A missing rollback target or a deleted known-good binary is a
  // distinct, reported outcome — never a silent no-op and never a fresh
  // install of anything.
  async rollbackAgent(
    id: ArcAgentId,
  ): Promise<{
    outcome: Awaited<ReturnType<typeof rollbackArcRuntimeVersion>>;
    agent: ArcAgentStatus;
  }> {
    const descriptor = getArcAgentDescriptor(id);
    if (descriptor === undefined) {
      throw new ArcAgentError("unsupported-agent", `unknown Arc agent "${id}"`);
    }
    let outcome: Awaited<ReturnType<typeof rollbackArcRuntimeVersion>> | null =
      null;
    await this.runExclusive(id, async () => {
      outcome = await rollbackArcRuntimeVersion({
        runtimeId: descriptor.runtimeId,
        createdByArcVersion: this.createdByArcVersion,
        platform: this.platform,
        runtimePaths: this.runtimePaths,
        now: this.now,
      });
    });
    this.updateDiscoveries.delete(descriptor.runtimeId);
    const agent = await this.getArcAgent(id);
    return {
      outcome: outcome ?? {
        kind: "failed",
        reason: "rollback produced no result",
      },
      agent,
    };
  }

  // Single-flight per agent: a duplicate prepare/repair for the same agent
  // joins the in-flight operation instead of racing it (two Claude setup
  // clicks must not start two downloads). Operations for different agents
  // run concurrently; the serialized manifest mutation is their only shared
  // critical section.
  private async runExclusive(
    id: ArcAgentId,
    operation: () => Promise<void>,
  ): Promise<void> {
    const existing = this.inFlight.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const pending = operation()
      .then(() => undefined)
      .finally(() => {
        if (this.inFlight.get(id) === pending) {
          this.inFlight.delete(id);
        }
      });
    this.inFlight.set(id, pending);
    return pending;
  }

  private async prepareBundledManagedRuntime(
    id: ArcAgentId & ("codex" | "omp"),
    errorCode: "runtime-prepare-failed" | "runtime-repair-failed",
  ): Promise<void> {
    if (this.seedRoot === undefined) {
      throw new ArcAgentError(
        errorCode,
        `${id} uses a bundled-managed runtime but no seed root is configured`,
      );
    }
    const pinned = this.releases?.[id] ??
      (id === "codex" ? ARC_CODEX_RELEASE : ARC_OMP_RELEASE);
    const results = await prepareArcManagedRuntimes({
      createdByArcVersion: this.createdByArcVersion,
      onDiagnostic: this.onDiagnostic,
      platform: this.platform,
      releases: [pinned],
      runtimePaths: this.runtimePaths,
      seedRoot: this.seedRoot,
    });
    const result = results[0];
    if (
      result === undefined ||
      (result.action !== "installed" &&
        result.action !== "already-active" &&
        result.action !== "repaired" &&
        result.action !== "kept-existing")
    ) {
      throw new ArcAgentError(
        errorCode,
        result?.detail ?? "bundled runtime bootstrap produced no result",
      );
    }
  }

  private async resolveRuntimeStatus(
    runtimeId: ArcRuntimeId,
    preparing: boolean,
    manifestResult?: ArcRuntimeManifestReadResult,
  ): Promise<ArcAgentRuntimeStatus> {
    manifestResult ??= await this.readManifest();

    if (manifestResult.kind === "unsupported-version") {
      return {
        state: "unavailable",
        version: null,
        compatibility: null,
        compatibilityReason: `manifest declares unsupported schema version ${manifestResult.schemaVersion}`,
        source: null,
        knownGoodVersion: null,
      };
    }
    if (manifestResult.kind === "invalid") {
      return {
        state: "unavailable",
        version: null,
        compatibility: null,
        compatibilityReason: manifestResult.problem,
        source: null,
        knownGoodVersion: null,
      };
    }

    const entry = manifestResult.manifest.runtimes[runtimeId];
    if (entry.activeVersion === null) {
      return {
        state: preparing ? "preparing" : "not-prepared",
        version: null,
        compatibility: null,
        compatibilityReason: null,
        source: null,
        knownGoodVersion: entry.knownGoodVersion,
      };
    }

    const version = entry.activeVersion;
    const evaluation = evaluateArcRuntimeCompatibility({
      policy: ARC_RUNTIME_COMPATIBILITY_POLICY,
      runtimeId,
      version,
    });
    const runnable = await isExecutableFile(
      this.runtimePaths.executablePath(runtimeId, version),
    );
    // A version is only usable if its required helpers are there too: Codex
    // without its code-mode host starts fine and then cannot do Code Mode, so
    // "the binary runs" is not the question the Agents view is answering.
    const brokenComponent = runnable
      ? await this.findBrokenComponent(runtimeId, version, entry)
      : null;

    let state: ArcAgentRuntimeState;
    if (!runnable || brokenComponent !== null) {
      state = "broken";
    } else if (evaluation.compatibility === "blocked") {
      state = "unsupported";
    } else if (evaluation.compatibility === "untested") {
      state = "ready-with-warning";
    } else {
      state = "ready";
    }
    if (preparing) {
      state = "preparing";
    }

    return {
      state,
      version,
      compatibility: evaluation.compatibility,
      compatibilityReason: brokenComponent ?? evaluation.reason,
      source: entry.source,
      knownGoodVersion: entry.knownGoodVersion,
    };
  }

  private async findBrokenComponent(
    runtimeId: ArcRuntimeId,
    version: string,
    entry: ArcRuntimeManifest["runtimes"][ArcRuntimeId],
  ): Promise<string | null> {
    const release =
      this.releases?.[runtimeId] ??
      ARC_RUNTIME_RELEASES.find(
        (candidate) => candidate.runtimeId === runtimeId,
      );
    const companions = release?.companions ?? [];
    if (companions.length === 0) return null;
    const recorded = entry.componentsByVersion[version] ?? {};
    const checks = await checkArcRuntimeComponents({
      expectations: companions.map((companion) => ({
        fileName: companion.fileName,
        expectedDigest:
          recorded[companion.fileName] ?? companion.executableSha256,
      })),
      componentPath: (fileName) =>
        this.runtimePaths.componentPath(runtimeId, version, fileName),
      isWindows: this.platform.startsWith("win32"),
      verifyDigest: false,
    });
    return checks.find((check) => !check.ok)?.detail ?? null;
  }
}

function resolveOverallState(
  runtimeState: ArcAgentRuntimeState,
  accountState: ArcAgentAccountState,
): ArcAgentOverallState {
  switch (runtimeState) {
    case "unavailable":
      return "unavailable";
    case "broken":
      return "broken";
    case "unsupported":
      return "unsupported";
    case "not-prepared":
      return "not-prepared";
    case "preparing":
      return "preparing";
    case "ready":
    case "ready-with-warning":
      // A runtime can execute; whether a real coding turn can run depends on
      // the account. Account "connected" is the only honest "ready"; a
      // definitively missing account is "account-required"; anything else
      // (unknown source, expired/error credentials) stays conservative.
      if (accountState === "connected") return "ready";
      if (accountState === "not-connected") return "account-required";
      return "runtime-ready";
  }
}

function resolveActions(
  agentId: ArcAgentId,
  runtime: ArcAgentRuntimeStatus,
  accountState: ArcAgentAccountState,
): ArcAgentAction[] {
  const runtimeState = runtime.state;
  const prepareAvailable = runtimeState === "not-prepared";
  const repairAvailable = runtimeState === "broken";
  const runtimeReady =
    runtimeState === "ready" || runtimeState === "ready-with-warning";
  const updateAvailable =
    runtimeState === "ready" ||
    runtimeState === "ready-with-warning" ||
    runtimeState === "unsupported" ||
    runtimeState === "broken";
  const rollbackAvailable =
    runtime.knownGoodVersion !== null &&
    runtime.knownGoodVersion !== runtime.version;
  // All three Arc agents have account backends after Phase 8 (pool for
  // Codex/Claude Code, OMP's own providers for OMP).
  const supportsAccount = true;
  const accountActionable =
    accountState === "not-connected" ||
    accountState === "expired" ||
    accountState === "error";
  const connectAvailable = supportsAccount && runtimeReady && accountActionable;
  return [
    {
      id: "prepare",
      available: prepareAvailable,
      ...(prepareAvailable
        ? {}
        : {
            reason:
              runtimeState === "broken"
                ? "runtime is prepared but broken; use repair"
                : "runtime is already prepared",
          }),
    },
    {
      id: "repair",
      available: repairAvailable,
      ...(repairAvailable
        ? {}
        : {
            reason:
              runtimeState === "not-prepared"
                ? "nothing recorded to repair; use prepare"
                : runtimeState === "unsupported"
                  ? "compatibility is blocked; repair cannot change the version"
                  : "runtime is not broken",
          }),
    },
    {
      id: "connect-account",
      available: connectAvailable,
      ...(connectAvailable
        ? {}
        : {
            reason: !supportsAccount
              ? "agent does not support account connection yet"
              : !runtimeReady
                ? "runtime is not ready"
                : accountState === "connected"
                  ? "an account is already connected"
                  : "account state is unknown",
          }),
    },
    {
      id: "update",
      available: updateAvailable,
      ...(updateAvailable
        ? {}
        : {
            reason:
              runtimeState === "not-prepared"
                ? "nothing prepared yet; use prepare first"
                : "runtime is mid-operation",
          }),
    },
    {
      id: "rollback",
      available: rollbackAvailable,
      ...(rollbackAvailable
        ? {}
        : {
            reason:
              runtime.knownGoodVersion === null
                ? "no known-good version has been recorded yet"
                : "the active version is already the known-good version",
          }),
    },
    {
      id: "open-settings",
      available: false,
      reason: "No agent settings surface exists yet",
    },
  ];
}
