import { accessSync, constants } from "node:fs";
import type { AcpAgentDefinition } from "./agents.js";

const ARC_RUNTIME_ROOT_ENV = "BB_ARC_RUNTIME_ROOT";

const SHIPPED_AGENT_EXECUTABLE_ENV: Readonly<Record<string, string>> = {
  "acp-omp": "BB_OMP_EXECUTABLE",
};

export type AcpLaunchExecutableResolution =
  | { kind: "agent"; agent: AcpAgentDefinition }
  | { kind: "unavailable"; reason: string };

export interface ResolveAcpLaunchExecutableArgs {
  agent: AcpAgentDefinition;
  env: NodeJS.ProcessEnv;
}

export function resolveAcpLaunchExecutable(
  args: ResolveAcpLaunchExecutableArgs,
): AcpLaunchExecutableResolution {
  const envName = SHIPPED_AGENT_EXECUTABLE_ENV[args.agent.id];
  if (envName === undefined) {
    return { kind: "agent", agent: args.agent };
  }
  const configured = args.env[envName]?.trim();
  if (configured !== undefined && configured.length > 0) {
    try {
      accessSync(configured, constants.X_OK);
    } catch {
      return {
        kind: "unavailable",
        reason: `${envName} must point to an executable ${args.agent.displayName} path: ${configured}`,
      };
    }
    return {
      kind: "agent",
      agent: {
        ...args.agent,
        launch: { ...args.agent.launch, command: configured },
      },
    };
  }
  const arcOwnsRuntimes =
    (args.env[ARC_RUNTIME_ROOT_ENV]?.trim().length ?? 0) > 0;
  if (arcOwnsRuntimes) {
    return {
      kind: "unavailable",
      reason: `Arc owns the ${args.agent.displayName} runtime but ${envName} is not set; the managed ${args.agent.displayName} runtime is missing or broken. Repair it in Arc's Agents view.`,
    };
  }
  return { kind: "agent", agent: args.agent };
}
