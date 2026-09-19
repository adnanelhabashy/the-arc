import type { ArcRuntimeId } from "../arc-runtime/types.js";
import type { ArcAgentId } from "./types.js";

export type ArcAgentRuntimeStrategy =
  | "bundled-managed"
  | "official-managed";

export interface ArcAgentDescriptor {
  id: ArcAgentId;
  displayName: string;
  runtimeId: ArcRuntimeId;
  providerId: string;
  runtimeStrategy: ArcAgentRuntimeStrategy;
}

// The Arc product catalog is CLOSED: exactly three agents, in this fixed
// order. Upstream BB may register more providers (pi, acp-opencode,
// acp-cursor, acp-grok, acp-hermes-agent); they never become Arc product
// agents by accident of upstream drift. ArcAgentId is separate from the BB
// provider ID: only "omp" is "acp-omp" at the BB layer, and BB provider IDs
// are never renamed.
export const ARC_AGENT_CATALOG: readonly ArcAgentDescriptor[] = [
  {
    id: "omp",
    displayName: "OMP",
    runtimeId: "omp",
    providerId: "acp-omp",
    runtimeStrategy: "bundled-managed",
  },
  {
    id: "codex",
    displayName: "Codex",
    runtimeId: "codex",
    providerId: "codex",
    runtimeStrategy: "bundled-managed",
  },
  {
    id: "claude-code",
    displayName: "Claude Code",
    runtimeId: "claude-code",
    providerId: "claude-code",
    runtimeStrategy: "official-managed",
  },
];

const ARC_AGENT_DESCRIPTORS: Readonly<Record<ArcAgentId, ArcAgentDescriptor>> =
  {
    omp: ARC_AGENT_CATALOG[0],
    codex: ARC_AGENT_CATALOG[1],
    "claude-code": ARC_AGENT_CATALOG[2],
  };

export function getArcAgentDescriptor(
  id: ArcAgentId,
): ArcAgentDescriptor | undefined {
  return ARC_AGENT_DESCRIPTORS[id];
}
