import type {
  ArcRuntimeCompatibility,
  ArcRuntimeId,
  ArcRuntimeSource,
} from "../arc-runtime/types.js";

export type ArcAgentId = "codex" | "claude-code" | "omp";

export const ARC_AGENT_IDS: readonly ArcAgentId[] = [
  "codex",
  "claude-code",
  "omp",
];

export type ArcAgentRuntimeState =
  | "not-prepared"
  | "preparing"
  | "ready"
  | "ready-with-warning"
  | "broken"
  | "unsupported"
  | "unavailable";

export type ArcAgentProviderState =
  | "unknown"
  | "ready"
  | "unavailable"
  | "error";

export type ArcAgentAccountState =
  | "unknown"
  | "not-connected"
  | "connected"
  | "expired"
  | "error";

export type ArcAgentOverallState =
  | "not-prepared"
  | "preparing"
  | "runtime-ready"
  | "account-required"
  | "ready"
  | "broken"
  | "unsupported"
  | "unavailable";

export type ArcAgentActionId =
  | "prepare"
  | "repair"
  | "open-settings"
  | "connect-account"
  | "update"
  | "rollback";

export interface ArcAgentAction {
  id: ArcAgentActionId;
  available: boolean;
  reason?: string;
}

export interface ArcAgentRuntimeStatus {
  state: ArcAgentRuntimeState;
  version: string | null;
  compatibility: ArcRuntimeCompatibility | null;
  compatibilityReason: string | null;
  source: ArcRuntimeSource | null;
  // Distinct from version (ADR-076): the version last proven healthy after
  // activation, and therefore the explicit rollback target. Equal to
  // version once a just-activated update promotes; may differ from version
  // for a short window right after activation, before promotion runs.
  knownGoodVersion: string | null;
}

export interface ArcAgentStatus {
  id: ArcAgentId;
  displayName: string;
  runtimeId: ArcRuntimeId;
  providerId: string;
  runtime: ArcAgentRuntimeStatus;
  provider: { state: ArcAgentProviderState };
  account: { state: ArcAgentAccountState };
  overallState: ArcAgentOverallState;
  actions: ArcAgentAction[];
  // When Arc observed this status — not when the vendor runtime last changed.
  observedAt: number;
}

export type ArcAgentErrorCode =
  | "unsupported-agent"
  | "runtime-prepare-failed"
  | "runtime-repair-failed"
  | "runtime-update-failed"
  | "runtime-rollback-failed"
  | "provider-unavailable";

export class ArcAgentError extends Error {
  readonly code: ArcAgentErrorCode;
  readonly detail: string;

  constructor(code: ArcAgentErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ArcAgentError";
    this.code = code;
    this.detail = detail;
  }
}
