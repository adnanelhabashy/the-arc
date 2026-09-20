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

async function setUpPlugin(fetchImpl: typeof fetch) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bb-account-pool-auto-"));
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
      accountId: "codex-account-1",
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
  const account = await host.harness.callRpc("account.add", {
    provider: "codex",
    source: { kind: "import" },
    label: "codex account",
    priority: 100,
  });
  return { host, account: account as { id: string } };
}

const autoContext = (threadId: string) => ({
  threadId,
  projectId: "project-1",
  hostId: "host-1",
  accountKey: null,
  accountResolved: false,
});

async function hitFlatRoute(
  host: Awaited<ReturnType<typeof setUpPlugin>>["host"],
  token: string,
  threadId: string,
) {
  const route = host.harness.registrations.httpRoutes.find(
    (entry) => entry.method === "POST" && entry.path === "/v1/responses",
  );
  if (route === undefined) return null;
  const request = new Request(
    "https://local.test/api/v1/plugins/account-pool/http/v1/responses",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-bb-account-pool-thread-id": threadId,
      },
      body: "{}",
    },
  );
  const fakeContext = { req: { raw: request } } as unknown as Context;
  return route.handler(fakeContext);
}

describe("account-pool Codex Auto-mode correlation", () => {
  it("carries the thread id as a header env var, on the same flat URL as a pinned thread, never a path segment", async () => {
    const { host } = await setUpPlugin(
      async () => new Response("{}", { status: 200 }),
    );
    const envVars = await host.harness.resolveProviderEnv(
      "codex",
      autoContext("thread-1"),
    );
    expect(
      envVars.find((entry) => entry.name === "CODEX_OPENAI_BASE_URL")?.value,
    ).toEqual({ serverPath: "/api/v1/plugins/account-pool/http/v1" });
    expect(
      envVars.find((entry) => entry.name === "CODEX_ACCOUNT_POOL_THREAD_ID")
        ?.value,
    ).toBe("thread-1");
    expect(
      envVars.some((entry) => entry.name === "CODEX_ACCOUNT_POOL_PIN"),
    ).toBe(false);
  });

  it("does not collide when two threads start Auto-mode concurrently", async () => {
    const { host } = await setUpPlugin(
      async () => new Response("{}", { status: 200 }),
    );
    const [envA, envB] = await Promise.all([
      host.harness.resolveProviderEnv("codex", autoContext("thread-a")),
      host.harness.resolveProviderEnv("codex", autoContext("thread-b")),
    ]);
    expect(
      envA.find((e) => e.name === "CODEX_ACCOUNT_POOL_THREAD_ID")?.value,
    ).toBe("thread-a");
    expect(
      envB.find((e) => e.name === "CODEX_ACCOUNT_POOL_THREAD_ID")?.value,
    ).toBe("thread-b");
  });

  it("resolves an Auto thread to the concrete account the hub picked, correlated purely via the header", async () => {
    const { host, account } = await setUpPlugin(
      async () => new Response("{}", { status: 200 }),
    );
    const envVars = await host.harness.resolveProviderEnv(
      "codex",
      autoContext("thread-1"),
    );
    const token = envVars.find(
      (entry) => entry.name === "CODEX_POOL_AUTH_TOKEN",
    )?.value as string;

    const response = await hitFlatRoute(host, token, "thread-1");
    expect(response?.status).toBe(200);

    const resolved = (await host.harness.callRpc("account.getResolved", {
      threadId: "thread-1",
    })) as { accountId: string | null };
    expect(resolved.accountId).toBe(account.id);
  });
});
