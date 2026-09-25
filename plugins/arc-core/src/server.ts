import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  cleanAbandonedArcRuntimeStaging,
  createArcRuntimePaths,
  type ArcRuntimeUpdateDiscovery,
} from "@bb/arc-domains/arc-runtime";
import { reapStaleOmpBroker } from "./broker-ownership.js";
import { arcRpcContract } from "./contract.js";
import type { arcRuntimeUpdateDiscoverySchema } from "./contract.js";
import type { z } from "zod";
import {
  ArcUnavailableError,
  createArcServiceHost,
  resolveArcHostConfig,
  type ArcServiceHost,
} from "./host.js";
import {
  describeArcOmpExecutionPin,
  resolveArcOmpExecutionEnv,
} from "./omp-execution-env.js";
import { ARC_CHANGED_CHANNEL, type ArcChangedKind } from "./realtime.js";
import {
  ARC_VOICE_ANNOUNCE_CHANNEL,
  ARC_VOICE_PLUGIN_ID,
  registerArcVoiceSpeakTool,
} from "./voice-announce.js";

// Only the fields the renderer needs to display are forwarded — never
// runtimeId/artifactKind/expectedExecutableVersion/executableSha256, and
// never anything the renderer could feed back to control a download (the
// wire contract's release summary is strict, so an extra field would fail
// to serialize rather than leak silently).
function toArcRuntimeUpdateDiscoverySummary(
  discovery: ArcRuntimeUpdateDiscovery,
): z.infer<typeof arcRuntimeUpdateDiscoverySchema> {
  return {
    runtimeId: discovery.runtimeId,
    installedVersions: discovery.installedVersions,
    activeVersion: discovery.activeVersion,
    knownGoodVersion: discovery.knownGoodVersion,
    latestTrusted:
      discovery.latestTrusted === null
        ? null
        : {
            version: discovery.latestTrusted.version,
            platform: discovery.latestTrusted.platform,
            releaseTag: discovery.latestTrusted.releaseTag,
            assetName: discovery.latestTrusted.assetName,
            downloadUrl: discovery.latestTrusted.downloadUrl,
            sha256: discovery.latestTrusted.sha256,
            license: discovery.latestTrusted.license,
          },
    latestTrustedCompatibility: discovery.latestTrustedCompatibility,
    latestTrustedCompatibilityReason: discovery.latestTrustedCompatibilityReason,
    updateAvailable: discovery.updateAvailable,
    rollbackAvailable: discovery.rollbackAvailable,
    discoveryError: discovery.discoveryError,
  };
}

// Arc Core: the fixed renderer-facing boundary over the Arc domain services
// (agents, accounts, usage). The renderer can only invoke these fixed,
// zod-validated methods — never arbitrary paths, commands, or URLs.
export default async function plugin(bb: BbPluginApi): Promise<void> {
  const config = resolveArcHostConfig(process.env);
  let host: ArcServiceHost | null = null;

  const instanceId = randomUUID();

  // Arc Voice runs in this plugin's host worker over Arc's own Voicebox
  // runtime. Standalone bb servers register nothing: the service would have no
  // host entry to answer on.
  if (config !== null) {
    bb.experimental_aiServices.register({
      id: "arc-voice",
      displayName: "Arc Voice",
      kinds: ["voice"],
    });
  }

  const requireHost = (): ArcServiceHost => {
    if (config === null) {
      throw new ArcUnavailableError(
        "Arc services are unavailable: this server was not started by the Arc app",
      );
    }
    host ??= createArcServiceHost({
      config,
      serverOrigin: bb.server.loopbackBaseUrl,
      instanceId,
      // A background usage measurement fill (a read that found a stale
      // measurement) becomes a real change signal, so every surface refreshes
      // without polling and without any of them forcing a provider fetch.
      onUsageMeasurementsChanged: () => publish("usage"),
    });
    return host;
  };

  // Arc leaves no OMP broker behind: the previous server's broker is claimed
  // back at startup (only when its recorded pid, argv and start time still
  // match, so an unrelated process is never signalled), and this server's
  // broker plus any interactive login child is stopped on disposal.
  const reapAtStartup = async (): Promise<void> => {
    if (config === null) return;
    const result = await reapStaleOmpBroker({
      instanceId,
      ompStateRoot: path.join(config.runtimeRoot, "omp"),
    });
    if (result.kind === "stopped") {
      bb.log.info(
        `arc-core stopped a leftover OMP broker (pid ${String(result.pid)}).`,
      );
    }
    if (result.kind === "unverified" || result.kind === "still-running") {
      bb.log.warn(
        `arc-core left a recorded OMP broker process alone (pid ${String(result.pid)}, ${result.kind}); it could not be proven to belong to Arc.`,
      );
    }
  };
  void reapAtStartup().catch(() => undefined);

  // A staging directory abandoned by a crash mid-download or
  // mid-verification is never the source of truth for anything active
  // (plan 2.7, 2.22); sweeping it at every startup is always safe.
  const cleanStagingAtStartup = async (): Promise<void> => {
    if (config === null) return;
    const runtimePaths = createArcRuntimePaths({
      userDataPath: config.runtimeRoot,
    });
    const result = await cleanAbandonedArcRuntimeStaging(runtimePaths);
    if (result.removed.length > 0) {
      bb.log.info(
        `arc-core removed ${String(result.removed.length)} abandoned runtime staging director${result.removed.length === 1 ? "y" : "ies"}.`,
      );
    }
    if (result.failed.length > 0) {
      bb.log.warn(
        `arc-core could not remove ${String(result.failed.length)} runtime staging director${result.failed.length === 1 ? "y" : "ies"}.`,
      );
    }
  };
  void cleanStagingAtStartup().catch(() => undefined);

  bb.onDispose(async () => {
    if (host === null) return;
    await host.ompAccounts.dispose().catch(() => undefined);
  });

  // One entry per pinned OMP execution. Auto threads (no accountKey) get
  // nothing, so OMP keeps its own account selection for them; a pinned thread
  // gets Arc's loopback broker plus a credential allowlist naming exactly its
  // account, and an unroutable pin gets an allowlist for none instead of
  // falling through to whichever stored account OMP would pick. The allowlist
  // file lives in Arc's private OMP state root (<userData>/omp), next to the
  // store it narrows, and holds credential identities only — never a secret.
  bb.providers.experimental_contributeEnv("acp-omp", async (context) => {
    if (config === null || context.accountKey === null) return [];
    const host = requireHost();
    try {
      const { entries, pin } = await resolveArcOmpExecutionEnv({
        accountKey: context.accountKey,
        accounts: await host.accounts.listArcAccounts(),
        poolFileDirectory: path.join(config.runtimeRoot, "omp", "account-pool"),
        holdBroker: () => host.ompAccounts.holdBrokerForExecution(),
      });
      const warning = describeArcOmpExecutionPin(pin);
      if (warning !== null) {
        bb.log.warn(
          `arc-core acp-omp pin: thread ${context.threadId} ${warning}`,
        );
      }
      return entries;
    } catch (error) {
      bb.log.warn(
        `arc-core acp-omp pin: thread ${context.threadId} could not be pinned to ${context.accountKey} (${
          error instanceof Error ? error.message : String(error)
        }); OMP falls back to its own account selection`,
      );
      return [];
    }
  });

  // Doubles as the broker hold renewal for pinned executions: a live hold is
  // what keeps the loopback broker up while the provider process it serves is
  // running, and the OMP provider health row is exactly that fact.
  bb.providers.experimental_contributeEnvHealth("acp-omp", () => {
    if (config === null) return null;
    if (!requireHost().ompAccounts.renewBrokerHold()) return null;
    return {
      label: "Pinned",
      statusMessage:
        "Credentials come from Arc's OMP broker, restricted to the accounts Arc resolved per thread.",
    };
  });

  const publish = (kind: ArcChangedKind): void => {
    void Promise.resolve(
      bb.realtime.publish(ARC_CHANGED_CHANNEL, { kind }),
    ).catch(() => {});
  };

  // Which accounts exist, are enabled, and are connected is the identity the
  // usage resources hang off. Arc performed the mutation, so it invalidates
  // the usage cache in the same instant rather than waiting for a TTL to
  // expire: a removed or disabled account must never keep serving its last
  // reading. The account inventory itself needs no invalidation — it is read
  // through to its source and only ever coalesced while a read is in flight.
  const invalidateAccountDependentState = (): void => {
    host?.usage.invalidateUsage();
  };

  registerArcVoiceSpeakTool({
    agents: bb.agents,
    deps: {
      publish: (payload) =>
        Promise.resolve(
          bb.realtime.publish(ARC_VOICE_ANNOUNCE_CHANNEL, payload),
        ),
      readThreadMetadata: (threadId) =>
        bb.sdk.threads.getPluginMetadata({
          threadId,
          pluginId: ARC_VOICE_PLUGIN_ID,
        }),
    },
  });

  bb.rpc.register(arcRpcContract, {
    "arc.status": () => ({
      arcAvailable: config !== null,
      reason:
        config === null
          ? "This server was not started by the Arc app."
          : null,
    }),
    "arc.agents.list": async () => ({
      agents: await requireHost().agents.listArcAgents(),
    }),
    "arc.agents.get": async ({ id }) => ({
      agent: await requireHost().agents.getArcAgent(id),
    }),
    "arc.agents.prepare": async ({ id }) => {
      const agent = await requireHost().agents.prepareAgent(id);
      if (id === "omp") await requireHost().ompAccounts.shutdown();
      publish("agents");
      publish("accounts");
      return { agent };
    },
    "arc.agents.repair": async ({ id }) => {
      const agent = await requireHost().agents.repairAgent(id);
      if (id === "omp") await requireHost().ompAccounts.shutdown();
      publish("agents");
      publish("accounts");
      return { agent };
    },
    "arc.agents.checkForUpdate": async ({ id }) => {
      const discovery = await requireHost().agents.checkForUpdate(id);
      return { discovery: toArcRuntimeUpdateDiscoverySummary(discovery) };
    },
    "arc.agents.update": async ({ id }) => {
      const { outcome, agent } = await requireHost().agents.updateAgent(id);
      if (id === "omp") await requireHost().ompAccounts.shutdown();
      publish("agents");
      publish("accounts");
      return { outcome, agent };
    },
    "arc.agents.rollback": async ({ id }) => {
      const { outcome, agent } = await requireHost().agents.rollbackAgent(id);
      if (id === "omp") await requireHost().ompAccounts.shutdown();
      publish("agents");
      publish("accounts");
      return { outcome, agent };
    },
    "arc.accounts.list": async () => {
      const detailed = await requireHost().accounts.listArcAccountsDetailed();
      return { accounts: detailed.accounts, sources: detailed.sources };
    },
    "arc.accounts.setEnabled": async ({ id, enabled }) => {
      const account = await requireHost().accounts.setAccountEnabled(id, enabled);
      invalidateAccountDependentState();
      publish("accounts");
      publish("usage");
      return { account };
    },
    "arc.accounts.remove": async ({ id }) => {
      await requireHost().accounts.removeAccount(id);
      invalidateAccountDependentState();
      publish("accounts");
      publish("usage");
      return { ok: true as const };
    },
    "arc.accounts.reorder": async ({ family, orderedIds }) => {
      await requireHost().accounts.reorderAccounts(family, orderedIds);
      publish("accounts");
      return { ok: true as const };
    },
    "arc.login.openai.start": async () => ({
      challenge: await requireHost().accounts.startOpenAiLogin(),
    }),
    "arc.login.openai.poll": async ({ sessionId }) => {
      const accounts = requireHost().accounts;
      const poll = await accounts.pollOpenAiLogin(sessionId);
      const state = accounts.getLoginState("openai");
      // A terminal poll means the pool gained (or failed to gain) an account;
      // the pending session is already dropped, so this runs exactly once per
      // finished login.
      if (state === "idle") {
        invalidateAccountDependentState();
        publish("accounts");
        publish("usage");
      }
      return { poll, state };
    },
    "arc.login.openai.cancel": async ({ sessionId }) => {
      await requireHost().accounts.cancelOpenAiLogin(sessionId);
      publish("accounts");
      return { ok: true as const };
    },
    "arc.login.claude.start": async () => ({
      challenge: await requireHost().accounts.startClaudeLogin(),
    }),
    "arc.login.claude.complete": async ({ sessionId, code }) => {
      const account = await requireHost().accounts.completeClaudeLogin(
        sessionId,
        code,
      );
      invalidateAccountDependentState();
      publish("accounts");
      publish("usage");
      return { account };
    },
    "arc.omp.providers": async () => ({
      providers: await requireHost().accounts.listOmpProviders(),
    }),
    "arc.omp.login.start": async ({ provider }) => ({
      challenge: await requireHost().accounts.startOmpProviderLogin(provider),
    }),
    "arc.omp.login.poll": async ({ sessionId }) => {
      const accounts = requireHost().accounts;
      const poll = await accounts.pollOmpProviderLogin(sessionId);
      if (poll.state !== "waiting-for-user") {
        invalidateAccountDependentState();
        publish("accounts");
        publish("usage");
      }
      return { poll };
    },
    "arc.omp.login.cancel": async ({ sessionId }) => {
      await requireHost().accounts.cancelOmpProviderLogin(sessionId);
      publish("accounts");
      return { ok: true as const };
    },
    "arc.omp.login.submitKey": ({ sessionId, key }) => {
      requireHost().accounts.submitOmpProviderLoginKey(sessionId, key);
      return { ok: true as const };
    },
    "arc.usage.snapshot": async () => requireHost().usage.listUsageResources(),
    "arc.usage.current": async ({ agentId, activeAccountKey, activeModelId }) =>
      requireHost().usage.getCurrentAgentUsage({
        agentId,
        activeAccountKey,
        activeModelId,
      }),
    "arc.usage.refresh": async ({ resourceId }) => {
      const host = requireHost();
      if (resourceId === undefined) {
        const snapshot = await host.usage.refreshAllUsage();
        publish("usage");
        return snapshot;
      }
      // One inventory backs both the snapshot the renderer receives and the
      // resource being refreshed — the previous shape re-listed every source
      // twice for a single click.
      const inventory = await host.usage.listUsageResources();
      const refreshed = await host.usage.refreshUsageResource(resourceId, {
        force: true,
        inventory,
      });
      publish("usage");
      return { ...inventory, resources: [refreshed] };
    },
  });
}
