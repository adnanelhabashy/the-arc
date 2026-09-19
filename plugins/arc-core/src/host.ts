import {
  AccountPoolSource,
  ArcAccountService,
  createAccountPoolHttpRpcClient,
  createArcOmpRuntimeResolver,
  OmpAccountSource,
  ServiceArcAccountStatusSource,
} from "@bb/arc-domains/arc-account";
import { ArcAgentManager } from "@bb/arc-domains/arc-agent";
import { createArcRuntimePaths } from "@bb/arc-domains/arc-runtime";
import {
  ArcOmpUsageSource,
  ArcPoolUsageSource,
  ArcThreadUsageSource,
  ArcUsageService,
} from "@bb/arc-domains/arc-usage";
import { createNodeOmpSpawn } from "./node-spawn.js";

// Arc mode is declared by the desktop shell through environment variables on
// the server process it spawns. Absent (standalone bb) → no host; every RPC
// reports arc-unavailable rather than fabricating state.
export interface ArcHostConfig {
  runtimeRoot: string;
  appVersion: string;
  seedRoot: string | null;
}

export function resolveArcHostConfig(
  env: NodeJS.ProcessEnv,
): ArcHostConfig | null {
  const runtimeRoot = env.BB_ARC_RUNTIME_ROOT;
  if (runtimeRoot === undefined || runtimeRoot.length === 0) return null;
  return {
    runtimeRoot,
    appVersion: env.BB_ARC_APP_VERSION ?? "0.0.0",
    seedRoot:
      env.BB_ARC_SEED_ROOT !== undefined && env.BB_ARC_SEED_ROOT.length > 0
        ? env.BB_ARC_SEED_ROOT
        : null,
  };
}

export interface ArcServiceHost {
  readonly agents: ArcAgentManager;
  readonly accounts: ArcAccountService;
  readonly usage: ArcUsageService;
}

export interface CreateArcServiceHostArgs {
  config: ArcHostConfig;
  // Loopback origin of the bb server (e.g. http://127.0.0.1:38886). The
  // account-pool and usage pool clients append their own plugin RPC paths.
  serverOrigin: string;
  platform?: string;
  env?: NodeJS.ProcessEnv;
}

export function createArcServiceHost(
  args: CreateArcServiceHostArgs,
): ArcServiceHost {
  const platform = args.platform ?? process.platform;
  const runtimePaths = createArcRuntimePaths({
    userDataPath: args.config.runtimeRoot,
  });
  const poolRpc = createAccountPoolHttpRpcClient({
    serverUrl: args.serverOrigin,
  });
  const poolSource = new AccountPoolSource({ rpc: poolRpc });
  const ompSource = new OmpAccountSource({
    resolveRuntime: createArcOmpRuntimeResolver({
      createdByArcVersion: args.config.appVersion,
      homeDirectory: args.config.runtimeRoot,
      platform,
      runtimePaths,
      env: args.env,
    }),
    spawn: createNodeOmpSpawn(),
  });
  const accounts = new ArcAccountService({
    sources: [poolSource, ompSource],
  });
  const agents = new ArcAgentManager({
    createdByArcVersion: args.config.appVersion,
    platform,
    runtimePaths,
    seedRoot: args.config.seedRoot ?? undefined,
    accountStatusSource: new ServiceArcAccountStatusSource(accounts),
  });
  const usage = new ArcUsageService({
    sources: [
      new ArcPoolUsageSource({ rpc: poolRpc }),
      new ArcOmpUsageSource({ gateway: ompSource }),
      // Current-thread context is a renderer concept; the service-side
      // thread source has no current thread to report. The popup renders
      // context from the thread timeline it already holds.
      new ArcThreadUsageSource({
        gateway: { getCurrentThreadContext: async () => null },
      }),
    ],
  });
  return { agents, accounts, usage };
}

export class ArcUnavailableError extends Error {
  constructor(reason: string) {
    super(`arc-unavailable: ${reason}`);
    this.name = "ArcUnavailableError";
  }
}
