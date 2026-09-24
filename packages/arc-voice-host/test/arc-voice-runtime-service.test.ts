import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256File } from "../src/digest.js";
import type { ArcVoiceboxStageResult } from "../src/acquire.js";
import type {
  ArcVoiceCallResult,
  ArcVoiceClient,
  ArcVoiceSpeakArgs,
  ArcVoiceSpeakOutput,
  ArcVoiceTranscribeArgs,
  ArcVoiceTranscribeOutput,
} from "../src/client.js";
import { createStubArcVoiceClient } from "./stub-client.js";
import type { ArcVoiceHealthResult } from "../src/health.js";
import {
  mutateVoiceRuntimeManifest,
  readVoiceRuntimeManifest,
  type VoiceRuntimeManifestSource,
} from "../src/manifest.js";
import {
  createArcVoicePaths,
  type ArcVoicePaths,
} from "../src/paths.js";
import type {
  ArcVoiceProcess,
  ArcVoiceProcessSpawnArgs,
  ArcVoiceProcessSpawner,
} from "../src/process.js";
import { ARC_VOICEBOX_RELEASE } from "../src/release.js";
import {
  ArcVoiceRuntimeManager,
  type ArcVoiceTimeoutScheduler,
} from "../src/runtime-manager.js";
import {
  ArcVoiceRuntimeService,
  type ArcVoiceboxStager,
} from "../src/runtime.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const scheduler: ArcVoiceTimeoutScheduler = (_timeoutMs, onTimeout) => {
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

const unusedClient: ArcVoiceClient = {
  ...createStubArcVoiceClient(),
  listProfiles: () => Promise.resolve({ kind: "ok", value: [] }),
};

const COMPONENT_BYTES = "voicebox-server-fixture";

async function componentDigest(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "arc-voice-digest-"));
  roots.push(root);
  const path = join(root, "voicebox-server");
  await writeFile(path, COMPONENT_BYTES, "utf8");
  return sha256File(path);
}

interface ServiceFixture {
  root: string;
  paths: ArcVoicePaths;
  service: ArcVoiceRuntimeService;
  staged: string[];
  kills: NodeJS.Signals[];
  launches: ArcVoiceProcessSpawnArgs[];
}

async function createService(
  args: {
    health?: () => Promise<ArcVoiceHealthResult>;
    platform?: NodeJS.Platform;
    arch?: string;
    stageOverride?: ArcVoiceboxStager;
    port?: number;
    source?: VoiceRuntimeManifestSource;
    client?: ArcVoiceClient;
  } = {},
): Promise<ServiceFixture> {
  const root = await mkdtemp(join(tmpdir(), "arc-voice-service-"));
  roots.push(root);
  const paths = createArcVoicePaths({ userDataPath: root });
  const staged: string[] = [];
  const kills: NodeJS.Signals[] = [];
  const launches: ArcVoiceProcessSpawnArgs[] = [];

  const closeListeners: ((
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => void)[] = [];
  let exited = false;
  const fakeProcess: ArcVoiceProcess = {
    pid: 5150,
    kill: (signal) => {
      kills.push(signal);
      if (signal === "SIGTERM" && !exited) {
        exited = true;
        for (const listener of closeListeners) {
          listener(0, "SIGTERM");
        }
      }
      return true;
    },
    killResidualTree: () => false,
    hasExited: () => exited,
    onError: () => {},
    onClose: (listener) => {
      closeListeners.push(listener);
    },
  };
  const spawner: ArcVoiceProcessSpawner = {
    spawn: (spawnArgs) => {
      launches.push(spawnArgs);
      return fakeProcess;
    },
  };

  const release = {
    ...ARC_VOICEBOX_RELEASE,
    componentSha256: await componentDigest(),
  };
  const stager: ArcVoiceboxStager =
    args.stageOverride ??
    (async ({ stagingDir }): Promise<ArcVoiceboxStageResult> => {
      staged.push(stagingDir);
      await mkdir(stagingDir, { recursive: true });
      const executablePath = join(stagingDir, "voicebox-server");
      await writeFile(executablePath, COMPONENT_BYTES, "utf8");
      await chmod(executablePath, 0o755);
      return {
        kind: "ok",
        executablePath,
        digest: release.componentSha256,
        version: release.version,
      };
    });

  const manager = new ArcVoiceRuntimeManager({
    spawner,
    client: args.client ?? unusedClient,
    healthCheck:
      args.health ??
      (() => Promise.resolve({ kind: "healthy", detail: "ready" })),
    scheduleTimeout: scheduler,
    sleep: () => Promise.resolve(),
  });

  return {
    root,
    paths,
    staged,
    kills,
    launches,
    service: new ArcVoiceRuntimeService({
      paths,
      release,
      manager,
      stage: stager,
      backend: "mlx",
      port: args.port ?? 47873,
      createdByArcVersion: "0.9.0",
      ...(args.source === undefined ? {} : { source: args.source }),
      ...(args.platform === undefined ? {} : { platform: args.platform }),
      ...(args.arch === undefined ? {} : { arch: args.arch }),
      startupCheckTimeoutMs: 0,
      now: () => 1_700_000_000_000,
    }),
  };
}

async function readManifest(paths: ArcVoicePaths) {
  const read = await readVoiceRuntimeManifest({
    manifestPath: paths.manifestPath,
    createdByArcVersion: "0.9.0",
    platform: "darwin-arm64",
    arch: "arm64",
  });
  if (read.kind !== "ok") {
    throw new Error(`expected a manifest, got ${read.kind}`);
  }
  return read.manifest;
}

describe("ArcVoiceRuntimeService.status", () => {
  it("reports not-installed before preparation", async () => {
    const { service } = await createService();

    expect(await service.status()).toEqual({
      state: "not-installed",
      version: null,
      knownGoodVersion: null,
      rollbackAvailable: false,
      installPath: null,
      healthState: "unknown",
      running: false,
    });
  });
});

describe("ArcVoiceRuntimeService.prepare", () => {
  it("stages, verifies, and activates the pinned runtime into Arc's own tree", async () => {
    const { paths, service, staged } = await createService();

    const prepared = await service.prepare();

    expect(prepared).toEqual({
      kind: "ready",
      version: "0.5.0",
      detail: `voice runtime 0.5.0 activated at ${paths.executablePath}`,
    });
    expect(staged).toEqual([paths.stagingVersionRoot("0.5.0")]);
    expect(paths.executablePath.startsWith(paths.runtimeRoot)).toBe(true);
    expect(await readFile(paths.executablePath, "utf8")).toBe(COMPONENT_BYTES);
    expect((await stat(paths.executablePath)).mode & 0o111).not.toBe(0);
    expect(await readManifest(paths)).toMatchObject({
      activeVersion: "0.5.0",
      source: "arc-bundled",
      installPath: paths.executablePath,
    });
  });

  it("is idempotent once the runtime is installed", async () => {
    const { service, staged } = await createService();
    await service.prepare();

    expect((await service.prepare()).kind).toBe("ready");
    expect(staged).toHaveLength(1);
  });

  it("reports a staging rejection instead of half-installing", async () => {
    const { paths, service } = await createService({
      stageOverride: () =>
        Promise.resolve({
          kind: "rejected",
          reason: "component digest mismatch",
        }),
    });

    expect(await service.prepare()).toEqual({
      kind: "failed",
      detail: "component digest mismatch",
    });
    expect(await stat(paths.executablePath).catch(() => null)).toBeNull();
  });

  it("records the acquisition source the caller declares", async () => {
    const { paths, service } = await createService({
      source: "arc-managed-download",
    });

    await service.prepare();

    expect((await readManifest(paths)).source).toBe("arc-managed-download");
  });

  it("refuses to prepare a runtime pinned for another platform", async () => {
    const { service, staged } = await createService({
      platform: "linux",
      arch: "x64",
    });

    expect(await service.prepare()).toEqual({
      kind: "unsupported-platform",
      detail:
        "Voicebox 0.5.0 is pinned for darwin-arm64; this machine is linux-x64",
    });
    expect(staged).toEqual([]);
  });

  it("refuses to start when preparation fails", async () => {
    const { service } = await createService({ platform: "linux", arch: "x64" });

    expect(await service.start()).toEqual({
      kind: "failed",
      detail:
        "Voicebox 0.5.0 is pinned for darwin-arm64; this machine is linux-x64",
    });
  });
});

describe("ArcVoiceRuntimeService.start", () => {
  it("launches the Arc-owned executable with Arc-owned data and model directories", async () => {
    const { paths, service, launches } = await createService();

    const started = await service.start();

    expect(started.kind).toBe("ready");
    expect(launches).toHaveLength(1);
    const [launch] = launches;
    expect(launch.command).toBe(paths.executablePath);
    expect(launch.args).toEqual([
      "--host",
      "127.0.0.1",
      "--port",
      "47873",
      "--data-dir",
      paths.dataDir,
      "--parent-pid",
      String(process.pid),
    ]);
    expect(launch.env["VOICEBOX_MODELS_DIR"]).toBe(paths.modelsRoot);
    expect(launch.cwd).toBe(paths.activeRoot);
    expect(paths.dataDir.startsWith(paths.stateRoot)).toBe(true);
    expect((await stat(paths.dataDir)).isDirectory()).toBe(true);
    expect((await stat(paths.modelsRoot)).isDirectory()).toBe(true);
  });

  it("promotes the runtime to known-good only after it reports ready", async () => {
    const { paths, service } = await createService();

    await service.start();

    expect(await readManifest(paths)).toMatchObject({
      activeVersion: "0.5.0",
      knownGoodVersion: "0.5.0",
      healthState: "healthy",
    });
    expect((await service.status()).state).toBe("ready");
  });

  it("records an unhealthy runtime and leaves the previous known-good alone", async () => {
    const { paths, service, kills } = await createService({
      health: () => Promise.resolve({ kind: "unhealthy", detail: "not ready" }),
    });

    const started = await service.start();

    expect(started).toEqual({ kind: "timeout", detail: "not ready" });
    expect(kills).toContain("SIGTERM");
    expect(await readManifest(paths)).toMatchObject({
      knownGoodVersion: null,
      healthState: "unhealthy",
    });
    expect((await service.status()).state).toBe("failed");
  });
});

describe("ArcVoiceRuntimeService.stop", () => {
  it("stops the runtime and sweeps abandoned staging", async () => {
    const { paths, service, kills } = await createService();
    await service.start();
    await mkdir(paths.stagingVersionRoot("0.5.0"), { recursive: true });

    const stopped = await service.stop();

    expect(stopped.kind).toBe("stopped");
    expect(kills).toEqual(["SIGTERM"]);
    expect(
      await stat(paths.stagingVersionRoot("0.5.0")).catch(() => null),
    ).toBeNull();
    expect((await service.status()).state).toBe("stopped");
  });

  it("reports not-running when nothing was started", async () => {
    const { service } = await createService();

    expect(await service.stop()).toEqual({
      kind: "not-running",
      detail: "voice runtime is not running",
    });
  });
});

describe("ArcVoiceRuntimeService.repair", () => {
  it("reinstalls a runtime whose executable was deleted", async () => {
    const { paths, service } = await createService();
    await service.prepare();
    await rm(paths.executablePath);

    const repaired = await service.repair();

    expect(repaired).toMatchObject({ kind: "reinstalled", version: "0.5.0" });
    expect(await readFile(paths.executablePath, "utf8")).toBe(COMPONENT_BYTES);
  });

  it("verifies an installed but stopped runtime without reinstalling it", async () => {
    const { service, staged } = await createService();
    await service.prepare();

    const repaired = await service.repair();

    expect(repaired).toMatchObject({ kind: "installed", version: "0.5.0" });
    expect(staged).toHaveLength(1);
  });

  it("confirms health and promotes a running runtime", async () => {
    const { paths, service } = await createService();
    await service.start();
    await mutateVoiceRuntimeManifest({
      manifestPath: paths.manifestPath,
      createdByArcVersion: "0.9.0",
      platform: "darwin-arm64",
      arch: "arm64",
      mutate: (manifest) => ({ ...manifest, knownGoodVersion: null }),
    });

    expect(await service.repair()).toMatchObject({ kind: "healthy" });
    expect((await readManifest(paths)).knownGoodVersion).toBe("0.5.0");
  });

  it("reports an unhealthy running runtime", async () => {
    const health = vi
      .fn<() => Promise<ArcVoiceHealthResult>>()
      .mockResolvedValueOnce({ kind: "healthy", detail: "ready" })
      .mockResolvedValue({ kind: "unhealthy", detail: "gone" });
    const { paths, service } = await createService({ health });
    await service.start();

    const repaired = await service.repair();

    expect(repaired).toEqual({ kind: "failed", detail: "gone" });
    expect((await readManifest(paths)).healthState).toBe("unhealthy");
  });
});

describe("ArcVoiceRuntimeService.update", () => {
  it("reports an up-to-date runtime without restaging it", async () => {
    const { service, staged } = await createService();
    await service.prepare();

    expect(await service.update()).toEqual({
      kind: "up-to-date",
      version: "0.5.0",
    });
    expect(staged).toHaveLength(1);
  });

  it("refuses to install the pinned runtime on an unsupported platform", async () => {
    const { service, staged } = await createService({
      platform: "linux",
      arch: "x64",
    });

    expect(await service.update()).toEqual({
      kind: "failed",
      detail:
        "Voicebox 0.5.0 is pinned for darwin-arm64; this machine is linux-x64",
    });
    expect(staged).toEqual([]);
  });

  it("installs the pinned runtime and promotes it once it answers its health probe", async () => {
    const { paths, service } = await createService();

    const updated = await service.update();

    expect(updated).toMatchObject({ kind: "updated", version: "0.5.0" });
    expect(await readManifest(paths)).toMatchObject({
      activeVersion: "0.5.0",
      knownGoodVersion: "0.5.0",
      healthState: "healthy",
    });
  });

  it("rolls back to the known-good runtime when the new one never becomes healthy", async () => {
    const health = vi
      .fn<() => Promise<ArcVoiceHealthResult>>()
      .mockResolvedValue({ kind: "unhealthy", detail: "never came up" });
    const { paths, service, staged } = await createService({ health });

    const previousComponent = join(paths.previousRoot, "voicebox-server");
    await mkdir(paths.previousRoot, { recursive: true });
    await writeFile(previousComponent, "voicebox-server-0.4.0", "utf8");
    await chmod(previousComponent, 0o755);
    const previousDigest = await sha256File(previousComponent);
    await mkdir(paths.activeRoot, { recursive: true });
    await writeFile(
      join(paths.activeRoot, "voicebox-server"),
      "voicebox-server-0.4.0",
      "utf8",
    );
    await chmod(join(paths.activeRoot, "voicebox-server"), 0o755);
    await mutateVoiceRuntimeManifest({
      manifestPath: paths.manifestPath,
      createdByArcVersion: "0.9.0",
      platform: "darwin-arm64",
      arch: "arm64",
      mutate: (manifest) => ({
        ...manifest,
        activeVersion: "0.4.0",
        knownGoodVersion: "0.4.0",
        installPath: paths.executablePath,
        digest: previousDigest,
        digestsByVersion: { "0.4.0": previousDigest },
      }),
    });

    const updated = await service.update();

    expect(updated).toMatchObject({
      kind: "rolled-back",
      from: "0.5.0",
      to: "0.4.0",
      detail: "never came up",
    });
    expect(await readFile(paths.executablePath, "utf8")).toBe(
      "voicebox-server-0.4.0",
    );
    expect(await readManifest(paths)).toMatchObject({
      activeVersion: "0.4.0",
      previousVersion: null,
      knownGoodVersion: "0.4.0",
    });
    expect(staged).toHaveLength(1);
  });
});

describe("ArcVoiceRuntimeService.transcribe", () => {
  function recordingClient(
    result: ArcVoiceCallResult<ArcVoiceTranscribeOutput>,
  ): { client: ArcVoiceClient; calls: ArcVoiceTranscribeArgs[] } {
    const calls: ArcVoiceTranscribeArgs[] = [];
    return {
      calls,
      client: {
        ...createStubArcVoiceClient(),
        listProfiles: () => Promise.resolve({ kind: "ok", value: [] }),
        transcribe: (args) => {
          calls.push(args);
          return Promise.resolve(result);
        },
        speak: () =>
          Promise.resolve({ kind: "error", code: "unavailable", message: "unused" }),
        modelStatus: () =>
          Promise.resolve({ kind: "error", code: "unavailable", message: "unused" }),
        loadVoiceModel: () =>
          Promise.resolve({ kind: "error", code: "unavailable", message: "unused" }),
        voiceModelProgress: () =>
          Promise.resolve({ kind: "error", code: "unavailable", message: "unused" }),
      },
    };
  }

  it("starts the runtime for the first transcription and reuses it afterwards", async () => {
    const { client, calls } = recordingClient({
      kind: "ok",
      value: { text: "hello arc" },
    });
    const { service, launches } = await createService({ client });

    expect(
      await service.transcribe({ audio: new Uint8Array([1, 2, 3]) }),
    ).toEqual({ kind: "ok", value: { text: "hello arc" } });
    expect(launches).toHaveLength(1);

    await service.transcribe({ audio: new Uint8Array([4, 5, 6]) });

    expect(launches).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect((await service.status()).state).toBe("ready");
  });

  it("forwards audio metadata and the caller signal to the voice client", async () => {
    const { client, calls } = recordingClient({
      kind: "ok",
      value: { text: "hello arc" },
    });
    const { service } = await createService({ client });
    const controller = new AbortController();

    await service.transcribe({
      audio: new Uint8Array([7]),
      fileName: "recording.webm",
      mimeType: "audio/webm",
      signal: controller.signal,
    });

    expect(calls[0]?.fileName).toBe("recording.webm");
    expect(calls[0]?.mimeType).toBe("audio/webm");
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  it("preserves a client failure without disturbing the running runtime", async () => {
    const { client } = recordingClient({
      kind: "error",
      code: "http",
      message: "voice transcription failed with HTTP 500",
      status: 500,
    });
    const { service } = await createService({ client });
    await service.start();

    expect(await service.transcribe({ audio: new Uint8Array([1]) })).toEqual({
      kind: "error",
      code: "http",
      message: "voice transcription failed with HTTP 500",
      status: 500,
    });
    expect((await service.status()).state).toBe("ready");
  });

  it("reports a timeout instead of waiting out a slow runtime start", async () => {
    const { client, calls } = recordingClient({
      kind: "ok",
      value: { text: "too late" },
    });
    const { service } = await createService({
      client,
      stageOverride: async ({ stagingDir }) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return {
          kind: "ok",
          executablePath: join(stagingDir, "voicebox-server"),
          digest: await componentDigest(),
          version: ARC_VOICEBOX_RELEASE.version,
        };
      },
    });

    const started = Date.now();
    const result = await service.transcribe({
      audio: new Uint8Array([1]),
      timeoutMs: 60,
    });

    expect(result).toMatchObject({ kind: "error", code: "timeout" });
    expect(Date.now() - started).toBeLessThan(320);
    expect(calls).toEqual([]);
  });

  it("reports an aborted transcription that is still starting the runtime", async () => {
    const { client, calls } = recordingClient({
      kind: "ok",
      value: { text: "too late" },
    });
    const { service } = await createService({
      client,
      stageOverride: async ({ stagingDir }) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return {
          kind: "ok",
          executablePath: join(stagingDir, "voicebox-server"),
          digest: await componentDigest(),
          version: ARC_VOICEBOX_RELEASE.version,
        };
      },
    });
    const controller = new AbortController();

    const started = Date.now();
    const pending = service.transcribe({
      audio: new Uint8Array([1]),
      signal: controller.signal,
      timeoutMs: 30_000,
    });
    controller.abort();
    const result = await pending;

    expect(result).toMatchObject({ kind: "error", code: "aborted" });
    expect(Date.now() - started).toBeLessThan(320);
    expect(calls).toEqual([]);
  });

  it("reports an unavailable runtime without calling the voice client", async () => {
    const { client, calls } = recordingClient({
      kind: "ok",
      value: { text: "unreachable" },
    });
    const { service } = await createService({
      client,
      platform: "linux",
      arch: "x64",
    });

    const result = await service.transcribe({ audio: new Uint8Array([1]) });

    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.message).toContain(
      "voice runtime is unavailable",
    );
    expect(calls).toEqual([]);
  });

  it("refuses an already-aborted transcription without starting the runtime", async () => {
    const { client, calls } = recordingClient({
      kind: "ok",
      value: { text: "late" },
    });
    const { service, launches } = await createService({ client });
    const controller = new AbortController();
    controller.abort();

    expect(
      await service.transcribe({
        audio: new Uint8Array([1]),
        signal: controller.signal,
      }),
    ).toEqual({
      kind: "error",
      code: "aborted",
      message: "voice transcription was cancelled",
    });
    expect(calls).toEqual([]);
    expect(launches).toEqual([]);
  });

  it("refuses a transcription aborted while the runtime was starting", async () => {
    const { client, calls } = recordingClient({
      kind: "ok",
      value: { text: "late" },
    });
    const { service } = await createService({ client });
    const controller = new AbortController();
    const started = service.start();
    controller.abort();
    await started;

    expect(
      await service.transcribe({
        audio: new Uint8Array([1]),
        signal: controller.signal,
      }),
    ).toEqual({
      kind: "error",
      code: "aborted",
      message: "voice transcription was cancelled",
    });
    expect(calls).toEqual([]);
  });
});

describe("ArcVoiceRuntimeService.recordRuntimeExit", () => {
  it("marks the runtime unhealthy when the process exits unexpectedly", async () => {
    const { paths, service } = await createService();
    await service.start();

    expect(
      await service.recordRuntimeExit({
        pid: 5150,
        detail: "voice runtime exited unexpectedly (code 1, signal null)",
        restarting: false,
      }),
    ).toBe("unhealthy");
    expect(await readManifest(paths)).toMatchObject({
      healthState: "unhealthy",
      knownGoodVersion: "0.5.0",
    });
  });

  it("keeps the health state open while the runtime is being restarted", async () => {
    const { paths, service } = await createService();
    await service.start();

    expect(
      await service.recordRuntimeExit({
        pid: 5150,
        detail: "voice runtime exited unexpectedly (code 1, signal null)",
        restarting: true,
      }),
    ).toBe("unknown");
    expect((await readManifest(paths)).healthState).toBe("unknown");
  });
});

describe("ArcVoiceRuntimeService.rollback", () => {
  it("refuses while the runtime is running", async () => {
    const { service } = await createService();
    await service.start();

    expect(await service.rollback()).toEqual({
      kind: "failed",
      reason: "refusing to roll back while the voice runtime is running",
    });
  });

  it("reports unavailable when there is no known-good version yet", async () => {
    const { service } = await createService();
    await service.prepare();

    expect(await service.rollback()).toEqual({
      kind: "unavailable",
      reason: "no known-good voice runtime version is recorded",
    });
  });
});

describe("arc voice service isolation", () => {
  it("never signals a real process", async () => {
    const signalSpy = vi.spyOn(process, "kill");
    const { service } = await createService();

    await service.start();
    await service.stop();

    expect(signalSpy).not.toHaveBeenCalled();
    signalSpy.mockRestore();
  });
});

describe("ArcVoiceRuntimeService.speechStatus", () => {
  it("reports stopped without starting the runtime", async () => {
    const { service, launches } = await createService();

    expect(await service.speechStatus()).toEqual({
      kind: "ok",
      value: {
        runtimeState: "stopped",
        version: null,
        speechModelLoaded: false,
        voiceModel: null,
      },
    });
    expect(launches).toEqual([]);
  });

  it("maps a ready runtime's model status without throwing", async () => {
    const client: ArcVoiceClient = {
      ...createStubArcVoiceClient(),
      listProfiles: () => Promise.resolve({ kind: "ok", value: [] }),
      transcribe: () =>
        Promise.resolve({ kind: "error", code: "unavailable", message: "unused" }),
      speak: () =>
        Promise.resolve({ kind: "error", code: "unavailable", message: "unused" }),
      loadVoiceModel: () =>
        Promise.resolve({ kind: "error", code: "unavailable", message: "unused" }),
      voiceModelProgress: () => Promise.resolve({ kind: "ok", value: 0.4 }),
      modelStatus: () =>
        Promise.resolve({
          kind: "ok",
          value: {
            speech: { modelName: "whisper-base", loaded: true },
            voice: {
              modelName: "kokoro",
              engine: "kokoro",
              size: "",
              downloaded: false,
              loaded: false,
              downloading: true,
            },
          },
        }),
    };
    const { service } = await createService({ client });
    await service.start();

    expect(await service.speechStatus()).toEqual({
      kind: "ok",
      value: {
        runtimeState: "ready",
        version: ARC_VOICEBOX_RELEASE.version,
        speechModelLoaded: true,
        voiceModel: {
          engine: "kokoro",
          size: "",
          downloaded: false,
          loaded: false,
          downloading: true,
          downloadPercent: 0.4,
        },
      },
    });
  });
});

describe("ArcVoiceRuntimeService.speak", () => {
  function speakClient(result: ArcVoiceCallResult<ArcVoiceSpeakOutput>): {
    client: ArcVoiceClient;
    calls: ArcVoiceSpeakArgs[];
  } {
    const calls: ArcVoiceSpeakArgs[] = [];
    return {
      calls,
      client: {
        ...createStubArcVoiceClient(),
        listProfiles: () => Promise.resolve({ kind: "ok", value: [] }),
        transcribe: () =>
          Promise.resolve({ kind: "error", code: "unavailable", message: "unused" }),
        speak: (args) => {
          calls.push(args);
          return Promise.resolve(result);
        },
        modelStatus: () =>
          Promise.resolve({ kind: "error", code: "unavailable", message: "unused" }),
        loadVoiceModel: () =>
          Promise.resolve({ kind: "error", code: "unavailable", message: "unused" }),
        voiceModelProgress: () =>
          Promise.resolve({ kind: "error", code: "unavailable", message: "unused" }),
      },
    };
  }

  it("starts the runtime for the first speak", async () => {
    const { client, calls } = speakClient({
      kind: "ok",
      value: { audio: new Uint8Array([1]), contentType: "audio/wav", durationMs: 1500 },
    });
    const { service, launches } = await createService({ client });

    expect(await service.speak({ text: "Hello" })).toEqual({
      kind: "ok",
      value: { audio: new Uint8Array([1]), contentType: "audio/wav", durationMs: 1500 },
    });
    expect(launches).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe("Hello");
  });

  it("reports a timeout instead of waiting out a slow runtime start", async () => {
    const { client, calls } = speakClient({
      kind: "ok",
      value: { audio: new Uint8Array([1]), contentType: "audio/wav", durationMs: null },
    });
    const { service } = await createService({
      client,
      stageOverride: async ({ stagingDir }) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return {
          kind: "ok",
          executablePath: join(stagingDir, "voicebox-server"),
          digest: await componentDigest(),
          version: ARC_VOICEBOX_RELEASE.version,
        };
      },
    });

    const started = Date.now();
    const result = await service.speak({ text: "Hello", timeoutMs: 60 });

    expect(result).toMatchObject({ kind: "error", code: "timeout" });
    expect(Date.now() - started).toBeLessThan(320);
    expect(calls).toEqual([]);
  });

  it("refuses an already-aborted speak without starting the runtime", async () => {
    const { client, calls } = speakClient({
      kind: "ok",
      value: { audio: new Uint8Array([1]), contentType: "audio/wav", durationMs: null },
    });
    const { service, launches } = await createService({ client });
    const controller = new AbortController();
    controller.abort();

    expect(
      await service.speak({ text: "Hello", signal: controller.signal }),
    ).toEqual({
      kind: "error",
      code: "aborted",
      message: "voice synthesis was cancelled",
    });
    expect(calls).toEqual([]);
    expect(launches).toEqual([]);
  });
});

describe("ArcVoiceRuntimeService.release", () => {
  it("unloads models, then stops the runtime", async () => {
    const calls: string[] = [];
    const { service, kills } = await createService({
      client: {
        ...createStubArcVoiceClient(),
        unloadModels: () => {
          calls.push("unload");
          return Promise.resolve({ kind: "ok", value: undefined });
        },
      },
    });
    await service.start();

    const released = await service.release();

    expect(released).toEqual({
      kind: "ok",
      value: { runtimeState: "stopped" },
    });
    expect(calls).toEqual(["unload"]);
    expect(kills).toEqual(["SIGTERM"]);
    expect((await service.status()).state).toBe("stopped");
  });

  it("still stops the runtime when the model unload fails", async () => {
    const { service, kills } = await createService({
      client: {
        ...createStubArcVoiceClient(),
        unloadModels: () =>
          Promise.resolve({
            kind: "error",
            code: "transport",
            message: "unload failed",
          }),
      },
    });
    await service.start();

    const released = await service.release();

    expect(released).toEqual({
      kind: "ok",
      value: { runtimeState: "stopped" },
    });
    expect(kills).toEqual(["SIGTERM"]);
  });

  it("reports not-running when the runtime is already stopped", async () => {
    const { service } = await createService();

    expect(await service.release()).toEqual({
      kind: "ok",
      value: { runtimeState: "not-running" },
    });
  });
});

describe("ArcVoiceRuntimeService.unloadModels during speak", () => {
  it("skips the unload while a speak is in flight", async () => {
    const speakControl: {
      resolve: ((value: ArcVoiceCallResult<ArcVoiceSpeakOutput>) => void) | null;
    } = { resolve: null };
    const unloadCalls: string[] = [];
    const { service } = await createService({
      client: {
        ...createStubArcVoiceClient(),
        speak: () =>
          new Promise<ArcVoiceCallResult<ArcVoiceSpeakOutput>>((resolve) => {
            speakControl.resolve = resolve;
          }),
        unloadModels: () => {
          unloadCalls.push("unload");
          return Promise.resolve({ kind: "ok", value: undefined });
        },
      },
    });
    await service.start();

    const speakResult = service.speak({
      text: "Hello",
      profile: "Morgan",
      engine: "qwen",
    });
    const unloaded = await service.unloadModels();

    expect(unloaded.kind).toBe("ok");
    expect(unloadCalls).toEqual([]);

    if (typeof speakControl.resolve === "function") {
      speakControl.resolve({
        kind: "ok",
        value: { audio: new Uint8Array([1]), contentType: "audio/wav", durationMs: 1 },
      });
    }
    await speakResult;
  });

  it("unloads once the in-flight speak settles", async () => {
    const unloadCalls: string[] = [];
    const { service } = await createService({
      client: {
        ...createStubArcVoiceClient(),
        speak: () =>
          Promise.resolve<ArcVoiceCallResult<ArcVoiceSpeakOutput>>({
            kind: "ok",
            value: {
              audio: new Uint8Array([1]),
              contentType: "audio/wav",
              durationMs: 1,
            },
          }),
        unloadModels: () => {
          unloadCalls.push("unload");
          return Promise.resolve({ kind: "ok", value: undefined });
        },
      },
    });
    await service.start();
    await service.speak({ text: "Hello", profile: "Morgan", engine: "qwen" });

    await service.unloadModels();

    expect(unloadCalls).toEqual(["unload"]);
  });
});
