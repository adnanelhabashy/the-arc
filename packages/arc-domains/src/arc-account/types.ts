import type { ArcAgentId } from "../arc-agent/types.js";

export type ArcAccountSourceKind = "pool" | "omp";

// Pool accounts use the closed families "openai"/"anthropic"; OMP accounts
// carry the OMP provider id (kimi-code, anthropic, deepseek, ...). The
// intersection keeps the two pool literals autocomplete-friendly while
// allowing any OMP-reported provider id.
export type ArcAccountProviderFamily =
  | "openai"
  | "anthropic"
  | (string & {});

export const ARC_ACCOUNT_PROVIDER_LABELS: Record<
  "openai" | "anthropic",
  string
> = {
  openai: "ChatGPT",
  anthropic: "Claude",
};

export type ArcAccountAuthState =
  | "connected"
  | "expired"
  | "disabled"
  | "error"
  | "unknown";

export interface ArcAccount {
  id: string;
  sourceId: string;
  sourceKind: ArcAccountSourceKind;
  providerFamily: ArcAccountProviderFamily;
  providerLabel: string;
  accountKey: string | null;
  // The source's own credential identity, and the only handle some sources
  // can pin an execution by. null for every account whose source cannot pin by
  // it: pool accounts (provider-issued accountKey only) and OMP api-key
  // credentials, which OMP's account filter never matches.
  identityKey: string | null;
  email: string | null;
  planLabel: string | null;
  authState: ArcAccountAuthState;
  enabled: boolean;
  availableThrough: ArcAgentId[];
  observedAt: number;
}

export type ArcAccountLoginProvider = ArcAccountProviderFamily;

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

export type ArcAccountLoginState =
  | "idle"
  | "starting"
  | "waiting-for-user"
  | "authorizing"
  | "connected"
  | "failed"
  | "expired"
  | "cancelled";

export type ArcOpenAiLoginPollState = "waiting-for-user" | "connected" | "failed";

export interface ArcOpenAiLoginPoll {
  state: ArcOpenAiLoginPollState;
  account: ArcAccount | null;
  message: string | null;
}

// ─── OMP providers & accounts (Phase 8) ────────────────────────────────

// A provider OMP can authenticate against. Providers are static OAuth
// registry definitions (`omp auth-broker list`); they are NOT accounts —
// connectionState comes from observed stored credentials only.
export interface ArcOmpProvider {
  id: string;
  displayName: string;
  // OMP 18.2.6 does not expose a machine-readable auth-method field; Arc
  // reports "oauth" for registry providers without a stored api_key
  // credential, "api-key" when the stored credential is an api key, and
  // "unknown" otherwise. Nothing richer is invented.
  authMethod: "oauth" | "api-key" | "unknown";
  connectionState: "connected" | "not-connected" | "unknown";
  // True when at least one stored credential exists for this provider.
  hasAccounts: boolean;
}

// Start of an OMP provider login. `kind` is "oauth" when OMP printed an
// authorize URL (browser flow) and "api-key" when OMP is waiting for a key
// to be submitted via submitOmpLoginKey. Within OAuth, `flow` classifies
// what the live broker output actually is: a plain browser redirect, or a
// device-code flow (verification URL plus one-time `userCode`, e.g. Kimi's
// "Enter code: XXXX-XXXX"). Presentation data only — never a token or key.
export interface ArcOmpLoginChallenge {
  provider: string;
  sessionId: string;
  kind: "oauth" | "api-key";
  flow: "browser" | "device";
  userCode: string | null;
  authorizeUrl: string | null;
  instructions: string | null;
  expiresAt: number | null;
}

export type ArcOmpLoginPollState =
  | "waiting-for-user"
  | "connected"
  | "failed";

export interface ArcOmpLoginPoll {
  state: ArcOmpLoginPollState;
  account: ArcAccount | null;
  message: string | null;
}

// Health of one account source as observed by the last inventory read.
// UNKNOWN != EMPTY: an "unavailable" source means its accounts could not be
// queried, not that it has none.
export interface ArcAccountSourceStatus {
  kind: ArcAccountSourceKind;
  state: "ready" | "unavailable";
  detail: string | null;
  checkedAt: number;
}

export type ArcAccountErrorCode =
  | "account-source-unavailable"
  | "account-not-found"
  | "login-cancelled"
  | "login-expired"
  | "login-failed"
  | "unsupported-provider"
  | "omp-runtime-unavailable"
  | "provider-not-found"
  | "auth-not-supported"
  | "disconnect-failed";

export class ArcAccountError extends Error {
  readonly code: ArcAccountErrorCode;
  readonly detail: string;

  constructor(code: ArcAccountErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ArcAccountError";
    this.code = code;
    this.detail = detail;
  }
}

// Source-agnostic account backend. Phase 7 ships AccountPoolSource; Phase 8
// adds an OMP source behind the same interface. Credentials always stay with
// the underlying source — implementations return metadata only.
export interface ArcAccountSource {
  readonly kind: ArcAccountSourceKind;
  listAccounts(): Promise<ArcAccount[]>;
  getAccount(sourceId: string): Promise<ArcAccount>;
  setAccountEnabled(sourceId: string, enabled: boolean): Promise<ArcAccount>;
  removeAccount(sourceId: string): Promise<void>;
  setAccountPriority(sourceId: string, priority: number): Promise<ArcAccount>;
  reorderAccounts(
    providerFamily: ArcAccountProviderFamily,
    orderedSourceIds: string[],
  ): Promise<void>;
  startOpenAiLogin(): Promise<ArcOpenAiLoginChallenge>;
  pollOpenAiLogin(sessionId: string): Promise<ArcOpenAiLoginPoll>;
  cancelOpenAiLogin(sessionId: string): Promise<void>;
  startClaudeLogin(): Promise<ArcClaudeLoginChallenge>;
  completeClaudeLogin(sessionId: string, code: string): Promise<ArcAccount>;
}
