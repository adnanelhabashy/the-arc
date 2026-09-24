import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ArcVoiceLoopbackViolationError } from "../src/binding.js";
import {
  createArcVoiceClient,
  type ArcVoiceClient,
  type ArcVoiceHttpClient,
} from "../src/client.js";
import { createStubArcVoiceClient } from "./stub-client.js";
import type { ArcVoiceHealthResult } from "../src/health.js";
import type {
  ArcVoiceAdoptedProcessFactory,
  ArcVoiceAdoptedProcessRequest,
  ArcVoiceOwnershipQuery,
  ArcVoiceOwnershipVerdict,
  ArcVoiceProcessFingerprint,
} from "../src/ownership.js";
import { createArcVoicePaths } from "../src/paths.js";
import type {
  ArcVoiceProcess,
  ArcVoiceProcessSpawnArgs,
  ArcVoiceProcessSpawner,
} from "../src/process.js";
import {
  ArcVoiceRuntimeManager,
  VOICEBOX_BACKEND_VARIANT_ENV,
  VOICEBOX_MODELS_DIR_ENV,
  buildVoiceboxEnvironment,
  buildVoiceboxLaunchArgs,
  createArcVoiceOrphanGuard,
  resolveVoiceboxBackendVariant,
  scheduleArcVoiceTimeout,
  type ArcVoiceLaunchConfig,
  type ArcVoiceOrphanGuard,
  type ArcVoiceRuntimeExitEvent,
  type ArcVoiceRuntimeManagerArgs,
  type ArcVoiceTimeoutScheduler,
} from "../src/runtime-manager.js";

const userDataPath = join("/", "arc-user-data");
const paths = createArcVoicePaths({ userDataPath });
const encoder = new TextEncoder();

const launchConfig: ArcVoiceLaunchConfig = {
  command: paths.executablePath,
  port: 8787,
  backend: "cuda",
  modelsDir: paths.modelsRoot,
  dataDir: paths.stateRoot,
  parentPid: 4242,
};

interface FakeProcessHandle {
  process: ArcVoiceProcess;
  kills: NodeJS.Signals[];
  residualKills: () => number;
  close(code?: number | null): void;
}

function createFakeProcess(args: {
  pid?: number;
  closeOn?: NodeJS.Signals;
  residualTreeKill?: boolean;
}): FakeProcessHandle {
  const closeListeners: ((
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => void)[] = [];
  const kills: NodeJS.Signals[] = [];
  let residualKills = 0;
  let exited = false;
  const close = (code: number | null = 0): void => {
    exited = true;
    for (const listener of closeListeners) {
      listener(code, null);
    }
  };
  return {
    kills,
    close,
    residualKills: () => residualKills,
    process: {
      pid: args.pid,
      kill(signal) {
        kills.push(signal);
        if (args.closeOn === signal) {
          close();
        }
        return true;
      },
      killResidualTree() {
        if (args.residualTreeKill !== true) {
          return false;
        }
        residualKills += 1;
        return true;
      },
      hasExited: () => exited,
      onError() {},
      onClose(listener) {
        closeListeners.push(listener);
      },
    },
  };
}

function createFakeSpawner(...processes: ArcVoiceProcess[]): {
  spawner: ArcVoiceProcessSpawner;
  calls: ArcVoiceProcessSpawnArgs[];
} {
  const calls: ArcVoiceProcessSpawnArgs[] = [];
  let index = 0;
  return {
    calls,
    spawner: {
      spawn(args) {
        calls.push(args);
        const next = processes[Math.min(index, processes.length - 1)];
        index += 1;
        return next;
      },
    },
  };
}

const signalSpy = vi.spyOn(process, "kill");
const exitListenersAtLoad = process.listenerCount("exit");

afterAll(() => {
  signalSpy.mockRestore();
});

function createInertGuard(): ArcVoiceOrphanGuard {
  return createArcVoiceOrphanGuard({ subscribeExit: () => () => {} });
}

function deferredTimeout(): ArcVoiceTimeoutScheduler {
  return (_timeoutMs, onTimeout) => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        onTimeout();
      }
    });
    return () => {
      cancelled = true;
    };
  };
}

function createManager(
  args: Omit<ArcVoiceRuntimeManagerArgs, "guard"> & {
    guard?: ArcVoiceOrphanGuard;
  },
): ArcVoiceRuntimeManager {
  return new ArcVoiceRuntimeManager({
    guard: createInertGuard(),
    scheduleTimeout: deferredTimeout(),
    ...args,
  });
}

const unusedClient: ArcVoiceClient = {
  ...createStubArcVoiceClient(),
  listProfiles: () => Promise.resolve({ kind: "ok", value: [] }),
};

function healthy(): Promise<ArcVoiceHealthResult> {
  return Promise.resolve({ kind: "healthy", detail: "ready" });
}

function unhealthy(): Promise<ArcVoiceHealthResult> {
  return Promise.resolve({ kind: "unhealthy", detail: "not ready" });
}

function deferredSleep(): {
  sleep: (ms: number) => Promise<void>;
  flush: () => void;
} {
  const waiting: (() => void)[] = [];
  return {
    sleep: () =>
      new Promise<void>((resolve) => {
        waiting.push(resolve);
      }),
    flush: () => {
      for (const resolve of waiting.splice(0)) {
        resolve();
      }
    },
  };
}

describe("buildVoiceboxLaunchArgs", () => {
  it("binds the runtime to loopback on the Arc-managed port", () => {
    expect(buildVoiceboxLaunchArgs(launchConfig)).toEqual([
      "--host",
      "127.0.0.1",
      "--port",
      "8787",
      "--data-dir",
      join(userDataPath, "voice", "state"),
      "--parent-pid",
      "4242",
    ]);
  });

  it("omits the parent watchdog and data dir when they are not configured", () => {
    const { dataDir: _dataDir, parentPid: _parentPid, ...rest } = launchConfig;
    expect(buildVoiceboxLaunchArgs(rest)).toEqual([
      "--host",
      "127.0.0.1",
      "--port",
      "8787",
    ]);
  });

  it("refuses a non-loopback host", () => {
    expect(() =>
      buildVoiceboxLaunchArgs({ ...launchConfig, host: "0.0.0.0" }),
    ).toThrow(ArcVoiceLoopbackViolationError);
  });
});

describe("buildVoiceboxEnvironment", () => {
  it("redirects model storage under the Arc-owned data directory", () => {
    const env = buildVoiceboxEnvironment(launchConfig, { PATH: "/usr/bin" });

    expect(env.PATH).toBe("/usr/bin");
    expect(env[VOICEBOX_MODELS_DIR_ENV]).toBe(
      join(userDataPath, "voice", "models"),
    );
    expect(env[VOICEBOX_MODELS_DIR_ENV]?.startsWith(userDataPath)).toBe(true);
    expect(env[VOICEBOX_BACKEND_VARIANT_ENV]).toBe("cuda");
  });

  it("reports only the backend variants Voicebox defines", () => {
    expect(resolveVoiceboxBackendVariant("cuda")).toBe("cuda");
    expect(resolveVoiceboxBackendVariant("rocm")).toBe("rocm");
    expect(resolveVoiceboxBackendVariant("mlx")).toBeUndefined();
    expect(resolveVoiceboxBackendVariant("xpu")).toBeUndefined();
    expect(resolveVoiceboxBackendVariant("directml")).toBeUndefined();
    expect(resolveVoiceboxBackendVariant("cpu")).toBeUndefined();

    const env = buildVoiceboxEnvironment({ ...launchConfig, backend: "mlx" });
    expect(env[VOICEBOX_BACKEND_VARIANT_ENV]).toBeUndefined();
  });
});

describe("ArcVoiceRuntimeManager", () => {
  it("launches through the injected spawner with loopback-only arguments", async () => {
    const fake = createFakeProcess({ pid: 4242, closeOn: "SIGTERM" });
    const { spawner, calls } = createFakeSpawner(fake.process);
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck: healthy,
      sleep: () => Promise.resolve(),
    });

    const result = await manager.launch(launchConfig);

    expect(result).toEqual({
      kind: "launched",
      detail: expect.any(String),
      pid: 4242,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(paths.executablePath);
    expect(calls[0].args).toEqual([
      "--host",
      "127.0.0.1",
      "--port",
      "8787",
      "--data-dir",
      join(userDataPath, "voice", "state"),
      "--parent-pid",
      "4242",
    ]);
    expect(calls[0].args).not.toContain("0.0.0.0");
    expect(calls[0].env[VOICEBOX_MODELS_DIR_ENV]).toBe(
      join(userDataPath, "voice", "models"),
    );
    expect(manager.status()).toEqual({ state: "starting", pid: 4242 });
  });

  it("hands the host pid to the runtime's parent watchdog by default", async () => {
    const fake = createFakeProcess({ pid: 4242 });
    const { spawner, calls } = createFakeSpawner(fake.process);
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck: healthy,
    });
    const { parentPid: _parentPid, ...withoutParentPid } = launchConfig;

    await manager.launch(withoutParentPid);

    expect(calls[0].args).toContain("--parent-pid");
    expect(calls[0].args[calls[0].args.indexOf("--parent-pid") + 1]).toBe(
      String(process.pid),
    );
  });

  it("omits the parent watchdog when the caller disables it", async () => {
    const fake = createFakeProcess({ pid: 4242 });
    const { spawner, calls } = createFakeSpawner(fake.process);
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck: healthy,
    });

    await manager.launch({ ...launchConfig, parentWatchdog: false });

    expect(calls[0].args).not.toContain("--parent-pid");
  });

  it("refuses to launch bound to a non-loopback host", async () => {
    const fake = createFakeProcess({ pid: 4242 });
    const { spawner, calls } = createFakeSpawner(fake.process);
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck: healthy,
    });

    await expect(
      manager.launch({ ...launchConfig, host: "0.0.0.0" }),
    ).rejects.toThrow(ArcVoiceLoopbackViolationError);
    expect(calls).toHaveLength(0);
    expect(manager.status().state).toBe("stopped");
  });

  it("does not spawn a second process while one is tracked", async () => {
    const fake = createFakeProcess({ pid: 4242 });
    const { spawner, calls } = createFakeSpawner(fake.process);
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck: healthy,
    });

    await manager.launch(launchConfig);
    const second = await manager.launch(launchConfig);

    expect(second.kind).toBe("failed");
    expect(calls).toHaveLength(1);
  });

  it("waits for the injected health check before reporting ready", async () => {
    const fake = createFakeProcess({ pid: 4242, closeOn: "SIGTERM" });
    const { spawner } = createFakeSpawner(fake.process);
    const healthCheck = vi
      .fn<() => Promise<ArcVoiceHealthResult>>()
      .mockResolvedValueOnce({ kind: "unhealthy", detail: "starting" })
      .mockResolvedValue({ kind: "healthy", detail: "ready" });
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck,
      sleep: () => Promise.resolve(),
    });

    const result = await manager.start(launchConfig, {
      timeoutMs: 5_000,
      intervalMs: 10,
    });

    expect(result).toEqual({ kind: "ready", detail: "ready" });
    expect(healthCheck).toHaveBeenCalledTimes(2);
    expect(manager.status()).toEqual({ state: "ready", pid: 4242 });
  });

  it("stops the runtime when readiness never arrives", async () => {
    const fake = createFakeProcess({ pid: 4242, closeOn: "SIGTERM" });
    const { spawner } = createFakeSpawner(fake.process);
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck: unhealthy,
      sleep: () => Promise.resolve(),
    });

    const result = await manager.start(launchConfig, { timeoutMs: 0 });

    expect(result).toEqual({ kind: "timeout", detail: "not ready" });
    expect(fake.kills).toEqual(["SIGTERM"]);
    expect(manager.status().state).toBe("failed");
    expect(manager.status().lastError).toBe("not ready");
  });

  it("terminates the tracked process and clears orphan guarding on stop", async () => {
    const fake = createFakeProcess({ pid: 4242, closeOn: "SIGTERM" });
    const { spawner } = createFakeSpawner(fake.process);
    const exitListeners: (() => void)[] = [];
    const guard = createArcVoiceOrphanGuard({
      subscribeExit: (listener) => {
        exitListeners.push(listener);
        return () => {
          exitListeners.splice(exitListeners.indexOf(listener), 1);
        };
      },
    });
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck: healthy,
      guard,
      sleep: () => Promise.resolve(),
    });

    await manager.launch(launchConfig);
    expect(guard.trackedPid()).toBe(4242);
    expect(exitListeners).toHaveLength(1);

    const result = await manager.stop();

    expect(result).toEqual({ kind: "stopped", detail: expect.any(String) });
    expect(fake.kills).toEqual(["SIGTERM"]);
    expect(guard.trackedPid()).toBeUndefined();
    expect(exitListeners).toHaveLength(0);
    expect(manager.status()).toEqual({ state: "stopped" });
  });

  it("force-kills child processes that outlive the runtime exit", async () => {
    const fake = createFakeProcess({
      pid: 4242,
      closeOn: "SIGTERM",
      residualTreeKill: true,
    });
    const { spawner } = createFakeSpawner(fake.process);
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck: healthy,
      sleep: () => Promise.resolve(),
    });

    await manager.launch(launchConfig);
    const result = await manager.stop();

    expect(fake.residualKills()).toBe(1);
    expect(result).toEqual({
      kind: "stopped",
      detail: expect.stringContaining("surviving child processes"),
    });
  });

  it("leaves no pending close timer once the process exits promptly", async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeProcess({ pid: 4242, closeOn: "SIGTERM" });
      const { spawner } = createFakeSpawner(fake.process);
      const manager = createManager({
        spawner,
        client: unusedClient,
        healthCheck: healthy,
        scheduleTimeout: scheduleArcVoiceTimeout,
      });

      await manager.launch(launchConfig);
      const result = await manager.stop();

      expect(result).toEqual({
        kind: "stopped",
        detail: "voice runtime stopped after SIGTERM",
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the close timeout through the injected scheduler", async () => {
    const fake = createFakeProcess({ pid: 4242, closeOn: "SIGTERM" });
    const { spawner } = createFakeSpawner(fake.process);
    const scheduled: number[] = [];
    const cancelled: number[] = [];
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck: healthy,
      scheduleTimeout: (timeoutMs) => {
        scheduled.push(timeoutMs);
        return () => {
          cancelled.push(timeoutMs);
        };
      },
    });

    await manager.launch(launchConfig);
    await manager.stop();

    expect(scheduled).toEqual([5_000]);
    expect(cancelled).toEqual([5_000]);
  });

  it("escalates to SIGKILL when the process ignores SIGTERM", async () => {
    const fake = createFakeProcess({ pid: 4242, closeOn: "SIGKILL" });
    const { spawner } = createFakeSpawner(fake.process);
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck: healthy,
      sleep: () => Promise.resolve(),
    });

    await manager.launch(launchConfig);
    const result = await manager.stop();

    expect(result).toEqual({ kind: "killed", detail: expect.any(String) });
    expect(fake.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("reports not-running when stop is called before launch", async () => {
    const fake = createFakeProcess({ pid: 4242 });
    const { spawner } = createFakeSpawner(fake.process);
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck: healthy,
    });

    expect(await manager.stop()).toEqual({
      kind: "not-running",
      detail: expect.any(String),
    });
  });

  it("releases orphan guarding when the child exits on its own", async () => {
    const fake = createFakeProcess({ pid: 4242 });
    const { spawner } = createFakeSpawner(fake.process);
    const exitListeners: (() => void)[] = [];
    const guard = createArcVoiceOrphanGuard({
      subscribeExit: (listener) => {
        exitListeners.push(listener);
        return () => {};
      },
    });
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck: healthy,
      guard,
      sleep: () => Promise.resolve(),
    });

    await manager.launch(launchConfig);
    expect(guard.trackedPid()).toBe(4242);

    fake.close();

    expect(guard.trackedPid()).toBeUndefined();
    expect(manager.status().state).toBe("failed");
    expect(manager.status().lastError).toContain("exited unexpectedly");

    exitListeners[0]();
    expect(fake.kills).toEqual([]);
  });

  it("refuses voice api calls until the runtime reports ready", async () => {
    const fake = createFakeProcess({ pid: 4242 });
    const { spawner } = createFakeSpawner(fake.process);
    const listProfiles = vi.fn(unusedClient.listProfiles);
    const client: ArcVoiceClient = {
      ...createStubArcVoiceClient(),
      listProfiles,
      transcribe: vi.fn(unusedClient.transcribe),
      speak: vi.fn(unusedClient.speak),
      modelStatus: vi.fn(unusedClient.modelStatus),
      loadVoiceModel: vi.fn(unusedClient.loadVoiceModel),
      voiceModelProgress: vi.fn(unusedClient.voiceModelProgress),
    };
    const manager = createManager({
      spawner,
      client,
      healthCheck: healthy,
      sleep: () => Promise.resolve(),
    });

    const beforeLaunch = await manager.transcribe({
      audio: encoder.encode("RIFF"),
    });
    expect(beforeLaunch.kind).toBe("error");

    await manager.start(launchConfig, { timeoutMs: 100 });
    fake.close();

    const afterExit = await manager.listProfiles();
    expect(afterExit.kind).toBe("error");
    expect(afterExit.kind === "error" && afterExit.message).toContain("failed");
    expect(listProfiles).not.toHaveBeenCalled();
  });

  it("recovers from an unhealthy runtime by terminating and relaunching", async () => {
    const first = createFakeProcess({ pid: 100, closeOn: "SIGTERM" });
    const second = createFakeProcess({ pid: 200 });
    const { spawner, calls } = createFakeSpawner(first.process, second.process);
    const healthCheck = vi
      .fn<() => Promise<ArcVoiceHealthResult>>()
      .mockResolvedValueOnce({ kind: "healthy", detail: "ready" })
      .mockResolvedValueOnce({ kind: "unhealthy", detail: "wedged" })
      .mockResolvedValue({ kind: "healthy", detail: "ready" });
    const gate = deferredSleep();
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck,
      restartPolicy: { maxAttempts: 1, delayMs: 10, readyTimeoutMs: 100 },
      sleep: gate.sleep,
    });

    await manager.start(launchConfig, { timeoutMs: 100 });
    const degraded = await manager.recheckHealth();

    expect(degraded).toEqual({
      state: "failed",
      lastError: "wedged",
    });
    expect(first.kills).toEqual(["SIGTERM"]);

    gate.flush();
    await vi.waitFor(() => {
      expect(manager.status()).toEqual({ state: "ready", pid: 200 });
    });
    expect(calls).toHaveLength(2);
  });

  it("relaunches after an unexpected exit and reports it to the caller", async () => {
    const first = createFakeProcess({ pid: 100, closeOn: "SIGTERM" });
    const second = createFakeProcess({ pid: 200 });
    const { spawner, calls } = createFakeSpawner(first.process, second.process);
    const exits: ArcVoiceRuntimeExitEvent[] = [];
    const gate = deferredSleep();
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck: healthy,
      restartPolicy: { maxAttempts: 2, delayMs: 10, readyTimeoutMs: 100 },
      onRuntimeExit: (event) => exits.push(event),
      sleep: gate.sleep,
    });

    await manager.start(launchConfig, { timeoutMs: 100 });
    first.close();

    expect(manager.status().state).toBe("failed");
    expect(exits).toEqual([
      { pid: 100, detail: expect.any(String), restarting: true },
    ]);

    gate.flush();
    await vi.waitFor(() => {
      expect(manager.status()).toEqual({ state: "ready", pid: 200 });
    });
    expect(calls).toHaveLength(2);
  });

  it("gives up after the restart attempts are exhausted", async () => {
    const first = createFakeProcess({ pid: 100 });
    const second = createFakeProcess({ pid: 200 });
    const { spawner, calls } = createFakeSpawner(first.process, second.process);
    const healthCheck = vi
      .fn<() => Promise<ArcVoiceHealthResult>>()
      .mockResolvedValueOnce({ kind: "healthy", detail: "ready" })
      .mockResolvedValue({ kind: "unhealthy", detail: "still down" });
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck,
      restartPolicy: { maxAttempts: 1, delayMs: 0, readyTimeoutMs: 0 },
      sleep: () => Promise.resolve(),
    });

    await manager.start(launchConfig, { timeoutMs: 100 });
    first.close();

    await vi.waitFor(() => {
      expect(manager.status()).toEqual({
        state: "failed",
        pid: 200,
        lastError: "still down",
      });
    });
    expect(calls).toHaveLength(2);
  });

  it("does not relaunch after an explicit stop", async () => {
    const fake = createFakeProcess({ pid: 100, closeOn: "SIGTERM" });
    const { spawner, calls } = createFakeSpawner(fake.process);
    const exits: ArcVoiceRuntimeExitEvent[] = [];
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck: healthy,
      restartPolicy: { maxAttempts: 2, delayMs: 0 },
      onRuntimeExit: (event) => exits.push(event),
      sleep: () => Promise.resolve(),
    });

    await manager.start(launchConfig, { timeoutMs: 100 });
    await manager.stop();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(exits).toEqual([]);
    expect(manager.status()).toEqual({ state: "stopped" });
  });

  it("routes client calls through the injected voice client", async () => {
    const fake = createFakeProcess({ pid: 4242, closeOn: "SIGTERM" });
    const { spawner } = createFakeSpawner(fake.process);
    const http: ArcVoiceHttpClient = {
      request: (request) =>
        Promise.resolve(
          request.url.endsWith("/profiles")
            ? {
                status: 200,
                headers: { "content-type": "application/json" },
                body: encoder.encode(
                  JSON.stringify([{ id: "atlas", name: "Atlas" }]),
                ),
              }
            : request.url.endsWith("/transcribe")
              ? {
                  status: 200,
                  headers: { "content-type": "application/json" },
                  body: encoder.encode(JSON.stringify({ text: "hello arc" })),
                }
              : request.url.endsWith("/speak")
                ? {
                    status: 200,
                    headers: { "content-type": "application/json" },
                    body: encoder.encode(
                      JSON.stringify({ id: "gen-1", status: "completed" }),
                    ),
                  }
                : {
                    status: 200,
                    headers: { "content-type": "audio/wav" },
                    body: encoder.encode("WAVDATA"),
                  },
        ),
      streamText: () => Promise.reject(new Error("not implemented")),
    };
    const client = createArcVoiceClient({
      http,
      baseUrl: "http://127.0.0.1:8787",
      boundaryFactory: () => "test-boundary",
      sleep: () => Promise.resolve(),
    });
    const manager = createManager({
      spawner,
      client,
      healthCheck: healthy,
      sleep: () => Promise.resolve(),
    });

    await manager.start(launchConfig, { timeoutMs: 100 });

    expect(await manager.listProfiles()).toEqual({
      kind: "ok",
      value: [{ id: "atlas", name: "Atlas" }],
    });
    expect(await manager.transcribe({ audio: encoder.encode("RIFF") })).toEqual(
      {
        kind: "ok",
        value: { text: "hello arc" },
      },
    );
    expect(await manager.speak({ text: "Arc is ready" })).toEqual({
      kind: "ok",
      value: {
        audio: encoder.encode("WAVDATA"),
        contentType: "audio/wav",
        durationMs: null,
      },
    });
  });
});

describe("createArcVoiceOrphanGuard", () => {
  it("kills the tracked process when the host process exits", () => {
    const exitListeners: (() => void)[] = [];
    const killed: NodeJS.Signals[] = [];
    const guard = createArcVoiceOrphanGuard({
      subscribeExit: (listener) => {
        exitListeners.push(listener);
        return () => {
          exitListeners.splice(exitListeners.indexOf(listener), 1);
        };
      },
    });

    const token = guard.track({
      pid: 4242,
      kill: (signal) => {
        killed.push(signal);
        return true;
      },
    });
    expect(exitListeners).toHaveLength(1);
    exitListeners[0]();

    expect(killed).toEqual(["SIGKILL"]);

    guard.release(token);
    exitListeners[0]();
    expect(killed).toHaveLength(1);
  });

  it("never signals a process that has already exited", () => {
    const exitListeners: (() => void)[] = [];
    const killed: NodeJS.Signals[] = [];
    const guard = createArcVoiceOrphanGuard({
      subscribeExit: (listener) => {
        exitListeners.push(listener);
        return () => {};
      },
    });

    let alive = false;
    guard.track({
      pid: 4242,
      isAlive: () => alive,
      kill: (signal) => {
        killed.push(signal);
        return true;
      },
    });

    exitListeners[0]();
    expect(killed).toEqual([]);

    alive = true;
    expect(guard.killTracked()).toBe(true);
    expect(killed).toEqual(["SIGKILL"]);
  });

  it("signals through the kill the tracked process owns", () => {
    const guard = createArcVoiceOrphanGuard({ subscribeExit: () => () => {} });
    const treeSignals: NodeJS.Signals[] = [];

    guard.track({
      pid: 4242,
      kill: (signal) => {
        treeSignals.push(signal);
        return true;
      },
    });

    expect(guard.killTracked("SIGTERM")).toBe(true);
    expect(treeSignals).toEqual(["SIGTERM"]);
  });

  it("ignores a stale release from a previous track", () => {
    const guard = createArcVoiceOrphanGuard({
      subscribeExit: () => () => {},
    });
    const noop = (): boolean => true;

    const stale = guard.track({ pid: 1, kill: noop });
    guard.track({ pid: 2, kill: noop });
    guard.release(stale);

    expect(guard.trackedPid()).toBe(2);
  });

  it("subscribes to the exit hook only once across repeated tracking", () => {
    const exitListeners: (() => void)[] = [];
    const guard = createArcVoiceOrphanGuard({
      subscribeExit: (listener) => {
        exitListeners.push(listener);
        return () => {};
      },
    });
    const noop = (): boolean => true;

    guard.track({ pid: 1, kill: noop });
    guard.track({ pid: 2, kill: noop });

    expect(exitListeners).toHaveLength(1);
    expect(guard.trackedPid()).toBe(2);
  });
});

describe("arc voice runtime test isolation", () => {
  it("runs the lifecycle without hooking or signalling a real process", async () => {
    const fake = createFakeProcess({ pid: 4242, closeOn: "SIGTERM" });
    const { spawner } = createFakeSpawner(fake.process);
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck: healthy,
      sleep: () => Promise.resolve(),
    });

    await manager.start(launchConfig, { timeoutMs: 100 });
    await manager.stop();

    expect(process.listenerCount("exit")).toBe(exitListenersAtLoad);
    expect(signalSpy).not.toHaveBeenCalled();
  });
});

describe("ArcVoiceRuntimeManager runtime ownership", () => {
  function ownedFingerprint(
    overrides: Partial<ArcVoiceProcessFingerprint> & { pid: number },
  ): ArcVoiceProcessFingerprint {
    const pid = overrides.pid;
    return {
      pid,
      ppid: overrides.ppid ?? 1,
      pgid: overrides.pgid ?? pid,
      startedAt: overrides.startedAt ?? "Thu Sep 24 09:19:05 2026",
      command:
        overrides.command ??
        `${paths.executablePath} --host 127.0.0.1 --port 8787 --data-dir ${paths.stateRoot}`,
    };
  }

  function createOwnershipProbe(...verdicts: ArcVoiceOwnershipVerdict[]): {
    probe: (query: ArcVoiceOwnershipQuery) => Promise<ArcVoiceOwnershipVerdict>;
    queries: ArcVoiceOwnershipQuery[];
  } {
    const queries: ArcVoiceOwnershipQuery[] = [];
    let index = 0;
    return {
      queries,
      probe: (query) => {
        queries.push(query);
        const verdict =
          verdicts[Math.min(index, verdicts.length - 1)] ?? {
            kind: "unsupported" as const,
            detail: "no verdict configured",
          };
        index += 1;
        return Promise.resolve(verdict);
      },
    };
  }

  function createAdoptedFactory(...handles: ArcVoiceProcess[]): {
    factory: ArcVoiceAdoptedProcessFactory;
    requests: ArcVoiceAdoptedProcessRequest[];
  } {
    const requests: ArcVoiceAdoptedProcessRequest[] = [];
    let index = 0;
    return {
      requests,
      factory: (request) => {
        requests.push(request);
        const handle = handles[Math.min(index, handles.length - 1)];
        index += 1;
        if (handle === undefined) {
          throw new Error("no adopted process handle configured");
        }
        return handle;
      },
    };
  }

  function ownedVerdict(
    listener: ArcVoiceProcessFingerprint | undefined,
    duplicates: readonly ArcVoiceProcessFingerprint[] = [],
  ): ArcVoiceOwnershipVerdict {
    return {
      kind: "owned",
      listener,
      duplicates,
      detail: "probe detail",
    };
  }

  it("adopts the runtime Arc already owns instead of spawning a second one", async () => {
    const adopted = createFakeProcess({ pid: 37591, closeOn: "SIGTERM" });
    const spawnAttempt = createFakeProcess({ pid: 4242, closeOn: "SIGTERM" });
    const { spawner, calls } = createFakeSpawner(spawnAttempt.process);
    const listener = ownedFingerprint({
      pid: 37591,
      ppid: 37549,
      pgid: 37549,
      startedAt: "Thu Sep 24 09:19:08 2026",
    });
    const verifier = createOwnershipProbe(
      ownedVerdict(listener),
      ownedVerdict(listener),
    );
    const { factory, requests } = createAdoptedFactory(adopted.process);
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck: healthy,
      sleep: () => Promise.resolve(),
      ownershipProbe: verifier,
      adoptedProcessFactory: factory,
    });

    const result = await manager.start(launchConfig, { timeoutMs: 100 });

    expect(result).toEqual({ kind: "ready", detail: "ready", adopted: true });
    expect(calls).toEqual([]);
    expect(requests[0]?.fingerprint).toEqual(listener);
    expect(requests[0]?.query).toEqual({
      port: 8787,
      executablePath: paths.executablePath,
      dataDir: paths.stateRoot,
    });
    expect(verifier.queries[0]).toEqual({
      port: 8787,
      executablePath: paths.executablePath,
      dataDir: paths.stateRoot,
    });
    expect(manager.status()).toEqual({ state: "ready", pid: 37591 });
  });

  it("refuses a port held by a process Arc does not own", async () => {
    const { spawner, calls } = createFakeSpawner(
      createFakeProcess({ pid: 4242 }).process,
    );
    const verifier = createOwnershipProbe({
      kind: "foreign",
      listener: ownedFingerprint({
        pid: 812,
        command: "/usr/bin/python3 -m http.server 47873",
      }),
      duplicates: [],
      detail: "probe detail",
    });
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck: healthy,
      sleep: () => Promise.resolve(),
      ownershipProbe: verifier,
    });

    const result = await manager.start(launchConfig, { timeoutMs: 100 });

    expect(result).toEqual({
      kind: "failed",
      detail: expect.stringContaining("unowned process (pid 812)"),
    });
    expect(calls).toEqual([]);
    expect(
      signalSpy.mock.calls.filter(([target]) => target === 812),
    ).toEqual([]);
    expect(manager.status()).toEqual({
      state: "failed",
      lastError: expect.stringContaining("unowned process (pid 812)"),
    });
  });

  it("cleans up a surviving Arc runtime that lost the port, then starts fresh", async () => {
    const stale = createFakeProcess({
      pid: 500,
      closeOn: "SIGTERM",
      residualTreeKill: true,
    });
    const fresh = createFakeProcess({ pid: 4242, closeOn: "SIGTERM" });
    const { spawner, calls } = createFakeSpawner(fresh.process);
    const staleFingerprint = ownedFingerprint({ pid: 500, pgid: 500 });
    const verifier = createOwnershipProbe(
      ownedVerdict(undefined, [staleFingerprint]),
      { kind: "vacant", detail: "probe detail" },
    );
    const { factory, requests } = createAdoptedFactory(stale.process);
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck: healthy,
      sleep: () => Promise.resolve(),
      ownershipProbe: verifier,
      adoptedProcessFactory: factory,
    });

    const result = await manager.start(launchConfig, { timeoutMs: 100 });

    expect(result).toEqual({ kind: "ready", detail: "ready" });
    expect(requests[0]?.fingerprint).toEqual(staleFingerprint);
    expect(stale.kills).toEqual(["SIGTERM"]);
    expect(stale.residualKills()).toBe(1);
    expect(calls).toHaveLength(1);
    expect(manager.status()).toEqual({ state: "ready", pid: 4242 });
  });

  it("refuses a healthy port another Arc runtime holds, and drops its own child", async () => {
    const spawned = createFakeProcess({ pid: 100, closeOn: "SIGTERM" });
    const { spawner, calls } = createFakeSpawner(spawned.process);
    const other = ownedFingerprint({ pid: 900, pgid: 900 });
    const verifier = createOwnershipProbe(
      { kind: "vacant", detail: "probe detail" },
      ownedVerdict(other),
    );
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck: healthy,
      sleep: () => Promise.resolve(),
      ownershipProbe: verifier,
    });

    const result = await manager.start(launchConfig, { timeoutMs: 100 });

    expect(result).toEqual({
      kind: "failed",
      detail: expect.stringContaining("another Arc voice runtime (pid 900)"),
    });
    expect(calls).toHaveLength(1);
    expect(spawned.kills).toEqual(["SIGTERM"]);
    expect(manager.status().state).toBe("failed");
  });

  it("stops the adopted runtime tree and releases its orphan guard", async () => {
    const adopted = createFakeProcess({
      pid: 37591,
      closeOn: "SIGTERM",
      residualTreeKill: true,
    });
    const { spawner, calls } = createFakeSpawner(
      createFakeProcess({ pid: 4242, closeOn: "SIGTERM" }).process,
    );
    const listener = ownedFingerprint({ pid: 37591, pgid: 37549 });
    const verifier = createOwnershipProbe(
      ownedVerdict(listener),
      ownedVerdict(listener),
    );
    const { factory } = createAdoptedFactory(adopted.process);
    const exitListeners: (() => void)[] = [];
    const guard = createArcVoiceOrphanGuard({
      subscribeExit: (listener_) => {
        exitListeners.push(listener_);
        return () => {
          exitListeners.splice(exitListeners.indexOf(listener_), 1);
        };
      },
    });
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck: healthy,
      guard,
      sleep: () => Promise.resolve(),
      ownershipProbe: verifier,
      adoptedProcessFactory: factory,
    });

    await manager.start(launchConfig, { timeoutMs: 100 });
    expect(guard.trackedPid()).toBe(37591);

    const result = await manager.stop();

    expect(result).toEqual({ kind: "stopped", detail: expect.any(String) });
    expect(adopted.kills).toEqual(["SIGTERM"]);
    expect(adopted.residualKills()).toBe(1);
    expect(calls).toEqual([]);
    expect(guard.trackedPid()).toBeUndefined();
    expect(exitListeners).toHaveLength(0);
    expect(manager.status()).toEqual({ state: "stopped" });
  });

  it("kills the adopted runtime when the host process exits", async () => {
    const adopted = createFakeProcess({ pid: 37591 });
    const { spawner, calls } = createFakeSpawner(
      createFakeProcess({ pid: 4242 }).process,
    );
    const listener = ownedFingerprint({ pid: 37591, pgid: 37549 });
    const verifier = createOwnershipProbe(
      ownedVerdict(listener),
      ownedVerdict(listener),
    );
    const { factory } = createAdoptedFactory(adopted.process);
    const exitListeners: (() => void)[] = [];
    const guard = createArcVoiceOrphanGuard({
      subscribeExit: (listener_) => {
        exitListeners.push(listener_);
        return () => {};
      },
    });
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck: healthy,
      guard,
      sleep: () => Promise.resolve(),
      ownershipProbe: verifier,
      adoptedProcessFactory: factory,
    });

    await manager.start(launchConfig, { timeoutMs: 100 });
    for (const listener_ of [...exitListeners]) {
      listener_();
    }

    expect(adopted.kills).toEqual(["SIGKILL"]);
    expect(calls).toEqual([]);
  });

  it("restarts after the adopted runtime dies without duplicating it", async () => {
    const adopted = createFakeProcess({ pid: 37591 });
    const fresh = createFakeProcess({ pid: 200 });
    const { spawner, calls } = createFakeSpawner(fresh.process);
    const listener = ownedFingerprint({ pid: 37591, pgid: 37549 });
    const verifier = createOwnershipProbe(
      ownedVerdict(listener),
      ownedVerdict(listener),
      { kind: "vacant", detail: "probe detail" },
    );
    const { factory, requests } = createAdoptedFactory(adopted.process);
    const exits: ArcVoiceRuntimeExitEvent[] = [];
    const gate = deferredSleep();
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck: healthy,
      restartPolicy: { maxAttempts: 1, delayMs: 10, readyTimeoutMs: 100 },
      onRuntimeExit: (event) => exits.push(event),
      sleep: gate.sleep,
      ownershipProbe: verifier,
      adoptedProcessFactory: factory,
    });

    await manager.start(launchConfig, { timeoutMs: 100 });
    adopted.close();

    expect(exits).toEqual([
      { pid: 37591, detail: expect.any(String), restarting: true },
    ]);

    gate.flush();
    await vi.waitFor(() => {
      expect(manager.status()).toEqual({ state: "ready", pid: 200 });
    });
    expect(calls).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it("keeps the tracked runtime when ownership cannot be verified", async () => {
    const spawned = createFakeProcess({ pid: 4242, closeOn: "SIGTERM" });
    const { spawner, calls } = createFakeSpawner(spawned.process);
    const verifier = createOwnershipProbe({
      kind: "unsupported",
      detail: "no ps available",
    });
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck: healthy,
      sleep: () => Promise.resolve(),
      ownershipProbe: verifier,
    });

    const result = await manager.start(launchConfig, { timeoutMs: 100 });

    expect(result).toEqual({ kind: "ready", detail: "ready" });
    expect(calls).toHaveLength(1);
    expect(manager.status()).toEqual({ state: "ready", pid: 4242 });
  });

  it("spawns once when two starts race through the ownership probe", async () => {
    const spawned = createFakeProcess({ pid: 4242, closeOn: "SIGTERM" });
    const { spawner, calls } = createFakeSpawner(spawned.process);
    const gate = deferredSleep();
    let gated = true;
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck: healthy,
      sleep: () => Promise.resolve(),
      ownershipProbe: {
        probe: () => {
          if (!gated) {
            return Promise.resolve({
              kind: "vacant" as const,
              detail: "probe detail",
            });
          }
          gated = false;
          return gate
            .sleep(0)
            .then(() => ({ kind: "vacant" as const, detail: "probe detail" }));
        },
      },
    });

    const first = manager.start(launchConfig, { timeoutMs: 100 });
    const second = manager.start(launchConfig, { timeoutMs: 100 });
    gate.flush();
    const results = await Promise.all([first, second]);

    expect(results).toEqual([
      { kind: "ready", detail: "ready" },
      { kind: "ready", detail: "ready" },
    ]);
    expect(calls).toHaveLength(1);
    expect(manager.status()).toEqual({ state: "ready", pid: 4242 });
  });

  it("does not spawn a runtime that a concurrent stop superseded", async () => {
    const spawned = createFakeProcess({ pid: 4242, closeOn: "SIGTERM" });
    const { spawner, calls } = createFakeSpawner(spawned.process);
    const gate = deferredSleep();
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck: healthy,
      sleep: () => Promise.resolve(),
      ownershipProbe: {
        probe: () =>
          gate
            .sleep(0)
            .then(() => ({ kind: "vacant" as const, detail: "probe detail" })),
      },
    });

    const starting = manager.start(launchConfig, { timeoutMs: 100 });
    const stopped = await manager.stop();
    gate.flush();
    const result = await starting;

    expect(stopped).toEqual({
      kind: "not-running",
      detail: "voice runtime is not running",
    });
    expect(result).toEqual({
      kind: "failed",
      detail: expect.stringContaining("superseded"),
    });
    expect(calls).toEqual([]);
    expect(manager.status().state).toBe("stopped");
  });

  it("refuses to declare a restarted runtime ready while another Arc runtime answers", async () => {
    const first = createFakeProcess({ pid: 100 });
    const adopted = createFakeProcess({ pid: 500, closeOn: "SIGTERM" });
    const { spawner, calls } = createFakeSpawner(first.process);
    const other = ownedFingerprint({ pid: 900, pgid: 900 });
    const verifier = createOwnershipProbe(
      { kind: "vacant", detail: "probe detail" },
      { kind: "vacant", detail: "probe detail" },
      ownedVerdict(other),
      ownedVerdict(other),
    );
    const { factory } = createAdoptedFactory(adopted.process);
    const gate = deferredSleep();
    const manager = createManager({
      spawner,
      client: unusedClient,
      healthCheck: healthy,
      restartPolicy: { maxAttempts: 1, delayMs: 10, readyTimeoutMs: 100 },
      sleep: gate.sleep,
      ownershipProbe: verifier,
      adoptedProcessFactory: factory,
    });

    await manager.start(launchConfig, { timeoutMs: 100 });
    first.close();
    gate.flush();

    await vi.waitFor(() => {
      expect(manager.status().lastError).toContain(
        "another Arc voice runtime (pid 900)",
      );
    });
    expect(manager.status().state).toBe("failed");
    expect(adopted.kills).toEqual(["SIGTERM"]);
    expect(calls).toHaveLength(1);
  });
});
