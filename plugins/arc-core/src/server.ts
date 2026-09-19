import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { arcRpcContract } from "./contract.js";
import {
  ArcUnavailableError,
  createArcServiceHost,
  resolveArcHostConfig,
  type ArcServiceHost,
} from "./host.js";
import { ARC_CHANGED_CHANNEL, type ArcChangedKind } from "./realtime.js";

// Arc Core: the fixed renderer-facing boundary over the Arc domain services
// (agents, accounts, usage). The renderer can only invoke these fixed,
// zod-validated methods — never arbitrary paths, commands, or URLs.
export default async function plugin(bb: BbPluginApi): Promise<void> {
  const config = resolveArcHostConfig(process.env);
  let host: ArcServiceHost | null = null;

  const requireHost = (): ArcServiceHost => {
    if (config === null) {
      throw new ArcUnavailableError(
        "Arc services are unavailable: this server was not started by the Arc app",
      );
    }
    host ??= createArcServiceHost({
      config,
      serverOrigin: bb.server.loopbackBaseUrl,
    });
    return host;
  };

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
      publish("agents");
      publish("accounts");
      return { agent };
    },
    "arc.agents.repair": async ({ id }) => {
      const agent = await requireHost().agents.repairAgent(id);
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
    "arc.login.claude.complete": async ({ sessionId, pasted }) => {
      const account = await requireHost().accounts.completeClaudeLogin(
        sessionId,
        pasted,
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
