import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { AccountResolutionStore } from "./store.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function makeStore(now: () => number) {
  const dataDir = await mkdtemp(
    path.join(tmpdir(), "bb-account-resolution-store-"),
  );
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const host = createFakePluginHost({ pluginId: "account-pool", dataDir });
  return new AccountResolutionStore(host.bb.storage.kv, now);
}

describe("AccountResolutionStore", () => {
  it("returns null when nothing has been resolved for a thread", async () => {
    const store = await makeStore(() => 0);
    expect(await store.getResolved("thread-1")).toBeNull();
  });

  const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";

  it("returns the resolved account once and then clears it", async () => {
    const store = await makeStore(() => 1_000);
    await store.recordResolved("thread-1", ACCOUNT_A);

    expect(await store.getResolved("thread-1")).toEqual({
      accountId: ACCOUNT_A,
      resolvedAt: 1_000,
    });
    expect(await store.getResolved("thread-1")).toBeNull();
  });

  it("does not leak a resolution across threads", async () => {
    const store = await makeStore(() => 0);
    await store.recordResolved("thread-1", ACCOUNT_A);
    expect(await store.getResolved("thread-2")).toBeNull();
    expect(await store.getResolved("thread-1")).not.toBeNull();
  });

  it("discards an entry older than the TTL instead of returning stale data", async () => {
    let now = 0;
    const store = await makeStore(() => now);
    await store.recordResolved("thread-1", ACCOUNT_A);
    now = 10 * 60 * 1_000;
    expect(await store.getResolved("thread-1")).toBeNull();
  });
});
