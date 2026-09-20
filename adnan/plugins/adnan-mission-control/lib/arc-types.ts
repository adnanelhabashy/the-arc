// Arc product wire types — plain TS interfaces mirroring the renderer-facing
// contract in plugins/arc-core/src/contract.ts. Type-only: plugins cannot
// import each other, so the Mission Control server proxies arc-core over
// loopback HTTP and the frontend casts the (untyped) RPC results to these.
//
// Do NOT add token/key/credential fields here — the Arc wire contract never
// serializes secrets.

export type ArcAgentId = "codex" | "claude-code" | "omp";

export type ArcAgentRuntimeState =
  | "not-prepared"
  | "preparing"
  | "ready"
  | "ready-with-warning"
  | "broken"
  | "unsupported"
  | "unavailable";

export type ArcAgentProviderState = "unknown" | "ready" | "unavailable" | "error";

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

export type ArcRuntimeCompatibility = "supported" | "untested" | "blocked";

export type ArcRuntimeSource =
  | "arc-bundled"
  | "arc-managed-download"
  | "official-managed-install"
  | "external-override";

export interface ArcStatus {
  arcAvailable: boolean;
  reason: string | null;
}

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
  knownGoodVersion: string | null;
}

export interface ArcRuntimeReleaseSummary {
  version: string;
  platform: string;
  releaseTag: string;
  assetName: string;
  downloadUrl: string;
  sha256: string;
  license: string;
}

export interface ArcRuntimeUpdateDiscovery {
  runtimeId: ArcAgentId;
  installedVersions: string[];
  activeVersion: string | null;
  knownGoodVersion: string | null;
  latestTrusted: ArcRuntimeReleaseSummary | null;
  latestTrustedCompatibility: ArcRuntimeCompatibility | null;
  latestTrustedCompatibilityReason: string | null;
  updateAvailable: boolean;
  rollbackAvailable: boolean;
  discoveryError: string | null;
}

export type ArcRuntimeUpdateOutcome =
  | { kind: "updated"; version: string; detail: string }
  | { kind: "up-to-date"; version: string | null }
  | { kind: "no-trusted-update"; reason: string }
  | { kind: "staging-failed"; reason: string }
  | { kind: "pre-activation-health-failed"; reason: string }
  | { kind: "activation-failed"; reason: string }
  | { kind: "post-activation-unhealthy-rolled-back"; from: string; to: string; reason: string }
  | { kind: "post-activation-unhealthy-no-rollback-target"; version: string; reason: string };

export type ArcRuntimeRollbackOutcome =
  | { kind: "rolled-back"; from: string; to: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "failed"; reason: string };

export interface ArcAgentStatus {
  id: ArcAgentId;
  displayName: string;
  runtimeId: ArcAgentId;
  providerId: string;
  runtime: ArcAgentRuntimeStatus;
  provider: { state: ArcAgentProviderState };
  account: { state: ArcAgentAccountState };
  overallState: ArcAgentOverallState;
  actions: ArcAgentAction[];
  observedAt: number;
}

export type ArcAccountAuthState =
  | "connected"
  | "expired"
  | "disabled"
  | "error"
  | "unknown";

export type ArcAccountSourceKind = "pool" | "omp";

export interface ArcAccount {
  id: string;
  sourceId: string;
  sourceKind: ArcAccountSourceKind;
  providerFamily: string;
  providerLabel: string;
  accountKey: string | null;
  email: string | null;
  planLabel: string | null;
  authState: ArcAccountAuthState;
  enabled: boolean;
  availableThrough: ArcAgentId[];
  observedAt: number;
}

export interface ArcAccountSourceStatus {
  kind: ArcAccountSourceKind;
  state: "ready" | "unavailable";
  detail: string | null;
  checkedAt: number;
}

export interface ArcAccountsList {
  accounts: ArcAccount[];
  sources: ArcAccountSourceStatus[];
}

export interface ArcOpenAiLoginChallenge {
  provider: "openai";
  sessionId: string;
  verificationUri: string;
  userCode: string;
  expiresAt: number;
  intervalMs: number;
}

export interface ArcClaudeLoginChallenge {
  provider: "anthropic";
  sessionId: string;
  authorizeUrl: string;
  expiresAt: number | null;
}

export type ArcAccountLoginChallenge =
  | ArcOpenAiLoginChallenge
  | ArcClaudeLoginChallenge;

export type ArcLoginPollState = "waiting-for-user" | "connected" | "failed";

export type ArcAccountLoginState =
  | "idle"
  | "starting"
  | "waiting-for-user"
  | "authorizing"
  | "connected"
  | "failed"
  | "expired"
  | "cancelled";

export interface ArcOpenAiLoginPoll {
  state: ArcLoginPollState;
  account: ArcAccount | null;
  message: string | null;
}

export interface ArcOpenAiLoginPollResult {
  poll: ArcOpenAiLoginPoll;
  state: ArcAccountLoginState;
}

export interface ArcOmpProvider {
  id: string;
  displayName: string;
  authMethod: "oauth" | "api-key" | "unknown";
  connectionState: "connected" | "not-connected" | "unknown";
  hasAccounts: boolean;
}

export interface ArcOmpLoginChallenge {
  provider: string;
  sessionId: string;
  kind: "oauth" | "api-key";
  // How the OAuth session actually authenticates, as classified from the
  // live broker output: a browser redirect flow, or a device-code flow
  // (verification URL + one-time user code, e.g. Kimi).
  flow: "browser" | "device";
  userCode: string | null;
  authorizeUrl: string | null;
  instructions: string | null;
  expiresAt: number | null;
}

export interface ArcOmpLoginPoll {
  state: ArcLoginPollState;
  account: ArcAccount | null;
  message: string | null;
}

export type ArcUsageSourceKind = "pool" | "omp" | "thread";

export type ArcUsageResourceStatus = "available" | "unavailable" | "error" | "unknown";

export type ArcUsageUnavailableReason = "not-exposed" | "not-connected" | "disabled";

export type ArcUsageWindowKind = "five-hour" | "daily" | "weekly" | "monthly" | "custom";

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
  usedPercent: number | null;
  remainingPercent: number | null;
  usedAmount: number | null;
  limitAmount: number | null;
  remainingAmount: number | null;
  unit: ArcUsageUnit | null;
  resetsAt: number | null;
  observedAt: number | null;
  source: ArcUsageSourceKind | null;
}

export interface ArcUsageResource {
  id: string;
  sourceKind: ArcUsageSourceKind;
  accountKey: string | null;
  accountSourceId: string | null;
  providerFamily: string | null;
  providerLabel: string;
  accountEmail: string | null;
  planLabel: string | null;
  modelLabel: string | null;
  agentIds: ArcAgentId[];
  windows: ArcUsageWindow[];
  observedAt: number | null;
  fetchedAt: number | null;
  stale: boolean;
  status: ArcUsageResourceStatus;
  unavailableReason: ArcUsageUnavailableReason | null;
  credentialDisabled: boolean;
  message: string | null;
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
