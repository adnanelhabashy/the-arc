import {
  createConnection,
  createProject,
  createThread,
  getThreadAccountState,
  migrate,
  noopNotifier,
  setThreadAccount,
  upsertHost,
} from "@bb/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadProvisioningDeps } from "../../src/services/threads/thread-provisioning-environment.js";
import { checkAccountAutoResolution } from "../../src/services/threads/thread-provisioning.js";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, { name: "test-host" });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/source" },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    environmentId: null,
    providerId: "codex",
    status: "starting",
  });
  const deps = {
    db,
    config: { serverPort: 39812 },
    logger: { debug: () => {}, warn: () => {}, error: () => {}, info: () => {} },
  } as unknown as ThreadProvisioningDeps;
  return { db, deps, thread };
}

function stubResolvedAccount(accountId: string | null): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toContain(
        "/api/v1/plugins/account-pool/rpc/account.getResolved",
      );
      return new Response(JSON.stringify({ ok: true, result: { accountId } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function stubUnavailable(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 503 })),
  );
}

describe("account auto-resolution persistence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists the account the pool resolved for an Auto thread, marking it resolved", async () => {
    const { db, deps, thread } = setup();
    expect(getThreadAccountState(db, thread.id)).toEqual({
      accountKey: null,
      accountResolved: null,
    });
    stubResolvedAccount("acct-x");

    await checkAccountAutoResolution(deps, thread.id, 0);

    expect(getThreadAccountState(db, thread.id)).toEqual({
      accountKey: "acct-x",
      accountResolved: true,
    });
  });

  it("does nothing when the pool has not resolved an account yet", async () => {
    const { db, deps, thread } = setup();
    stubResolvedAccount(null);

    await checkAccountAutoResolution(deps, thread.id, 0);

    expect(getThreadAccountState(db, thread.id)).toEqual({
      accountKey: null,
      accountResolved: null,
    });
  });

  it("does not clobber an account the user already picked in the meantime (double-write guard)", async () => {
    const { db, deps, thread } = setup();
    setThreadAccount(db, {
      threadId: thread.id,
      accountKey: "user-picked",
      accountResolved: true,
    });
    stubResolvedAccount("acct-x");

    await checkAccountAutoResolution(deps, thread.id, 0);

    expect(getThreadAccountState(db, thread.id)).toEqual({
      accountKey: "user-picked",
      accountResolved: true,
    });
  });

  it("surfaces the failure to its caller (which swallows it) when the account pool is unavailable, without writing anything", async () => {
    const { db, deps, thread } = setup();
    stubUnavailable();

    await expect(checkAccountAutoResolution(deps, thread.id, 0)).rejects.toThrow();

    expect(getThreadAccountState(db, thread.id)).toEqual({
      accountKey: null,
      accountResolved: null,
    });
  });
});
