import { execFile } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import {
  createNodeArcVoiceProcessSpawner,
  type ArcVoiceProcess,
} from "../../src/process.js";

const ORPHANING_CHILD = [
  'const { spawn } = require("node:child_process");',
  'spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });',
  "process.exit(0);",
].join("\n");

const LEADING_CHILD = [
  'const { spawn } = require("node:child_process");',
  'spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });',
  "setTimeout(() => {}, 60000);",
].join("\n");

const handles: ArcVoiceProcess[] = [];

function spawnChild(script: string): ArcVoiceProcess {
  const handle = createNodeArcVoiceProcessSpawner().spawn({
    command: process.execPath,
    args: ["-e", script],
    env: process.env,
  });
  handles.push(handle);
  return handle;
}

function waitForClose(handle: ArcVoiceProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    handle.onClose(() => resolve());
  });
}

function groupIsGone(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch {
    return true;
  }
}

function groupMembers(pgid: number): Promise<number[]> {
  return new Promise<number[]>((resolve) => {
    execFile("pgrep", ["-g", String(pgid)], (error, stdout) => {
      if (error !== null) {
        resolve([]);
        return;
      }
      resolve(
        String(stdout)
          .split("\n")
          .map((line) => Number(line.trim()))
          .filter((value) => Number.isInteger(value) && value > 0),
      );
    });
  });
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error("condition was not met before the timeout");
}

afterAll(async () => {
  for (const handle of handles.splice(0)) {
    if (handle.pid !== undefined && !groupIsGone(handle.pid)) {
      handle.killResidualTree();
    }
  }
});

describe("arc voice process group ownership", () => {
  it("refuses to signal a group whose leader has already exited", async () => {
    const handle = spawnChild(ORPHANING_CHILD);
    const pgid = handle.pid as number;
    expect(pgid).toBeGreaterThan(0);

    const closed = waitForClose(handle);
    await closed;
    expect(handle.hasExited()).toBe(true);

    const members = await groupMembers(pgid);
    expect(members.length).toBeGreaterThan(0);

    expect(handle.kill("SIGTERM")).toBe(false);
    expect(handle.kill("SIGKILL")).toBe(false);
    expect(await groupMembers(pgid)).toEqual(members);

    expect(handle.killResidualTree()).toBe(true);
    await waitFor(async () => groupIsGone(pgid), 10_000);
    expect(await groupMembers(pgid)).toEqual([]);
  }, 60_000);

  it("kills the whole group while the direct child still leads it", async () => {
    const handle = spawnChild(LEADING_CHILD);
    const pgid = handle.pid as number;

    await waitFor(async () => (await groupMembers(pgid)).length >= 2, 10_000);
    expect(handle.hasExited()).toBe(false);

    expect(handle.kill("SIGTERM")).toBe(true);
    await waitFor(async () => groupIsGone(pgid), 10_000);
    expect(await groupMembers(pgid)).toEqual([]);
  }, 60_000);
});
