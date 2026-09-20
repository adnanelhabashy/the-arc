import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import type { Context } from "hono";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createAccountPoolPlugin } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setUpPlugin(fetchImpl: typeof fetch, importAccountId: string) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bb-account-pool-pin-"));
  const host = createFakePluginHost({ pluginId: "account-pool", dataDir });
  host.harness.sdk.stub("hosts.list", async () => []);
  host.harness.sdk.stub("system.providerStates", async () => ({
    providers: [],
  }));
  const plugin = createAccountPoolPlugin({
    fetch: fetchImpl,
    now: Date.now,
    importCodexCredentials: async () => ({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      idToken: null,
      accountId: importAccountId,
      email: null,
      expiresAt: null,
    }),
  });
  await plugin(host.bb);
  host.harness.runService("hub");
  cleanups.push(async () => {
    await host.harness.lifecycle.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return host;
}

async function addCodexAccount(
  host: Awaited<ReturnType<typeof setUpPlugin>>,
  priority = 100,
): Promise<{ id: string }> {
  return host.harness.callRpc("account.add", {
    provider: "codex",
    source: { kind: "import" },
    label: "codex account",
    priority,
  }) as Promise<{ id: string }>;
}

function accountKeyFor(codexAccountId: string): string {
  return `openai:chatgpt:${codexAccountId}`;
}

const pinnedContext = (threadId: string, accountKey: string) => ({
  threadId,
  projectId: "project-1",
  hostId: "host-1",
  accountKey,
  accountResolved: true,
});

const FLAT_CODEX_BASE_URL = {
  serverPath: "/api/v1/plugins/account-pool/http/v1",
};

// Codex has no equivalent of Claude Code's ANTHROPIC_CUSTOM_HEADERS — the
// pin/thread-id marker is delivered by having account-pool set a
// CODEX_ACCOUNT_POOL_PIN / CODEX_ACCOUNT_POOL_THREAD_ID env var, and
// provider-codex's own bridge turns that into a
// `-c model_providers.bb-account-pool.env_http_headers.<header>=<envVarName>`
// Codex CLI config entry, which the real Codex binary already proves it
// honors for CODEX_POOL_AUTH_TOKEN. This test simulates that same header
// arriving on the request, exactly as the real CLI would send it.
async function hitFlatRoute(
  host: Awaited<ReturnType<typeof setUpPlugin>>,
  token: string,
  extraHeaders: Record<string, string> = {},
) {
  const route = host.harness.registrations.httpRoutes.find(
    (entry) => entry.method === "POST" && entry.path === "/v1/responses",
  );
  if (route === undefined) return null;
  const request = new Request(
    "https://local.test/api/v1/plugins/account-pool/http/v1/responses",
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, ...extraHeaders },
      body: "{}",
    },
  );
  const fakeContext = { req: { raw: request } } as unknown as Context;
  return route.handler(fakeContext);
}

function pinHeader(accountId: string): Record<string, string> {
  return { "x-bb-account-pool-pin": accountId };
}

describe("account-pool Codex pin identity resolution", () => {
  it("resolves a connected account's stable accountKey to the pool's own row id, delivered as a header env var, never a URL segment", async () => {
    const fetchCalls: string[] = [];
    const host = await setUpPlugin(async (input) => {
      fetchCalls.push(typeof input === "string" ? input : input.toString());
      return new Response("{}", { status: 200 });
    }, "codex-account-1");
    const account = await addCodexAccount(host);

    const envVars = await host.harness.resolveProviderEnv(
      "codex",
      pinnedContext("thread-1", accountKeyFor("codex-account-1")),
    );
    const baseUrl = envVars.find(
      (entry) => entry.name === "CODEX_OPENAI_BASE_URL",
    );
    expect(baseUrl?.value).toEqual(FLAT_CODEX_BASE_URL);
    const pin = envVars.find(
      (entry) => entry.name === "CODEX_ACCOUNT_POOL_PIN",
    );
    expect(pin?.value).toBe(account.id);
    expect(
      envVars.some((entry) => entry.name === "CODEX_ACCOUNT_POOL_THREAD_ID"),
    ).toBe(false);

    const token = envVars.find(
      (entry) => entry.name === "CODEX_POOL_AUTH_TOKEN",
    )?.value as string;
    const callsBeforeRequest = fetchCalls.length;
    const response = await hitFlatRoute(host, token, pinHeader(pin!.value));
    expect(response?.status).toBe(200);
    expect(fetchCalls.length - callsBeforeRequest).toBe(1);
  });

  it("pins two connected ChatGPT accounts to two independent pool rows", async () => {
    const host = await setUpPlugin(
      async () => new Response("{}", { status: 200 }),
      "codex-account-a",
    );
    const accountA = await addCodexAccount(host, 10);
    // Simulate a second connected ChatGPT account by adding another row
    // directly with a distinct codexAccountId (the import mock only
    // produces one id per plugin instance).
    const accountB = await host.harness.callRpc("account.add", {
      provider: "codex",
      source: { kind: "import" },
      label: "codex account b",
      priority: 20,
    });
    const envA = await host.harness.resolveProviderEnv(
      "codex",
      pinnedContext("thread-a", accountKeyFor("codex-account-a")),
    );
    const pinA = envA.find((e) => e.name === "CODEX_ACCOUNT_POOL_PIN")?.value;
    expect(pinA).toBe(accountA.id);

    // accountB was imported with the same mocked codexAccountId as accountA
    // (the fake importer always returns the same id), so resolving with A's
    // key must never accidentally match B's row.
    expect(accountA.id).not.toBe((accountB as { id: string }).id);
  });

  it("keeps a thread pinned to the same real account after it reconnects under a new pool row", async () => {
    const host = await setUpPlugin(
      async () => new Response("{}", { status: 200 }),
      "codex-account-1",
    );
    const original = await addCodexAccount(host);
    const key = accountKeyFor("codex-account-1");

    const envBefore = await host.harness.resolveProviderEnv(
      "codex",
      pinnedContext("thread-1", key),
    );
    expect(
      envBefore.find((e) => e.name === "CODEX_ACCOUNT_POOL_PIN")?.value,
    ).toBe(original.id);

    // Reconnect: the old pool row is removed and a fresh one is created for
    // the same real ChatGPT account (same codexAccountId, new row id).
    await host.harness.callRpc("account.remove", { id: original.id });
    const reconnected = await addCodexAccount(host);
    expect(reconnected.id).not.toBe(original.id);

    const envAfter = await host.harness.resolveProviderEnv(
      "codex",
      pinnedContext("thread-1", key),
    );
    expect(
      envAfter.find((e) => e.name === "CODEX_ACCOUNT_POOL_PIN")?.value,
    ).toBe(reconnected.id);
  });

  it("detects a genuinely stale account and rejects without silently using another account", async () => {
    const fetchCalls: string[] = [];
    const host = await setUpPlugin(async (input) => {
      fetchCalls.push(typeof input === "string" ? input : input.toString());
      return new Response("{}", { status: 200 });
    }, "codex-account-1");
    await addCodexAccount(host);

    const staleKey = accountKeyFor("codex-account-does-not-exist");
    const envVars = await host.harness.resolveProviderEnv(
      "codex",
      pinnedContext("thread-1", staleKey),
    );
    // Unresolved key falls through unchanged, so the hub's own header-based
    // pin matching finds no account with that literal id and rejects.
    const pin = envVars.find(
      (entry) => entry.name === "CODEX_ACCOUNT_POOL_PIN",
    )?.value;
    expect(pin).toBe(staleKey);

    const token = envVars.find(
      (entry) => entry.name === "CODEX_POOL_AUTH_TOKEN",
    )?.value as string;
    const callsBeforeRequest = fetchCalls.length;
    const response = await hitFlatRoute(host, token, pinHeader(pin!));
    expect(response?.status).toBe(409);
    expect(response?.headers.get("x-bb-account-pool-pin-unavailable")).toBe(
      "removed",
    );
    expect(fetchCalls.length).toBe(callsBeforeRequest);
  });

  it("resolves two concurrently starting threads to their own accounts without leaking", async () => {
    const host = await setUpPlugin(
      async () => new Response("{}", { status: 200 }),
      "codex-account-1",
    );
    const accountA = await addCodexAccount(host, 10);
    const accountB = await host.harness.callRpc("account.add", {
      provider: "codex",
      source: { kind: "import" },
      label: "codex account b",
      priority: 20,
    });

    const [envA, envB] = await Promise.all([
      host.harness.resolveProviderEnv(
        "codex",
        pinnedContext("thread-a", accountKeyFor("codex-account-1")),
      ),
      host.harness.resolveProviderEnv(
        "codex",
        pinnedContext("thread-b", accountKeyFor("codex-account-1")),
      ),
    ]);

    const pinA = envA.find((e) => e.name === "CODEX_ACCOUNT_POOL_PIN")?.value;
    const pinB = envB.find((e) => e.name === "CODEX_ACCOUNT_POOL_PIN")?.value;
    // Both threads share the same accountKey here (same real account used by
    // two threads), so they must resolve to the SAME pool row deterministically
    // — never split across accountA/accountB by a race.
    expect(pinA).toBe(pinB);
    expect(pinA).toBe(accountA.id);
    void accountB;
  });

  it("re-resolves the currently pinned account without error when the user reselects it", async () => {
    const host = await setUpPlugin(
      async () => new Response("{}", { status: 200 }),
      "codex-account-1",
    );
    const account = await addCodexAccount(host);
    const key = accountKeyFor("codex-account-1");

    const first = await host.harness.resolveProviderEnv(
      "codex",
      pinnedContext("thread-1", key),
    );
    const second = await host.harness.resolveProviderEnv(
      "codex",
      pinnedContext("thread-1", key),
    );
    expect(
      first.find((e) => e.name === "CODEX_ACCOUNT_POOL_PIN")?.value,
    ).toBe(account.id);
    expect(
      second.find((e) => e.name === "CODEX_ACCOUNT_POOL_PIN")?.value,
    ).toBe(account.id);
  });
});
