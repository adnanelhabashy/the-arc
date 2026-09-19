import { describe, expect, it } from "vitest";
import {
  AccountPoolSource,
  createAccountPoolHttpRpcClient,
  type AccountPoolRpcClient,
} from "../src/arc-account/account-pool-source.js";
import { ArcAccountError } from "../src/arc-account/types.js";

interface PoolSummaryFixture {
  id: string;
  provider: "claude" | "codex";
  label: string;
  email: string | null;
  accountUuid?: string | null;
  codexAccountId?: string;
  subscriptionType?: string | null;
  enabled: boolean;
  status: "disabled" | "ready" | "held" | "exhausted" | "error";
}

function poolSummary(overrides: Partial<PoolSummaryFixture> = {}) {
  const fixture: PoolSummaryFixture = {
    id: "11111111-2222-3333-4444-555555555555",
    provider: "claude",
    label: "Claude Personal",
    email: "adnan@example.com",
    accountUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    subscriptionType: "max",
    enabled: true,
    status: "ready",
    ...overrides,
  };
  return fixture as unknown as Record<string, unknown>;
}

class StubRpc implements AccountPoolRpcClient {
  calls: Array<{ method: string; input: unknown }> = [];
  handlers = new Map<string, (input: unknown) => unknown>();
  fail: Error | null = null;

  async call(method: string, input: unknown): Promise<unknown> {
    this.calls.push({ method, input });
    if (this.fail !== null) throw this.fail;
    const handler = this.handlers.get(method);
    if (handler === undefined) throw new Error(`no stub for ${method}`);
    return handler(input);
  }
}

const NOW = 1_800_000_000_000;

function makeSource(rpc: AccountPoolRpcClient) {
  return new AccountPoolSource({ rpc, now: () => NOW });
}

describe("AccountPoolSource inventory mapping", () => {
  it("maps no accounts to an empty list", async () => {
    const rpc = new StubRpc();
    rpc.handlers.set("account.list", () => []);
    expect(await makeSource(rpc).listAccounts()).toEqual([]);
    expect(rpc.calls).toEqual([{ method: "account.list", input: null }]);
  });

  it("maps a ChatGPT account to Codex with the provider-issued canonical key", async () => {
    const rpc = new StubRpc();
    rpc.handlers.set("account.list", () => [
      poolSummary({
        id: "c0dex-account-1",
        provider: "codex",
        label: "ChatGPT Personal",
        email: "adnan@example.com",
        codexAccountId: "chatgpt-account-42",
        subscriptionType: "plus",
      }),
    ]);
    const [account] = await makeSource(rpc).listAccounts();
    expect(account).toMatchObject({
      id: "pool:c0dex-account-1",
      sourceId: "c0dex-account-1",
      sourceKind: "pool",
      providerFamily: "openai",
      providerLabel: "ChatGPT",
      accountKey: "openai:chatgpt:chatgpt-account-42",
      email: "adnan@example.com",
      planLabel: "plus",
      authState: "connected",
      enabled: true,
      availableThrough: ["codex"],
      observedAt: NOW,
    });
  });

  it("maps a Claude account to Claude Code with the Anthropic uuid as identity", async () => {
    const rpc = new StubRpc();
    rpc.handlers.set("account.list", () => [
      poolSummary({ subscriptionType: "team" }),
    ]);
    const [account] = await makeSource(rpc).listAccounts();
    expect(account).toMatchObject({
      providerFamily: "anthropic",
      providerLabel: "Claude",
      accountKey: "anthropic:account:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      planLabel: "team",
      availableThrough: ["claude-code"],
    });
  });

  it("keeps accounts with missing canonical identity distinct with null keys", async () => {
    const rpc = new StubRpc();
    rpc.handlers.set("account.list", () => [
      poolSummary({
        id: "unknown-1",
        email: "same@example.com",
        accountUuid: null,
      }),
      poolSummary({
        id: "unknown-2",
        email: "same@example.com",
        accountUuid: null,
      }),
    ]);
    const accounts = await makeSource(rpc).listAccounts();
    expect(accounts).toHaveLength(2);
    expect(accounts[0].accountKey).toBeNull();
    expect(accounts[1].accountKey).toBeNull();
    expect(accounts[0].id).not.toBe(accounts[1].id);
  });

  it("keeps same-email accounts with different canonical ids as two accounts", async () => {
    const rpc = new StubRpc();
    rpc.handlers.set("account.list", () => [
      poolSummary({
        id: "work-1",
        email: "adnan@example.com",
        accountUuid: "11111111-1111-1111-1111-111111111111",
      }),
      poolSummary({
        id: "personal-1",
        email: "adnan@example.com",
        accountUuid: "22222222-2222-2222-2222-222222222222",
      }),
    ]);
    const accounts = await makeSource(rpc).listAccounts();
    expect(accounts.map((entry) => entry.accountKey)).toEqual([
      "anthropic:account:11111111-1111-1111-1111-111111111111",
      "anthropic:account:22222222-2222-2222-2222-222222222222",
    ]);
  });

  it("represents disabled accounts as disabled and quota-held accounts as connected", async () => {
    const rpc = new StubRpc();
    rpc.handlers.set("account.list", () => [
      poolSummary({ id: "disabled-1", enabled: false, status: "disabled" }),
      poolSummary({
        id: "held-1",
        status: "held",
        subscriptionType: null,
      }),
      poolSummary({ id: "exhausted-1", status: "exhausted" }),
      poolSummary({ id: "error-1", status: "error" }),
    ]);
    const accounts = await makeSource(rpc).listAccounts();
    expect(accounts.map((entry) => entry.authState)).toEqual([
      "disabled",
      "connected",
      "connected",
      "error",
    ]);
    expect(accounts.find((entry) => entry.id === "pool:held-1")?.planLabel).toBeNull();
  });
});

describe("AccountPoolSource account operations", () => {
  it("getAccount returns the mapped account or throws account-not-found", async () => {
    const rpc = new StubRpc();
    rpc.handlers.set("account.list", () => [poolSummary()]);
    const source = makeSource(rpc);
    const account = await source.getAccount(
      "11111111-2222-3333-4444-555555555555",
    );
    expect(account.accountKey).toBe(
      "anthropic:account:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
    await expect(source.getAccount("missing")).rejects.toMatchObject({
      code: "account-not-found",
    });
  });

  it("enable/disable delegate to the pool without deleting anything", async () => {
    const rpc = new StubRpc();
    rpc.handlers.set("account.list", () => [poolSummary()]);
    rpc.handlers.set("account.disable", () => ({
      account: poolSummary({ enabled: false }),
    }));
    rpc.handlers.set("account.enable", () => ({
      account: poolSummary({ enabled: true }),
    }));
    const source = makeSource(rpc);
    const id = "11111111-2222-3333-4444-555555555555";

    const disabled = await source.setAccountEnabled(id, false);
    expect(disabled.enabled).toBe(false);
    const enabled = await source.setAccountEnabled(id, true);
    expect(enabled.enabled).toBe(true);
    expect(
      rpc.calls
        .map((call) => call.method)
        .filter((method) => method.startsWith("account.")),
    ).toEqual([
      "account.disable",
      "account.list",
      "account.enable",
      "account.list",
    ]);
  });

  it("enable of an unknown account throws account-not-found", async () => {
    const rpc = new StubRpc();
    rpc.handlers.set("account.list", () => []);
    rpc.handlers.set("account.enable", () => ({ account: null }));
    const source = makeSource(rpc);
    await expect(
      source.setAccountEnabled("missing", true),
    ).rejects.toMatchObject({ code: "account-not-found" });
    expect(rpc.calls.map((call) => call.method)).toEqual(["account.enable"]);
  });

  it("remove verifies existence first and delegates removal", async () => {
    const rpc = new StubRpc();
    rpc.handlers.set("account.list", () => [poolSummary()]);
    const removed: string[] = [];
    rpc.handlers.set("account.remove", (input) => {
      removed.push((input as { id: string }).id);
      return { removed: true };
    });
    const source = makeSource(rpc);
    await source.removeAccount("11111111-2222-3333-4444-555555555555");
    expect(removed).toEqual(["11111111-2222-3333-4444-555555555555"]);
    await expect(source.removeAccount("missing")).rejects.toMatchObject({
      code: "account-not-found",
    });
    expect(removed).toHaveLength(1);
  });

  it("priority and reorder use the pool's existing semantics", async () => {
    const rpc = new StubRpc();
    rpc.handlers.set("account.list", () => [poolSummary()]);
    rpc.handlers.set("account.setPriority", () => ({ account: poolSummary() }));
    const reorder: unknown[] = [];
    rpc.handlers.set("account.reorder", (input) => {
      reorder.push(input);
      return null;
    });
    const source = makeSource(rpc);
    await source.setAccountPriority(
      "11111111-2222-3333-4444-555555555555",
      7,
    );
    await source.reorderAccounts("openai", ["b", "a"]);
    await source.reorderAccounts("anthropic", ["c"]);
    expect(reorder).toEqual([
      { provider: "codex", accountIds: ["b", "a"] },
      { provider: "claude", accountIds: ["c"] },
    ]);
  });
});

describe("AccountPoolSource login flows", () => {
  it("starts a Codex device login with presentation data only", async () => {
    const rpc = new StubRpc();
    rpc.handlers.set("codexLogin.start", () => ({
      sessionId: "session-1",
      verificationUri: "https://chatgpt.com/connect",
      userCode: "ABCD-EFGH",
      expiresAt: NOW + 60_000,
      intervalMs: 1_000,
    }));
    const challenge = await makeSource(rpc).startOpenAiLogin();
    expect(challenge).toEqual({
      provider: "openai",
      sessionId: "session-1",
      verificationUri: "https://chatgpt.com/connect",
      userCode: "ABCD-EFGH",
      expiresAt: NOW + 60_000,
      intervalMs: 1_000,
    });
  });

  it("polls a Codex login through pending, complete, and error", async () => {
    const rpc = new StubRpc();
    const outcomes: unknown[] = [
      { status: "pending" },
      {
        status: "complete",
        account: poolSummary({
          provider: "codex",
          codexAccountId: "chatgpt-1",
        }),
      },
      { status: "error", message: "denied" },
    ];
    rpc.handlers.set("codexLogin.poll", () => outcomes.shift());
    const source = makeSource(rpc);

    const pending = await source.pollOpenAiLogin("session-1");
    expect(pending).toEqual({
      state: "waiting-for-user",
      account: null,
      message: null,
    });
    const complete = await source.pollOpenAiLogin("session-1");
    expect(complete.state).toBe("connected");
    expect(complete.account?.accountKey).toBe("openai:chatgpt:chatgpt-1");
    const failed = await source.pollOpenAiLogin("session-1");
    expect(failed).toEqual({
      state: "failed",
      account: null,
      message: "denied",
    });
    expect(rpc.calls.every((call) => call.method === "codexLogin.poll")).toBe(
      true,
    );
  });

  it("cancels a Codex login session through the pool", async () => {
    const rpc = new StubRpc();
    rpc.handlers.set("codexLogin.cancel", () => ({ cancelled: true }));
    await makeSource(rpc).cancelOpenAiLogin("session-1");
    expect(rpc.calls).toEqual([
      { method: "codexLogin.cancel", input: { sessionId: "session-1" } },
    ]);
  });

  it("starts a Claude OAuth login with the official authorize URL and no invented expiry", async () => {
    const rpc = new StubRpc();
    rpc.handlers.set("login.start", () => ({
      sessionId: "claude-session-1",
      authorizeUrl: "https://claude.ai/oauth/authorize?xyz",
    }));
    const challenge = await makeSource(rpc).startClaudeLogin();
    expect(challenge).toEqual({
      provider: "anthropic",
      sessionId: "claude-session-1",
      authorizeUrl: "https://claude.ai/oauth/authorize?xyz",
      expiresAt: null,
    });
  });

  it("completes a Claude login by pasting the provider callback", async () => {
    const rpc = new StubRpc();
    const pastes: unknown[] = [];
    rpc.handlers.set("login.complete", (input) => {
      pastes.push(input);
      return poolSummary();
    });
    const account = await makeSource(rpc).completeClaudeLogin(
      "claude-session-1",
      "https://console.anthropic.com/oauth/code/callback?code=abc&state=xyz",
    );
    expect(pastes).toEqual([
      {
        sessionId: "claude-session-1",
        pasted:
          "https://console.anthropic.com/oauth/code/callback?code=abc&state=xyz",
      },
    ]);
    expect(account.accountKey).toBe(
      "anthropic:account:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
  });
});

describe("AccountPoolSource exposes no secrets", () => {
  it("serialized accounts and challenges contain no credential material", async () => {
    const rpc = new StubRpc();
    rpc.handlers.set("account.list", () => [
      poolSummary(),
      poolSummary({
        id: "codex-1",
        provider: "codex",
        codexAccountId: "chatgpt-1",
      }),
    ]);
    rpc.handlers.set("codexLogin.start", () => ({
      sessionId: "session-1",
      verificationUri: "https://chatgpt.com/connect",
      userCode: "ABCD-EFGH",
      expiresAt: NOW + 60_000,
      intervalMs: 1_000,
    }));
    rpc.handlers.set("login.start", () => ({
      sessionId: "claude-session-1",
      authorizeUrl: "https://claude.ai/oauth/authorize?xyz",
    }));
    const source = makeSource(rpc);
    const serialized = JSON.stringify([
      await source.listAccounts(),
      await source.startOpenAiLogin(),
      await source.startClaudeLogin(),
    ]).toLowerCase();
    for (const forbidden of [
      "accesstoken",
      "access_token",
      "refreshtoken",
      "refresh_token",
      "authorization",
      "idtoken",
      "id_token",
      "apikey",
      "api_key",
      "api-key",
      "password",
      "secret",
      "pkce",
      "verifier",
      "cookie",
      "bearer",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("account pool HTTP RPC client", () => {
  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("posts to the plugin RPC route and unwraps the envelope", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = createAccountPoolHttpRpcClient({
      serverUrl: "http://127.0.0.1:38886/",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return jsonResponse(200, { ok: true, result: [] });
      },
    });
    expect(await client.call("account.list", null)).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(
      "http://127.0.0.1:38886/api/v1/plugins/account-pool/rpc/account.list",
    );
    expect(requests[0]!.init.method).toBe("POST");
    expect(
      (requests[0]!.init.headers as Record<string, string>)["content-type"],
    ).toBe("application/json");
  });

  it("maps 404/503 to account-source-unavailable", async () => {
    for (const status of [404, 503]) {
      const client = createAccountPoolHttpRpcClient({
        serverUrl: "http://127.0.0.1:38886",
        fetchImpl: async () => jsonResponse(status, { ok: false, error: "x" }),
      });
      await expect(client.call("account.list", null)).rejects.toMatchObject({
        code: "account-source-unavailable",
      });
    }
  });

  it("maps a 400 on codexLogin.poll to login-expired and other failures to unavailable", async () => {
    const expiredClient = createAccountPoolHttpRpcClient({
      serverUrl: "http://127.0.0.1:38886",
      fetchImpl: async () =>
        jsonResponse(400, {
          ok: false,
          error: { code: "invalid_input", message: "unknown session" },
        }),
    });
    await expect(
      expiredClient.call("codexLogin.poll", { sessionId: "gone" }),
    ).rejects.toMatchObject({ code: "login-expired" });

    const failedClient = createAccountPoolHttpRpcClient({
      serverUrl: "http://127.0.0.1:38886",
      fetchImpl: async () =>
        jsonResponse(500, { ok: false, error: "boom" }),
    });
    await expect(
      failedClient.call("account.list", null),
    ).rejects.toMatchObject({ code: "account-source-unavailable" });
  });

  it("maps transport failures and malformed envelopes to account-source-unavailable", async () => {
    const offline = createAccountPoolHttpRpcClient({
      serverUrl: "http://127.0.0.1:38886",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(offline.call("account.list", null)).rejects.toMatchObject({
      code: "account-source-unavailable",
    });

    const garbage = createAccountPoolHttpRpcClient({
      serverUrl: "http://127.0.0.1:38886",
      fetchImpl: async () =>
        new Response("not json", { status: 200 }),
    });
    await expect(garbage.call("account.list", null)).rejects.toMatchObject({
      code: "account-source-unavailable",
    });
  });

  it("ArcAccountError carries a stable code and detail", () => {
    const error = new ArcAccountError("account-not-found", "pool:missing");
    expect(error.code).toBe("account-not-found");
    expect(error.detail).toBe("pool:missing");
    expect(error.message).toContain("account-not-found");
  });
});
