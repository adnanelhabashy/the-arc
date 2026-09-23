import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
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
  createArcVoicePaths,
  type ArcVoicePaths,
} from "../../src/paths.js";
import { createNodeArcVoiceProcessSpawner } from "../../src/process.js";
import { ARC_VOICEBOX_RELEASE } from "../../src/release.js";
import { ArcVoiceRuntimeManager } from "../../src/runtime-manager.js";
import { ArcVoiceRuntimeService } from "../../src/runtime.js";

const artifactPath = process.env["ARC_VOICEBOX_INTEGRATION_ARTIFACT"] ?? null;
const artifactPresent = artifactPath !== null && existsSync(artifactPath);

const disposableRoots: string[] = [];

interface LiveRuntime {
  paths: ArcVoicePaths;
  service: ArcVoiceRuntimeService;
  port: number;
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

function processGroupIsGone(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch {
    return true;
  }
}

function processGroupMembers(pid: number): Promise<number[]> {
  return new Promise<number[]>((resolve) => {
    execFile("pgrep", ["-g", String(pid)], (error, stdout) => {
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

async function startLiveRuntime(): Promise<LiveRuntime> {
  const root = await mkdtemp(join(tmpdir(), "arc-voice-integration-"));
  disposableRoots.push(root);
  const paths = createArcVoicePaths({ userDataPath: root });
  const port = await allocatePort();
  const bundlePath = artifactPath as string;
  const baseUrl = `http://127.0.0.1:${port}`;
  const http = createFetchArcVoiceHttpClient();

  await rm(paths.stagingVersionRoot(ARC_VOICEBOX_RELEASE.version), {
    recursive: true,
    force: true,
  });

  const manager = new ArcVoiceRuntimeManager({
    spawner: createNodeArcVoiceProcessSpawner(),
    client: createArcVoiceClient({ http, baseUrl }),
    healthCheck: createArcVoiceHealthCheck({ client: http, baseUrl }),
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
        bundlePath,
        stagingDir,
      }),
    backend: "mlx",
    port,
    createdByArcVersion: "0.9.0",
    startupCheckTimeoutMs: 90_000,
    startupCheckIntervalMs: 250,
  });
  return { paths, service, port };
}

afterAll(async () => {
  for (const root of disposableRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe.skipIf(!artifactPresent)("real voicebox process ownership", () => {
  it("runs the pinned component from Arc's own tree and leaves nothing behind", async () => {
    const { paths, service, port } = await startLiveRuntime();

    expect(await service.prepare()).toMatchObject({
      kind: "ready",
      version: "0.5.0",
    });
    expect(await service.start()).toMatchObject({ kind: "ready" });

    const status = await service.status();
    expect(status).toMatchObject({
      state: "ready",
      version: "0.5.0",
      installPath: paths.executablePath,
      healthState: "healthy",
      knownGoodVersion: "0.5.0",
      running: true,
    });
    const pid = status.pid;
    expect(pid).toBeGreaterThan(0);
    expect(await portIsClosed(port)).toBe(false);
    expect((await stat(join(paths.dataDir, "voicebox.db"))).isFile()).toBe(
      true,
    );

    expect(await service.stop()).toMatchObject({ kind: "stopped" });

    expect(await service.status()).toMatchObject({
      state: "stopped",
      running: false,
    });
    expect(await portIsClosed(port)).toBe(true);
    expect(processGroupIsGone(pid as number)).toBe(true);
    expect(
      await stat(paths.stagingVersionRoot(ARC_VOICEBOX_RELEASE.version)).catch(
        () => null,
      ),
    ).toBeNull();
  }, 300_000);

  it("kills the whole process group, not only the direct child", async () => {
    const { service, port } = await startLiveRuntime();

    expect(await service.start()).toMatchObject({ kind: "ready" });
    const pid = (await service.status()).pid as number;
    const members = await processGroupMembers(pid);
    expect(members.length).toBeGreaterThan(0);

    await service.stop();

    expect(await portIsClosed(port)).toBe(true);
    expect(processGroupIsGone(pid)).toBe(true);
    expect(await processGroupMembers(pid)).toEqual([]);
  }, 300_000);
});
