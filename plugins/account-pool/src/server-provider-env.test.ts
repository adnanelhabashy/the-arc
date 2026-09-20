import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createAccountPoolPlugin } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const CLAUDE_ACCOUNT_UUID = "11111111-2222-4333-8444-555555555555";
const CODEX_ACCOUNT_ID = "3f44bc64-d00e-4cab-8a5e-47f3bcbf9b9b";

async function setUpPlugin() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bb-account-pool-env-"));
  const host = createFakePluginHost({ pluginId: "account-pool", dataDir });
  host.harness.sdk.stub("hosts.list", async () => []);
  host.harness.sdk.stub("system.providerStates", async () => ({
    providers: [],
  }));
  const plugin = createAccountPoolPlugin({
    fetch: async () => new Response(null, { status: 200 }),
    now: Date.now,
    importCredentials: async () => ({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: null,
      subscriptionType: "max",
      rateLimitTier: null,
      email: null,
      accountUuid: CLAUDE_ACCOUNT_UUID,
    }),
    importCodexCredentials: async () => ({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      idToken: null,
      accountId: CODEX_ACCOUNT_ID,
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

async function envFor(
  host: FakePluginHost,
  providerId: string,
  accountKey: string | null,
): Promise<Record<string, string>> {
  const entries = await host.harness.resolveProviderEnv(providerId, {
    threadId: "thr-env-1",
    projectId: "project-1",
    hostId: "host-1",
    accountKey,
    accountResolved: accountKey !== null,
  });
  return Object.fromEntries(
    entries.map((entry) => [
      entry.name,
      typeof entry.value === "string" ? entry.value : entry.value.serverPath,
    ]),
  );
}

describe("Account Pool provider environment per thread account", () => {
  it("pins Claude Code to the thread's Claude account", async () => {
    const host = await setUpPlugin();
    const added = (await host.harness.callRpc("account.add", {
      provider: "claude",
      source: { kind: "import" },
      label: "claude account",
      priority: 100,
    })) as { id: string };

    const env = await envFor(
      host,
      "claude-code",
      `anthropic:account:${CLAUDE_ACCOUNT_UUID}`,
    );
    expect(env.ANTHROPIC_BASE_URL).toBe(
      "/api/v1/plugins/account-pool/http",
    );
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeTruthy();
    // The pin the hub routes by is the live pool row id, not the canonical
    // key the thread stores.
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      `x-bb-account-pool-pin: ${added.id}`,
    );
    expect(env.ANTHROPIC_CUSTOM_HEADERS).not.toContain(CLAUDE_ACCOUNT_UUID);
  });

  it("correlates an Auto Claude thread instead of pinning it", async () => {
    const host = await setUpPlugin();
    await host.harness.callRpc("account.add", {
      provider: "claude",
      source: { kind: "import" },
      label: "claude account",
      priority: 100,
    });
    const env = await envFor(host, "claude-code", null);
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      "x-bb-account-pool-thread-id: thr-env-1",
    );
  });

  it("fails a Claude thread closed when its account is gone", async () => {
    const host = await setUpPlugin();
    await host.harness.callRpc("account.add", {
      provider: "claude",
      source: { kind: "import" },
      label: "claude account",
      priority: 100,
    });
    const env = await envFor(
      host,
      "claude-code",
      "anthropic:account:99999999-9999-4999-8999-999999999999",
    );
    // The raw key reaches the hub, whose own "removed" 409 fires; Arc never
    // substitutes a different account.
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      "x-bb-account-pool-pin: anthropic:account:99999999-9999-4999-8999-999999999999",
    );
  });

  it("pins Codex to the thread's ChatGPT account", async () => {
    const host = await setUpPlugin();
    const added = (await host.harness.callRpc("account.add", {
      provider: "codex",
      source: { kind: "import" },
      label: "codex account",
      priority: 100,
    })) as { id: string };

    const env = await envFor(
      host,
      "codex",
      `openai:chatgpt:${CODEX_ACCOUNT_ID}`,
    );
    expect(env.CODEX_ACCOUNT_POOL_PIN).toBe(added.id);
    expect(env.CODEX_ACCOUNT_POOL_THREAD_ID).toBeUndefined();
  });

  it("correlates an Auto Codex thread instead of pinning it", async () => {
    const host = await setUpPlugin();
    await host.harness.callRpc("account.add", {
      provider: "codex",
      source: { kind: "import" },
      label: "codex account",
      priority: 100,
    });
    const env = await envFor(host, "codex", null);
    expect(env.CODEX_ACCOUNT_POOL_THREAD_ID).toBe("thr-env-1");
    expect(env.CODEX_ACCOUNT_POOL_PIN).toBeUndefined();
  });

  it("keeps a reconnect's new row id usable for an already-pinned thread", async () => {
    const host = await setUpPlugin();
    const first = (await host.harness.callRpc("account.add", {
      provider: "codex",
      source: { kind: "import" },
      label: "codex account",
      priority: 100,
    })) as { id: string };
    await host.harness.callRpc("account.remove", { id: first.id });
    const second = (await host.harness.callRpc("account.add", {
      provider: "codex",
      source: { kind: "import" },
      label: "codex account",
      priority: 100,
    })) as { id: string };

    expect(second.id).not.toBe(first.id);
    const env = await envFor(
      host,
      "codex",
      `openai:chatgpt:${CODEX_ACCOUNT_ID}`,
    );
    expect(env.CODEX_ACCOUNT_POOL_PIN).toBe(second.id);
  });
});
