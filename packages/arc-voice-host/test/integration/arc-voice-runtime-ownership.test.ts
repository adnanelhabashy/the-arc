import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { stageArcVoiceboxComponentFromBundle } from "../../src/acquire.js";
import {
  createArcVoiceClient,
  createArcVoiceHealthCheck,
  createFetchArcVoiceHttpClient,
} from "../../src/client.js";
import {
  classifyArcVoiceOwnership,
  createPosixArcVoiceOwnershipProbe,
  isArcVoiceboxProcess,
  parseArcVoiceProcessListing,
  type ArcVoiceProcessFingerprint,
} from "../../src/ownership.js";
import { createArcVoicePaths, type ArcVoicePaths } from "../../src/paths.js";
import {
  createNodeArcVoiceProcessSpawner,
  type ArcVoiceProcess,
  type ArcVoiceProcessSpawnArgs,
  type ArcVoiceProcessSpawner,
} from "../../src/process.js";
import { ARC_VOICEBOX_RELEASE } from "../../src/release.js";
import {
  ArcVoiceRuntimeManager,
  buildVoiceboxLaunchArgs,
  buildVoiceboxEnvironment,
  VOICEBOX_MODELS_DIR_ENV,
} from "../../src/runtime-manager.js";
import { ArcVoiceRuntimeService } from "../../src/runtime.js";

const artifactPath = process.env["ARC_VOICEBOX_INTEGRATION_ARTIFACT"] ?? null;
const artifactPresent = artifactPath !== null && existsSync(artifactPath);

const ORPHANING_WORKER = [
  'const { spawn } = require("node:child_process");',
  "const spec = JSON.parse(process.env.ARC_VOICE_ORPHAN_SPEC);",
  "spawn(spec.command, spec.args, {",
  "  env: { ...process.env, [spec.modelsEnv]: spec.modelsDir },",
  '  detached: true,',
  '  stdio: "ignore",',
  "}).unref();",
  "process.exit(0);",
].join("\n");

const disposableRoots: string[] = [];

function run(
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      command,
      [...args],
      { encoding: "utf8", env: env ?? process.env },
      (error, stdout) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        reject(error);
      },
    );
  });
}

async function allocatePort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(
        typeof address === "object" && address !== null ? address.port : 0,
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return port;
}

function portIsClosed(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const settle = (closed: boolean): void => {
      socket.destroy();
      resolve(closed);
    };
    socket.setTimeout(2_000);
    socket.on("connect", () => settle(false));
    socket.on("timeout", () => settle(true));
    socket.on("error", () => settle(true));
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

interface LiveRuntime {
  paths: ArcVoicePaths;
  port: number;
  service: ArcVoiceRuntimeService;
  manager: ArcVoiceRuntimeManager;
  spawnCalls: ArcVoiceProcessSpawnArgs[];
}

async function ownedVoiceProcesses(
  query: { port: number; executablePath: string; dataDir: string },
): Promise<ArcVoiceProcessFingerprint[]> {
  const listing = await run("ps", [
    "-axo",
    "pid=,ppid=,pgid=,lstart=,command=",
  ]);
  return parseArcVoiceProcessListing(listing).filter((fingerprint) =>
    isArcVoiceboxProcess(fingerprint, query),
  );
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`condition was not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function startLiveRuntime(): Promise<LiveRuntime> {
  const root = await mkdtemp(join(tmpdir(), "arc-voice-ownership-"));
  disposableRoots.push(root);
  const paths = createArcVoicePaths({ userDataPath: root });
  const port = await allocatePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const http = createFetchArcVoiceHttpClient();
  const realSpawner = createNodeArcVoiceProcessSpawner();
  const spawnCalls: ArcVoiceProcessSpawnArgs[] = [];
  const spawner: ArcVoiceProcessSpawner = {
    spawn(args): ArcVoiceProcess {
      spawnCalls.push(args);
      return realSpawner.spawn(args);
    },
  };
  const manager = new ArcVoiceRuntimeManager({
    spawner,
    client: createArcVoiceClient({ http, baseUrl }),
    healthCheck: createArcVoiceHealthCheck({ client: http, baseUrl }),
    ownershipProbe: createPosixArcVoiceOwnershipProbe(),
    gracefulStopTimeoutMs: 10_000,
    forceStopTimeoutMs: 5_000,
  });
  const service = new ArcVoiceRuntimeService({
    paths,
    release: ARC_VOICEBOX_RELEASE,
    manager,
    stage: ({ stagingDir }) =>
      stageArcVoiceboxComponentFromBundle({
        release: ARC_VOICEBOX_RELEASE,
        bundlePath: artifactPath as string,
        stagingDir,
      }),
    backend: "mlx",
    port,
    createdByArcVersion: "0.9.0",
    startupCheckTimeoutMs: 90_000,
    startupCheckIntervalMs: 250,
  });
  const prepared = await service.prepare();
  if (prepared.kind !== "ready") {
    throw new Error(`could not prepare the runtime: ${prepared.detail}`);
  }
  await mkdir(paths.dataDir, { recursive: true });
  return { paths, port, service, manager, spawnCalls };
}

async function orphanRuntime(runtime: LiveRuntime): Promise<number> {
  const config = {
    command: runtime.paths.executablePath,
    port: runtime.port,
    backend: "mlx" as const,
    modelsDir: runtime.paths.modelsRoot,
    dataDir: runtime.paths.dataDir,
  };
  const spec = {
    command: config.command,
    args: buildVoiceboxLaunchArgs(config),
    modelsEnv: VOICEBOX_MODELS_DIR_ENV,
    modelsDir: config.modelsDir,
  };
  const environment = buildVoiceboxEnvironment(config, {
    ...process.env,
    ARC_VOICE_ORPHAN_SPEC: JSON.stringify(spec),
  });
  await run(process.execPath, ["-e", ORPHANING_WORKER], environment);

  const baseUrl = `http://127.0.0.1:${runtime.port}`;
  const healthCheck = createArcVoiceHealthCheck({
    client: createFetchArcVoiceHttpClient(),
    baseUrl,
  });
  await waitFor(async () => {
    const health = await healthCheck();
    return health.kind === "healthy";
  }, 90_000);
  return 0;
}

afterAll(async () => {
  for (const root of disposableRoots.splice(0)) {
    const paths = createArcVoicePaths({ userDataPath: root });
    const listing = await run("ps", [
      "-axo",
      "pid=,ppid=,pgid=,lstart=,command=",
    ]);
    const leftover = parseArcVoiceProcessListing(listing).filter(
      (fingerprint) =>
        fingerprint.command.includes(paths.executablePath) &&
        fingerprint.command.includes(paths.dataDir),
    );
    for (const pgid of new Set(leftover.map((process_) => process_.pgid))) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        continue;
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

describe.skipIf(!artifactPresent)("real voicebox runtime ownership", () => {
  it("adopts the runtime a reaped worker left behind, then reuses and stops one tree", async () => {
    const runtime = await startLiveRuntime();
    const query = {
      port: runtime.port,
      executablePath: runtime.paths.executablePath,
      dataDir: runtime.paths.dataDir,
    };

    await orphanRuntime(runtime);

    const orphaned = await ownedVoiceProcesses(query);
    expect(orphaned).toHaveLength(2);
    const orphanGroup = orphaned[0]?.pgid;
    expect(new Set(orphaned.map((process_) => process_.pgid))).toEqual(
      new Set([orphanGroup]),
    );
    expect(new Set(orphaned.map((process_) => process_.ppid))).toContain(1);

    const probe = createPosixArcVoiceOwnershipProbe();
    const verdict = await probe.probe(query);
    expect(verdict.kind).toBe("owned");
    const orphanListenerPid =
      verdict.kind === "owned" ? verdict.listener?.pid : undefined;
    expect(orphanListenerPid).toBeGreaterThan(0);

    const adoptedStart = await runtime.manager.start(
      {
        command: runtime.paths.executablePath,
        port: runtime.port,
        backend: "mlx",
        modelsDir: runtime.paths.modelsRoot,
        dataDir: runtime.paths.dataDir,
      },
      { timeoutMs: 90_000, intervalMs: 250 },
    );

    expect(adoptedStart).toMatchObject({ kind: "ready", adopted: true });
    expect(runtime.manager.status().pid).toBe(orphanListenerPid);
    expect(runtime.spawnCalls).toHaveLength(0);
    const afterAdoption = await ownedVoiceProcesses(query);
    expect(new Set(afterAdoption.map((process_) => process_.pgid))).toEqual(
      new Set([orphanGroup]),
    );
    expect(afterAdoption).toHaveLength(orphaned.length);

    const started = await runtime.manager.start(
      {
        command: runtime.paths.executablePath,
        port: runtime.port,
        backend: "mlx",
        modelsDir: runtime.paths.modelsRoot,
        dataDir: runtime.paths.dataDir,
      },
      { timeoutMs: 5_000 },
    );
    expect(started.kind).toBe("failed");
    expect(runtime.spawnCalls).toHaveLength(0);

    const stopped = await runtime.manager.stop();
    expect(stopped.kind).toBe("stopped");
    await waitFor(
      async () => (await ownedVoiceProcesses(query)).length === 0,
      30_000,
    );
    expect(groupIsGone(orphanGroup ?? 0)).toBe(true);
    expect(await portIsClosed(runtime.port)).toBe(true);

    const restarted = await runtime.manager.start(
      {
        command: runtime.paths.executablePath,
        port: runtime.port,
        backend: "mlx",
        modelsDir: runtime.paths.modelsRoot,
        dataDir: runtime.paths.dataDir,
      },
      { timeoutMs: 90_000, intervalMs: 250 },
    );
    expect(restarted).toMatchObject({ kind: "ready" });
    expect(restarted.kind === "ready" ? restarted.adopted : true).toBeFalsy();
    expect(runtime.spawnCalls).toHaveLength(1);

    const fresh = await ownedVoiceProcesses(query);
    expect(new Set(fresh.map((process_) => process_.pgid)).size).toBe(1);

    const finalStop = await runtime.service.stop();
    expect(finalStop.kind).toBe("stopped");
    await waitFor(
      async () => (await ownedVoiceProcesses(query)).length === 0,
      30_000,
    );
    expect(await portIsClosed(runtime.port)).toBe(true);
  }, 180_000);

  it("refuses a port that a non-Arc process holds", async () => {
    const runtime = await startLiveRuntime();
    const server = createServer(() => {});
    await new Promise<void>((resolve) => {
      server.listen(runtime.port, "127.0.0.1", () => resolve());
    });
    try {
      const verdict = await createPosixArcVoiceOwnershipProbe().probe({
        port: runtime.port,
        executablePath: runtime.paths.executablePath,
        dataDir: runtime.paths.dataDir,
      });
      expect(verdict.kind).toBe("foreign");

      const started = await runtime.manager.start(
        {
          command: runtime.paths.executablePath,
          port: runtime.port,
          backend: "mlx",
          modelsDir: runtime.paths.modelsRoot,
          dataDir: runtime.paths.dataDir,
        },
        { timeoutMs: 5_000 },
      );
      expect(started.kind).toBe("failed");
      expect(started.kind === "failed" ? started.detail : "").toContain(
        "unowned process",
      );
      expect(runtime.spawnCalls).toHaveLength(0);
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }, 120_000);

  it("classifies the real process table without claiming a foreign listener", async () => {
    const runtime = await startLiveRuntime();
    const listing = await run("ps", [
      "-axo",
      "pid=,ppid=,pgid=,lstart=,command=",
    ]);

    const verdict = classifyArcVoiceOwnership({
      fingerprints: parseArcVoiceProcessListing(listing).filter(
        (fingerprint) =>
          fingerprint.command.includes(runtime.paths.executablePath) ||
          fingerprint.pid === process.pid,
      ),
      listenerPids: new Set(),
      query: {
        port: runtime.port,
        executablePath: runtime.paths.executablePath,
        dataDir: runtime.paths.dataDir,
      },
    });

    expect(verdict.kind).toBe("vacant");
  }, 60_000);
});
