import { setTimeout as sleep } from "node:timers/promises";
import { setThreadAccount } from "@bb/db";
import { describe, expect, it } from "vitest";
import { listQueuedThreadCommands } from "../helpers/commands.js";
import { seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const PLUS_ACCOUNT = "openai:chatgpt:3f44bc64-d00e-4cab-8a5e-47f3bcbf9b9b";
const TEAM_ACCOUNT = "openai:chatgpt:63238aa3-38a8-41b0-884a-d827a4a43eda";

interface PatchThreadAccountArgs {
  accountKey: string | null;
  harness: TestAppHarness;
  threadId: string;
}

async function patchThreadAccount(
  args: PatchThreadAccountArgs,
): Promise<Response> {
  return args.harness.app.request(`/api/v1/threads/${args.threadId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountKey: args.accountKey }),
  });
}

function releasedStopCommands(args: {
  harness: TestAppHarness;
  threadId: string;
}) {
  return listQueuedThreadCommands(
    args.harness,
    "thread.stop",
    args.threadId,
  ).filter(
    (command) => command.type === "thread.stop" && command.intent === "release",
  );
}

describe("thread account change", () => {
  it("drops the loaded runtime so the next turn launches with the new account", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "idle" },
      });
      setThreadAccount(harness.db, {
        threadId: thread.id,
        accountKey: PLUS_ACCOUNT,
        accountResolved: true,
      });

      const response = await patchThreadAccount({
        harness,
        threadId: thread.id,
        accountKey: TEAM_ACCOUNT,
      });

      expect(response.status).toBe(200);
      await expect
        .poll(() => releasedStopCommands({ harness, threadId: thread.id }).length)
        .toBe(1);
    });
  });

  it("keeps the runtime when the account did not change", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "idle" },
      });
      setThreadAccount(harness.db, {
        threadId: thread.id,
        accountKey: PLUS_ACCOUNT,
        accountResolved: true,
      });

      const response = await patchThreadAccount({
        harness,
        threadId: thread.id,
        accountKey: PLUS_ACCOUNT,
      });

      expect(response.status).toBe(200);
      await sleep(50);
      expect(releasedStopCommands({ harness, threadId: thread.id })).toEqual([]);
    });
  });

  it("leaves a running turn on its account instead of releasing under it", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "active" },
      });
      setThreadAccount(harness.db, {
        threadId: thread.id,
        accountKey: PLUS_ACCOUNT,
        accountResolved: true,
      });

      const response = await patchThreadAccount({
        harness,
        threadId: thread.id,
        accountKey: TEAM_ACCOUNT,
      });

      expect(response.status).toBe(200);
      await sleep(50);
      expect(releasedStopCommands({ harness, threadId: thread.id })).toEqual([]);
    });
  });
});
