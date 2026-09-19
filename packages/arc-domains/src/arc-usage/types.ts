import type { ArcAgentId } from "../arc-agent/types.js";

// Arc's unified usage & limits domain ("Usage & Limits"). One generic
// resource model over three real sources: Account Pool (ChatGPT/Codex and
// Claude subscription accounts), OMP provider accounts (via the lazy
// loopback broker), and the current thread's context window. Permanent
// rule: UNKNOWN != ZERO — a provider that does not expose usage reports
// "unavailable", never 0%, and a failed refresh keeps the last good
// reading marked stale rather than erasing it.

export type ArcUsageSourceKind = "pool" | "omp" | "thread";

export type ArcUsageResourceStatus =
  | "available"
  | "unavailable"
  | "error"
  | "unknown";

// Why a resource carries no usable usage. "not-exposed" is the provider's
// own answer (account exists, no usage endpoint); "not-connected" is an
// auth/install state; "disabled" is a provider-side credential block. All
// three are distinct from a fetch failure (status "error").
export type ArcUsageUnavailableReason =
  | "not-exposed"
  | "not-connected"
  | "disabled";

export type ArcUsageWindowKind =
  | "five-hour"
  | "daily"
  | "weekly"
  | "monthly"
  | "custom";

export type ArcUsageWindowStatus = "ok" | "warning" | "exhausted" | "unknown";

export type ArcUsageUnit =
  | "percent"
  | "tokens"
  | "requests"
  | "credits"
  | "usd"
  | "minutes"
  | "bytes"
  | "unknown";

export interface ArcUsageWindow {
  id: string;
  label: string;
  kind: ArcUsageWindowKind;
  status: ArcUsageWindowStatus | null;
  // Percentages only when the provider reported a real fraction (or
  // equivalent used/limit with a true denominator). Never fabricated from
  // unbounded amounts such as "$7.32 credit remaining".
  usedPercent: number | null;
  remainingPercent: number | null;
  // Raw amounts when the provider exposes units instead of percentages.
  usedAmount: number | null;
  limitAmount: number | null;
  remainingAmount: number | null;
  unit: ArcUsageUnit | null;
  // Provider-reported reset timestamp; null when unknown. Never guessed.
  resetsAt: number | null;
  observedAt: number | null;
  // Provenance after cross-source association: which source produced this
  // window observation. Null for unassociated resources.
  source: ArcUsageSourceKind | null;
}

export interface ArcUsageResource {
  // Stable local identifier, never derived from email. Shape:
  // pool:<providerFamily>:<sourceAccountId> / omp:<provider>:<credentialId>
  // / thread:<threadId>.
  id: string;
  sourceKind: ArcUsageSourceKind;
  // Canonical provider-issued identity (e.g. openai:chatgpt:<accountId>,
  // anthropic:account:<uuid>, omp:<provider>:<accountId>). Null means
  // source-local: never deduplicated across sources.
  accountKey: string | null;
  // The ArcAccount id this usage belongs to, when one exists.
  accountSourceId: string | null;
  providerFamily: string | null;
  providerLabel: string;
  accountEmail: string | null;
  planLabel: string | null;
  modelLabel: string | null;
  agentIds: ArcAgentId[];
  windows: ArcUsageWindow[];
  // Provider-side observation time (when the vendor snapshot was
  // generated), distinct from fetchedAt (when Arc last obtained it).
  observedAt: number | null;
  fetchedAt: number | null;
  // True when the last refresh attempt failed and this resource shows the
  // previous successful reading.
  stale: boolean;
  status: ArcUsageResourceStatus;
  unavailableReason: ArcUsageUnavailableReason | null;
  // True when the underlying credential is provider-disabled (a temporary
  // block), so future UI can say "Connected but temporarily unavailable".
  credentialDisabled: boolean;
  // Sanitized diagnostic; never raw CLI/HTTP output.
  message: string | null;
  // Every source that reports this same canonical account (association
  // provenance). Single-element for unassociated resources.
  sources: ArcUsageSourceKind[];
}

export interface ArcUsageSourceStatus {
  kind: ArcUsageSourceKind;
  state: "ready" | "unavailable";
  detail: string | null;
  checkedAt: number;
}

export interface ArcUsageSnapshot {
  generatedAt: number;
  resources: ArcUsageResource[];
  sources: ArcUsageSourceStatus[];
}

// One usage source behind the service. list is cheap and refresh-free;
// fetch returns the current measurement for exactly one listed resource.
export interface ArcUsageSource {
  readonly kind: ArcUsageSourceKind;
  list(): Promise<ArcUsageResource[]>;
  fetch(resourceId: string, refresh: boolean): Promise<ArcUsageResource>;
}

export type ArcUsageErrorCode =
  | "usage-source-unavailable"
  | "usage-fetch-failed"
  | "usage-resource-not-found"
  | "usage-refresh-failed"
  | "usage-contract-invalid";

export class ArcUsageError extends Error {
  readonly code: ArcUsageErrorCode;

  constructor(code: ArcUsageErrorCode, message: string) {
    super(message);
    this.name = "ArcUsageError";
    this.code = code;
  }
}

// What the thread context gateway returns. Mirrors BB's
// ThreadContextWindowUsage (used / model context window / estimated);
// token counts are context-window occupancy, not provider quota.
export interface ArcThreadContextUsage {
  threadId: string;
  usedTokens: number;
  modelContextWindow: number;
  estimated: boolean;
  modelLabel: string | null;
}

export interface ArcThreadContextGateway {
  getCurrentThreadContext(): Promise<ArcThreadContextUsage | null>;
}

export interface ArcCurrentAgentUsage {
  agentId: ArcAgentId;
  thread: ArcUsageResource | null;
  resources: ArcUsageResource[];
  // True when the active account behind these resources could not be
  // identified; the caller may present "multiple connected accounts".
  activeAccountUnknown: boolean;
}
