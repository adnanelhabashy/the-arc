import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { reapStaleOmpBroker } from "./broker-ownership.js";
import { arcRpcContract } from "./contract.js";
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

// Arc Core: the fixed renderer-facing boundary over the Arc domain services
// (agents, accounts, usage). The renderer can only invoke these fixed,
// zod-validated methods — never arbitrary paths, commands, or URLs.
export default async function plugin(bb: BbPluginApi): Promise<void> {
  const config = resolveArcHostConfig(process.env);
  let host: ArcServiceHost | null = null;

  const instanceId = randomUUID();

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
    "arc.accounts.list": async () => {
      const detailed = await requireHost().accounts.listArcAccountsDetailed();
      return { accounts: detailed.accounts, sources: detailed.sources };
    },
    "arc.accounts.setEnabled": async ({ id, enabled }) => {
      const account = await requireHost().accounts.setAccountEnabled(id, enabled);
      publish("accounts");
      return { account };
    },
    "arc.accounts.remove": async ({ id }) => {
      await requireHost().accounts.removeAccount(id);
      publish("accounts");
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
    "arc.login.openai.poll": async ({ sessionId }) => ({
      poll: await requireHost().accounts.pollOpenAiLogin(sessionId),
      state: requireHost().accounts.getLoginState("openai"),
    }),
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
      publish("accounts");
      return { account };
    },
    "arc.omp.providers": async () => ({
      providers: await requireHost().accounts.listOmpProviders(),
    }),
    "arc.omp.login.start": async ({ provider }) => ({
      challenge: await requireHost().accounts.startOmpProviderLogin(provider),
    }),
    "arc.omp.login.poll": async ({ sessionId }) => ({
      poll: await requireHost().accounts.pollOmpProviderLogin(sessionId),
    }),
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
    "arc.usage.current": async ({ agentId, activeAccountKey }) =>
      requireHost().usage.getCurrentAgentUsage({ agentId, activeAccountKey }),
    "arc.usage.refresh": async ({ resourceId }) => {
      const host = requireHost();
      const snapshot =
        resourceId === undefined
          ? await host.usage.refreshAllUsage()
          : {
              ...(await host.usage.listUsageResources()),
              resources: [
                await host.usage.refreshUsageResource(resourceId),
              ],
            };
      publish("usage");
      return snapshot;
    },
  });
}
