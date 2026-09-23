import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { createNodeArcVoiceProcessSpawner } from "../src/process.js";

interface SignalCall {
  pid: number;
  signal: string | number | undefined;
}

const signalCalls: SignalCall[] = [];
let groupAlive = true;
const killSpy = vi.spyOn(process, "kill").mockImplementation(((
  pid: number,
  signal?: string | number,
) => {
  signalCalls.push({ pid, signal });
  if (pid < 0 && signal === 0 && !groupAlive) {
    const error = new Error("kill ESRCH") as NodeJS.ErrnoException;
    error.code = "ESRCH";
    throw error;
  }
  return true;
}) as never);

afterEach(() => {
  signalCalls.length = 0;
  groupAlive = true;
  spawnMock.mockReset();
});

afterAll(() => {
  killSpy.mockRestore();
});

function fakeChild(args: {
  pid?: number;
  exited?: boolean;
}): { childSignals: string[] } {
  const childSignals: string[] = [];
  spawnMock.mockReturnValue({
    pid: args.pid ?? 4242,
    exitCode: args.exited === true ? 0 : null,
    signalCode: null,
    kill(signal: string) {
      childSignals.push(signal);
      return true;
    },
    on() {},
  });
  return { childSignals };
}

describe("arc voice process spawner", () => {
  it("signals the process group while the direct child is alive", () => {
    fakeChild({});
    const handle = createNodeArcVoiceProcessSpawner().spawn({
      command: "/arc/voicebox-server",
      args: ["--port", "8787"],
      env: {},
    });

    expect(handle.kill("SIGTERM")).toBe(true);
    expect(signalCalls).toEqual([
      { pid: -4242, signal: 0 },
      { pid: -4242, signal: "SIGTERM" },
    ]);
  });

  it("refuses to signal any process group once the direct child has exited", () => {
    const { childSignals } = fakeChild({ exited: true });
    const handle = createNodeArcVoiceProcessSpawner().spawn({
      command: "/arc/voicebox-server",
      args: [],
      env: {},
    });

    expect(handle.kill("SIGTERM")).toBe(false);
    expect(handle.kill("SIGKILL")).toBe(false);
    expect(signalCalls).toEqual([]);
    expect(childSignals).toEqual([]);
  });

  it("falls back to the direct child when the group no longer exists", () => {
    groupAlive = false;
    const { childSignals } = fakeChild({});
    const handle = createNodeArcVoiceProcessSpawner().spawn({
      command: "/arc/voicebox-server",
      args: [],
      env: {},
    });

    expect(handle.kill("SIGTERM")).toBe(true);
    expect(signalCalls).toEqual([{ pid: -4242, signal: 0 }]);
    expect(childSignals).toEqual(["SIGTERM"]);
  });

  it("probes the group before force-killing residual members", () => {
    fakeChild({});
    const handle = createNodeArcVoiceProcessSpawner().spawn({
      command: "/arc/voicebox-server",
      args: [],
      env: {},
    });

    expect(handle.killResidualTree()).toBe(true);
    expect(signalCalls).toEqual([
      { pid: -4242, signal: 0 },
      { pid: -4242, signal: "SIGKILL" },
    ]);
  });

  it("does not force-kill a group that no longer exists", () => {
    groupAlive = false;
    fakeChild({});
    const handle = createNodeArcVoiceProcessSpawner().spawn({
      command: "/arc/voicebox-server",
      args: [],
      env: {},
    });

    expect(handle.killResidualTree()).toBe(false);
    expect(signalCalls).toEqual([{ pid: -4242, signal: 0 }]);
  });
});
