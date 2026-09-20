import {
  ArcAccountError,
  ARC_ACCOUNT_PROVIDER_LABELS,
  type ArcAccount,
  type ArcAccountProviderFamily,
  type ArcAccountSource,
  type ArcAccountSourceKind,
  type ArcAccountAuthState,
  type ArcClaudeLoginChallenge,
  type ArcOpenAiLoginChallenge,
  type ArcOpenAiLoginPoll,
} from "./types.js";

// Wire shapes of the bundled account-pool plugin RPC contract
// (plugins/account-pool/src/contracts.ts). Only metadata crosses this
// boundary — secret material never leaves the pool's own secret store.
interface PoolAccountIdentity {
  id: string;
  provider: "claude" | "codex";
  label: string;
  email: string | null;
  accountUuid: string | null;
  codexAccountId?: string;
  subscriptionType: string | null;
  enabled: boolean;
}

interface PoolAccountSummary extends PoolAccountIdentity {
  status: "disabled" | "ready" | "held" | "exhausted" | "error";
}

export interface AccountPoolRpcClient {
  call(method: string, input: unknown): Promise<unknown>;
}

const RPC_BASE_PATH = "/api/v1/plugins/account-pool/rpc/";

// Minimal typed HTTP client for the plugin RPC route
// (POST /api/v1/plugins/account-pool/rpc/:method). The route is local-auth
// guarded: non-browser requests with a JSON content type are accepted.
export function createAccountPoolHttpRpcClient(args: {
  serverUrl: string;
  fetchImpl?: typeof fetch;
}): AccountPoolRpcClient {
  const fetchImpl = args.fetchImpl ?? fetch;
  const base = args.serverUrl.replace(/\/+$/u, "") + RPC_BASE_PATH;
  return {
    async call(method, input) {
      let response: Response;
      try {
        response = await fetchImpl(base + method, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: input === undefined ? "" : JSON.stringify(input),
        });
      } catch (error) {
        throw new ArcAccountError(
          "account-source-unavailable",
          `account pool RPC transport failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (response.status === 404 || response.status === 503) {
        throw new ArcAccountError(
          "account-source-unavailable",
          `account pool plugin is not available (HTTP ${response.status})`,
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new ArcAccountError(
          "account-source-unavailable",
          `account pool RPC returned an unreadable response (HTTP ${response.status})`,
        );
      }
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("ok" in payload)
      ) {
        throw new ArcAccountError(
          "account-source-unavailable",
          "account pool RPC returned an unexpected envelope",
        );
      }
      if (payload.ok !== true) {
        const error = (payload as { error?: unknown }).error;
        const message =
          typeof error === "string"
            ? error
            : typeof error === "object" &&
                error !== null &&
                "message" in error &&
                typeof (error as { message: unknown }).message === "string"
              ? (error as { message: string }).message
              : "account pool RPC failed";
        throw new ArcAccountError(
          method === "codexLogin.poll" && response.status === 400
            ? "login-expired"
            : "account-source-unavailable",
          method === "codexLogin.poll" && response.status === 400
            ? "the device login session is no longer known to the account pool"
            : message,
        );
      }
      return (payload as unknown as { result: unknown }).result;
    },
  };
}

export function mapPoolAccount(
  identity: PoolAccountIdentity,
  status: PoolAccountSummary["status"] | null,
  now: number,
): ArcAccount {
  const family = identity.provider === "codex" ? "openai" : "anthropic";
  const accountKey =
    identity.provider === "codex"
      ? typeof identity.codexAccountId === "string" &&
        identity.codexAccountId.length > 0
        ? `openai:chatgpt:${identity.codexAccountId}`
        : null
      : typeof identity.accountUuid === "string" &&
          identity.accountUuid.length > 0
        ? `anthropic:account:${identity.accountUuid}`
        : null;
  let authState: ArcAccountAuthState;
  if (!identity.enabled || status === "disabled") {
    authState = "disabled";
  } else if (status === null) {
    authState = "unknown";
  } else if (status === "error") {
    authState = "error";
  } else {
    // ready / held / exhausted are quota states: the account remains
    // authenticated, so its auth state stays "connected".
    authState = "connected";
  }
  return {
    id: `pool:${identity.id}`,
    sourceId: identity.id,
    sourceKind: "pool" as ArcAccountSourceKind,
    providerFamily: family,
    providerLabel: ARC_ACCOUNT_PROVIDER_LABELS[family],
    accountKey,
    identityKey: null,
    email: identity.email,
    planLabel: identity.subscriptionType,
    authState,
    enabled: identity.enabled,
    availableThrough: identity.provider === "codex" ? ["codex"] : ["claude-code"],
    observedAt: now,
  };
}

function asPoolAccountIdentity(value: unknown): PoolAccountIdentity {
  if (typeof value !== "object" || value === null) {
    throw new ArcAccountError(
      "account-source-unavailable",
      "account pool returned a malformed account",
    );
  }
  return value as PoolAccountIdentity;
}

export interface AccountPoolSourceArgs {
  rpc: AccountPoolRpcClient;
  now?: () => number;
}

// Account Pool adapter backing Arc Accounts for ChatGPT/OpenAI and
// Claude/Anthropic. Canonical identity is provider-issued (ChatGPT account
// id, Anthropic account uuid); email is presentation metadata only and is
// never used as identity. Accounts with no trustworthy canonical identity
// keep accountKey = null and stay distinct.
export class AccountPoolSource implements ArcAccountSource {
  readonly kind = "pool" as const;
  private readonly rpc: AccountPoolRpcClient;
  private readonly now: () => number;

  constructor(args: AccountPoolSourceArgs) {
    this.rpc = args.rpc;
    this.now = args.now ?? Date.now;
  }

  async listAccounts(): Promise<ArcAccount[]> {
    const result = await this.rpc.call("account.list", null);
    if (!Array.isArray(result)) {
      throw new ArcAccountError(
        "account-source-unavailable",
        "account pool returned a malformed account list",
      );
    }
    const now = this.now();
    return result.map((entry) =>
      mapPoolAccount(
        asPoolAccountIdentity(entry),
        (entry as { status?: PoolAccountSummary["status"] }).status ?? null,
        now,
      ),
    );
  }

  async getAccount(sourceId: string): Promise<ArcAccount> {
    const accounts = await this.listAccounts();
    const account = accounts.find((entry) => entry.sourceId === sourceId);
    if (account === undefined) {
      throw new ArcAccountError("account-not-found", sourceId);
    }
    return account;
  }

  async setAccountEnabled(
    sourceId: string,
    enabled: boolean,
  ): Promise<ArcAccount> {
    const result = (await this.rpc.call(
      enabled ? "account.enable" : "account.disable",
      { id: sourceId },
    )) as { account: PoolAccountIdentity | null };
    if (result.account === null) {
      throw new ArcAccountError("account-not-found", sourceId);
    }
    const refreshed = await this.getAccount(sourceId);
    return { ...refreshed, enabled };
  }

  async removeAccount(sourceId: string): Promise<void> {
    await this.getAccount(sourceId);
    await this.rpc.call("account.remove", { id: sourceId });
  }

  async setAccountPriority(
    sourceId: string,
    priority: number,
  ): Promise<ArcAccount> {
    const result = (await this.rpc.call("account.setPriority", {
      accountId: sourceId,
      priority,
    })) as { account: PoolAccountIdentity | null };
    if (result.account === null) {
      throw new ArcAccountError("account-not-found", sourceId);
    }
    return this.getAccount(sourceId);
  }

  async reorderAccounts(
    providerFamily: ArcAccountProviderFamily,
    orderedSourceIds: string[],
  ): Promise<void> {
    await this.rpc.call("account.reorder", {
      provider: providerFamily === "openai" ? "codex" : "claude",
      accountIds: orderedSourceIds,
    });
  }

  async startOpenAiLogin(): Promise<ArcOpenAiLoginChallenge> {
    const result = (await this.rpc.call("codexLogin.start", null)) as {
      sessionId: string;
      verificationUri: string;
      userCode: string;
      expiresAt: number;
      intervalMs: number;
    };
    return { provider: "openai", ...result };
  }

  async pollOpenAiLogin(sessionId: string): Promise<ArcOpenAiLoginPoll> {
    const result = (await this.rpc.call("codexLogin.poll", {
      sessionId,
    })) as
      | { status: "pending" }
      | { status: "complete"; account: PoolAccountSummary }
      | { status: "error"; message: string };
    if (result.status === "pending") {
      return { state: "waiting-for-user", account: null, message: null };
    }
    if (result.status === "complete") {
      return {
        state: "connected",
        account: mapPoolAccount(
          asPoolAccountIdentity(result.account),
          result.account.status,
          this.now(),
        ),
        message: null,
      };
    }
    return { state: "failed", account: null, message: result.message };
  }

  async cancelOpenAiLogin(sessionId: string): Promise<void> {
    await this.rpc.call("codexLogin.cancel", { sessionId });
  }

  async startClaudeLogin(): Promise<ArcClaudeLoginChallenge> {
    const result = (await this.rpc.call("login.start", null)) as {
      sessionId: string;
      authorizeUrl: string;
    };
    // The pool keeps a server-side session TTL but does not expose it; Arc
    // reports null rather than inventing a value.
    return { provider: "anthropic", ...result, expiresAt: null };
  }

  async completeClaudeLogin(
    sessionId: string,
    code: string,
  ): Promise<ArcAccount> {
    const result = (await this.rpc.call("login.complete", {
      sessionId,
      code,
    })) as PoolAccountIdentity;
    return mapPoolAccount(asPoolAccountIdentity(result), null, this.now());
  }
}
