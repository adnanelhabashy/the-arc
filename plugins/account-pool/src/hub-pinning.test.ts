import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AccountPoolHub } from "./hub.js";
import { QUOTA_MIGRATIONS, QuotaStore, PoolAffinityStore } from "./store.js";
import type { AccountBinding } from "./store.js";
import type { Account, PoolProvider } from "./contracts.js";
import { DEFAULT_ACCOUNT_POOL_CONFIG } from "./contracts.js";
import type { ProviderAdapter } from "./provider-adapter.js";

function makeDatabase(): Database.Database {
  const database = new Database(":memory:");
  for (const migration of QUOTA_MIGRATIONS) database.exec(migration);
  return database;
}

function makeAccount(overrides: Partial<Account>): Account {
  return {
    id: overrides.id ?? "11111111-1111-4111-8111-111111111111",
    provider: "codex",
    kind: "api-key",
    label: overrides.label ?? "account",
    email: null,
    accountUuid: null,
    subscriptionType: null,
    rateLimitTier: null,
    enabled: true,
    priority: 100,
    createdAt: 1,
    lastUsedAt: null,
    lastUsedHostId: null,
    ...overrides,
  };
}

class FakeAccountStore {
  constructor(private accounts: Account[]) {}
  async list(): Promise<Account[]> {
    return this.accounts;
  }
  async recordUsed(): Promise<boolean> {
    return false;
  }
  async readSecret(): Promise<{ kind: "api-key"; apiKey: string }> {
    return { kind: "api-key", apiKey: "test-key" };
  }
}

class FakeHubTokenStore {
  async authenticate(token: string | null): Promise<string | null> {
    return token === "test-token" ? "test-host" : null;
  }
  async list(): Promise<never[]> {
    return [];
  }
}

class FakeResolutionStore {
  readonly recorded: Array<{ threadId: string; accountId: string }> = [];
  async recordResolved(threadId: string, accountId: string): Promise<void> {
    this.recorded.push({ threadId, accountId });
  }
  async getResolved(): Promise<null> {
    return null;
  }
}

function makeAdapter(fetchImpl: typeof fetch): ProviderAdapter {
  return {
    provider: "codex",
    upstreamName: "Test Upstream",
    async importAccount() {
      throw new Error("not implemented");
    },
    parseRequest() {
      return {
        family: "other",
        affinityId: null,
        parentAffinityId: null,
        forAccount: (_account: Account) => new Uint8Array(),
      };
    },
    upstreamUrl() {
      return new URL("https://upstream.example.com/v1/responses");
    },
    requestHeaders(inbound: Headers) {
      return new Headers(inbound);
    },
    quotaFromHeaders(_accountId: string, _headers: Headers, previous: unknown) {
      return previous;
    },
    isQuotaRejection() {
      return false;
    },
    async refreshSecret() {
      return { secret: { kind: "api-key", apiKey: "k" }, refreshed: false };
    },
    async refreshUsage() {},
    errorResponse(status: number, message: string, headers?: HeadersInit) {
      return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "content-type": "application/json", ...headers },
      });
    },
  } as unknown as ProviderAdapter;
}

function makeHub(accounts: Account[]): {
  hub: AccountPoolHub;
  fetchCalls: string[];
  stop: () => void;
  resolution: FakeResolutionStore;
} {
  const fetchCalls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    fetchCalls.push(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
    );
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const database = makeDatabase();
  const settings = { ...DEFAULT_ACCOUNT_POOL_CONFIG, switchThreshold: 0.9 };
  const resolution = new FakeResolutionStore();
  const options = {
    accounts: new FakeAccountStore(accounts) as unknown as import(
      "./store.js"
    ).AccountStore,
    quotas: new QuotaStore(database),
    affinity: new PoolAffinityStore(database),
    hubTokens: new FakeHubTokenStore() as unknown as import(
      "./store.js"
    ).HubTokenStore,
    resolution: resolution as unknown as import(
      "./store.js"
    ).AccountResolutionStore,
    getSettings: () => settings,
    adapters: new Map<PoolProvider, ProviderAdapter>([
      ["codex", makeAdapter(fetchImpl)],
    ]),
    fetch: fetchImpl,
    now: () => Date.now(),
    drainTimeoutMs: 1_000,
    getParentRoute: () => null,
    onAccountsChanged: () => {},
    onUpstreamError: () => {},
  };
  const hub = new (AccountPoolHub as unknown as new (
    options: unknown,
  ) => AccountPoolHub)(options);
  const controller = new AbortController();
  void hub.start(controller.signal);
  return { hub, fetchCalls, stop: () => controller.abort(), resolution };
}

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://local.test/api/v1/plugins/account-pool/http", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      ...headers,
    },
    body: "{}",
  });
}

const hubs: Array<() => void> = [];
afterEach(() => {
  while (hubs.length > 0) hubs.pop()?.();
});

describe("AccountPoolHub explicit account pinning", () => {
  it("routes to the pinned account even when a higher-priority account is idle", async () => {
    const high = makeAccount({
      id: "11111111-1111-4111-8111-111111111111",
      priority: 1,
    });
    const low = makeAccount({
      id: "22222222-2222-4222-8222-222222222222",
      priority: 100,
    });
    const { hub, stop } = makeHub([high, low]);
    hubs.push(stop);

    const response = await hub.handle(
      makeRequest({ "x-bb-account-pool-pin": low.id }),
      "codex",
      "/api/v1/plugins/account-pool/http",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-bb-account-pool-selected-account-id")).toBe(
      low.id,
    );
  });

  it("rejects with a distinct error when the pinned account is disabled, without falling back", async () => {
    const disabled = makeAccount({
      id: "11111111-1111-4111-8111-111111111111",
      enabled: false,
    });
    const other = makeAccount({
      id: "22222222-2222-4222-8222-222222222222",
      enabled: true,
    });
    const { hub, stop, fetchCalls } = makeHub([disabled, other]);
    hubs.push(stop);

    const response = await hub.handle(
      makeRequest({ "x-bb-account-pool-pin": disabled.id }),
      "codex",
      "/api/v1/plugins/account-pool/http",
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("x-bb-account-pool-pin-unavailable")).toBe(
      "disabled",
    );
    expect(fetchCalls).toHaveLength(0);
  });

  it("rejects with a distinct error when the pinned account no longer exists", async () => {
    const account = makeAccount({});
    const { hub, stop } = makeHub([account]);
    hubs.push(stop);

    const response = await hub.handle(
      makeRequest({ "x-bb-account-pool-pin": "99999999-9999-4999-8999-999999999999" }),
      "codex",
      "/api/v1/plugins/account-pool/http",
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("x-bb-account-pool-pin-unavailable")).toBe(
      "removed",
    );
  });

  it("resolves two concurrent pinned requests to their own distinct accounts", async () => {
    const first = makeAccount({
      id: "11111111-1111-4111-8111-111111111111",
    });
    const second = makeAccount({
      id: "22222222-2222-4222-8222-222222222222",
    });
    const { hub, stop } = makeHub([first, second]);
    hubs.push(stop);

    const [responseA, responseB] = await Promise.all([
      hub.handle(
        makeRequest({ "x-bb-account-pool-pin": first.id }),
        "codex",
        "/api/v1/plugins/account-pool/http",
      ),
      hub.handle(
        makeRequest({ "x-bb-account-pool-pin": second.id }),
        "codex",
        "/api/v1/plugins/account-pool/http",
      ),
    ]);

    expect(responseA.headers.get("x-bb-account-pool-selected-account-id")).toBe(
      first.id,
    );
    expect(responseB.headers.get("x-bb-account-pool-selected-account-id")).toBe(
      second.id,
    );
  });

  it("defaults to priority-ordered selection and reports the selected account when unpinned", async () => {
    const high = makeAccount({
      id: "11111111-1111-4111-8111-111111111111",
      priority: 1,
    });
    const low = makeAccount({
      id: "22222222-2222-4222-8222-222222222222",
      priority: 100,
    });
    const { hub, stop } = makeHub([high, low]);
    hubs.push(stop);

    const response = await hub.handle(
      makeRequest(),
      "codex",
      "/api/v1/plugins/account-pool/http",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-bb-account-pool-selected-account-id")).toBe(
      high.id,
    );
  });
});

describe("AccountPoolHub path-based account pinning", () => {
  it("routes to the pinned account when the pin is delivered as an explicit path option, just like the header", async () => {
    const high = makeAccount({
      id: "11111111-1111-4111-8111-111111111111",
      priority: 1,
    });
    const low = makeAccount({
      id: "22222222-2222-4222-8222-222222222222",
      priority: 100,
    });
    const { hub, stop } = makeHub([high, low]);
    hubs.push(stop);

    const response = await hub.handle(
      makeRequest(),
      "codex",
      "/api/v1/plugins/account-pool/http",
      { pinnedAccountId: low.id },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-bb-account-pool-selected-account-id")).toBe(
      low.id,
    );
  });

  it("rejects a path-pinned disabled account with the same 409 as a header pin, without falling back", async () => {
    const disabled = makeAccount({
      id: "11111111-1111-4111-8111-111111111111",
      enabled: false,
    });
    const other = makeAccount({
      id: "22222222-2222-4222-8222-222222222222",
      enabled: true,
    });
    const { hub, stop, fetchCalls } = makeHub([disabled, other]);
    hubs.push(stop);

    const response = await hub.handle(
      makeRequest(),
      "codex",
      "/api/v1/plugins/account-pool/http",
      { pinnedAccountId: disabled.id },
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("x-bb-account-pool-pin-unavailable")).toBe(
      "disabled",
    );
    expect(fetchCalls).toHaveLength(0);
  });

  it("rejects a path-pinned account that no longer exists, mirroring the header-pin behavior", async () => {
    const account = makeAccount({});
    const { hub, stop } = makeHub([account]);
    hubs.push(stop);

    const response = await hub.handle(
      makeRequest(),
      "codex",
      "/api/v1/plugins/account-pool/http",
      { pinnedAccountId: "99999999-9999-4999-8999-999999999999" },
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("x-bb-account-pool-pin-unavailable")).toBe(
      "removed",
    );
  });

  it("prefers the explicit path pin over a conflicting header pin (path wins)", async () => {
    const pathTarget = makeAccount({
      id: "11111111-1111-4111-8111-111111111111",
    });
    const headerTarget = makeAccount({
      id: "22222222-2222-4222-8222-222222222222",
    });
    const { hub, stop } = makeHub([pathTarget, headerTarget]);
    hubs.push(stop);

    const response = await hub.handle(
      makeRequest({ "x-bb-account-pool-pin": headerTarget.id }),
      "codex",
      "/api/v1/plugins/account-pool/http",
      { pinnedAccountId: pathTarget.id },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-bb-account-pool-selected-account-id")).toBe(
      pathTarget.id,
    );
  });
});

describe("AccountPoolHub auto-resolution correlation", () => {
  it("records the resolved account against the thread id header when unpinned", async () => {
    const high = makeAccount({
      id: "11111111-1111-4111-8111-111111111111",
      priority: 1,
    });
    const { hub, stop, resolution } = makeHub([high]);
    hubs.push(stop);

    const response = await hub.handle(
      makeRequest({ "x-bb-account-pool-thread-id": "thread-abc" }),
      "codex",
      "/api/v1/plugins/account-pool/http",
    );

    expect(response.status).toBe(200);
    expect(resolution.recorded).toEqual([
      { threadId: "thread-abc", accountId: high.id },
    ]);
  });

  it("does not record a correlation when the request is already pinned", async () => {
    const high = makeAccount({
      id: "11111111-1111-4111-8111-111111111111",
    });
    const { hub, stop, resolution } = makeHub([high]);
    hubs.push(stop);

    await hub.handle(
      makeRequest({
        "x-bb-account-pool-pin": high.id,
        "x-bb-account-pool-thread-id": "thread-abc",
      }),
      "codex",
      "/api/v1/plugins/account-pool/http",
    );

    expect(resolution.recorded).toEqual([]);
  });

  it("records the resolved account against an explicit path correlation, like the Codex auto-correlation route", async () => {
    const high = makeAccount({
      id: "11111111-1111-4111-8111-111111111111",
      priority: 1,
    });
    const { hub, stop, resolution } = makeHub([high]);
    hubs.push(stop);

    const response = await hub.handle(
      makeRequest(),
      "codex",
      "/api/v1/plugins/account-pool/http",
      { correlationThreadId: "thread-path-abc" },
    );

    expect(response.status).toBe(200);
    expect(resolution.recorded).toEqual([
      { threadId: "thread-path-abc", accountId: high.id },
    ]);
  });

  it("invokes onCorrelated once the resolution is recorded, so the caller can deregister the route", async () => {
    const high = makeAccount({
      id: "11111111-1111-4111-8111-111111111111",
    });
    const { hub, stop } = makeHub([high]);
    hubs.push(stop);
    let correlated = false;

    await hub.handle(makeRequest(), "codex", "/api/v1/plugins/account-pool/http", {
      correlationThreadId: "thread-path-abc",
      onCorrelated: () => {
        correlated = true;
      },
    });

    expect(correlated).toBe(true);
  });

  it("does not invoke onCorrelated when the request is pinned instead of correlated", async () => {
    const high = makeAccount({
      id: "11111111-1111-4111-8111-111111111111",
    });
    const { hub, stop } = makeHub([high]);
    hubs.push(stop);
    let correlated = false;

    await hub.handle(makeRequest(), "codex", "/api/v1/plugins/account-pool/http", {
      pinnedAccountId: high.id,
      onCorrelated: () => {
        correlated = true;
      },
    });

    expect(correlated).toBe(false);
  });
});
