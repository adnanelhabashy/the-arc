import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateArcRuntimeVersion,
  promoteArcRuntimeKnownGood,
  rollbackArcRuntimeVersion,
} from "../src/arc-runtime/activation.js";
import { readArcRuntimeManifest } from "../src/arc-runtime/manifest.js";
import { createArcRuntimePaths, type ArcRuntimePaths } from "../src/arc-runtime/paths.js";

const PLATFORM = "darwin-arm64";
const CREATED_BY = "0.43.1";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arc-activation-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makePaths(): Promise<ArcRuntimePaths> {
  const dir = await tempDir();
  return createArcRuntimePaths({ userDataPath: dir });
}

async function stageExecutable(
  paths: ArcRuntimePaths,
  version: string,
): Promise<string> {
  const path = paths.executablePath("codex", version);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(path, 0o755);
  return path;
}

function baseArgs(paths: ArcRuntimePaths) {
  return {
    runtimeId: "codex" as const,
    createdByArcVersion: CREATED_BY,
    platform: PLATFORM,
    runtimePaths: paths,
  };
}

describe("activateArcRuntimeVersion", () => {
  it("activates a staged version, keeping previousVersion and knownGoodVersion untouched", async () => {
    const paths = await makePaths();
    await stageExecutable(paths, "0.155.1");
    await activateArcRuntimeVersion({
      ...baseArgs(paths),
      version: "0.155.1",
      source: "arc-bundled",
      digest: "a".repeat(64),
    });
    await promoteArcRuntimeKnownGood({ ...baseArgs(paths) });
    await stageExecutable(paths, "0.156.0");

    const result = await activateArcRuntimeVersion({
      ...baseArgs(paths),
      version: "0.156.0",
      source: "arc-managed-download",
      digest: "b".repeat(64),
    });

    expect(result).toEqual({ kind: "activated", version: "0.156.0" });
    const read = await readArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath: paths.manifestPath,
      platform: PLATFORM,
    });
    if (read.kind !== "ok") throw new Error("expected ok");
    expect(read.manifest.runtimes.codex.activeVersion).toBe("0.156.0");
    expect(read.manifest.runtimes.codex.previousVersion).toBe("0.155.1");
    expect(read.manifest.runtimes.codex.knownGoodVersion).toBe("0.155.1");
  });

  it("never deletes the previous version's directory", async () => {
    const paths = await makePaths();
    const oldPath = await stageExecutable(paths, "0.155.1");
    await activateArcRuntimeVersion({
      ...baseArgs(paths),
      version: "0.155.1",
      source: "arc-bundled",
      digest: "a".repeat(64),
    });
    await stageExecutable(paths, "0.156.0");
    await activateArcRuntimeVersion({
      ...baseArgs(paths),
      version: "0.156.0",
      source: "arc-managed-download",
      digest: "b".repeat(64),
    });

    await expect(
      chmod(oldPath, 0o755),
    ).resolves.toBeUndefined();
  });

  it("is idempotent when the version is already active", async () => {
    const paths = await makePaths();
    await stageExecutable(paths, "0.155.1");
    await activateArcRuntimeVersion({
      ...baseArgs(paths),
      version: "0.155.1",
      source: "arc-bundled",
      digest: "a".repeat(64),
    });

    const second = await activateArcRuntimeVersion({
      ...baseArgs(paths),
      version: "0.155.1",
      source: "arc-bundled",
      digest: "a".repeat(64),
    });

    expect(second).toEqual({ kind: "already-active", version: "0.155.1" });
  });

  it("fails when the candidate executable is missing (never activates a phantom version)", async () => {
    const paths = await makePaths();

    const result = await activateArcRuntimeVersion({
      ...baseArgs(paths),
      version: "0.156.0",
      source: "arc-managed-download",
      digest: "b".repeat(64),
    });

    expect(result.kind).toBe("failed");
    const read = await readArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath: paths.manifestPath,
      platform: PLATFORM,
    });
    if (read.kind !== "ok" && read.kind !== "missing") {
      throw new Error("expected ok or missing");
    }
    expect(read.manifest.runtimes.codex.activeVersion).toBeNull();
  });
});

describe("promoteArcRuntimeKnownGood", () => {
  it("promotes the active version to known-good", async () => {
    const paths = await makePaths();
    await stageExecutable(paths, "0.156.0");
    await activateArcRuntimeVersion({
      ...baseArgs(paths),
      version: "0.156.0",
      source: "arc-managed-download",
      digest: "b".repeat(64),
    });

    const result = await promoteArcRuntimeKnownGood({ ...baseArgs(paths) });

    expect(result).toEqual({ kind: "promoted", version: "0.156.0" });
    const read = await readArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath: paths.manifestPath,
      platform: PLATFORM,
    });
    if (read.kind !== "ok") throw new Error("expected ok");
    expect(read.manifest.runtimes.codex.knownGoodVersion).toBe("0.156.0");
  });

  it("does not become known-good simply because it is active (no promotion = no write)", async () => {
    const paths = await makePaths();
    await stageExecutable(paths, "0.156.0");
    await activateArcRuntimeVersion({
      ...baseArgs(paths),
      version: "0.156.0",
      source: "arc-managed-download",
      digest: "b".repeat(64),
    });

    const read = await readArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath: paths.manifestPath,
      platform: PLATFORM,
    });
    if (read.kind !== "ok") throw new Error("expected ok");
    expect(read.manifest.runtimes.codex.knownGoodVersion).toBeNull();
  });

  it("is idempotent once already known-good", async () => {
    const paths = await makePaths();
    await stageExecutable(paths, "0.156.0");
    await activateArcRuntimeVersion({
      ...baseArgs(paths),
      version: "0.156.0",
      source: "arc-managed-download",
      digest: "b".repeat(64),
    });
    await promoteArcRuntimeKnownGood({ ...baseArgs(paths) });

    const second = await promoteArcRuntimeKnownGood({ ...baseArgs(paths) });

    expect(second).toEqual({
      kind: "already-known-good",
      version: "0.156.0",
    });
  });
});

describe("rollbackArcRuntimeVersion", () => {
  it("reactivates knownGoodVersion without redownloading", async () => {
    const paths = await makePaths();
    await stageExecutable(paths, "0.155.1");
    await activateArcRuntimeVersion({
      ...baseArgs(paths),
      version: "0.155.1",
      source: "arc-bundled",
      digest: "a".repeat(64),
    });
    await promoteArcRuntimeKnownGood({ ...baseArgs(paths) });
    await stageExecutable(paths, "0.156.0");
    await activateArcRuntimeVersion({
      ...baseArgs(paths),
      version: "0.156.0",
      source: "arc-managed-download",
      digest: "b".repeat(64),
    });

    const result = await rollbackArcRuntimeVersion({ ...baseArgs(paths) });

    expect(result).toEqual({
      kind: "rolled-back",
      from: "0.156.0",
      to: "0.155.1",
    });
    const read = await readArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath: paths.manifestPath,
      platform: PLATFORM,
    });
    if (read.kind !== "ok") throw new Error("expected ok");
    expect(read.manifest.runtimes.codex.activeVersion).toBe("0.155.1");
    expect(read.manifest.runtimes.codex.knownGoodVersion).toBe("0.155.1");
  });

  it("reports unavailable instead of no-op when there is no known-good target", async () => {
    const paths = await makePaths();
    await stageExecutable(paths, "0.156.0");
    await activateArcRuntimeVersion({
      ...baseArgs(paths),
      version: "0.156.0",
      source: "arc-managed-download",
      digest: "b".repeat(64),
    });

    const result = await rollbackArcRuntimeVersion({ ...baseArgs(paths) });

    expect(result.kind).toBe("unavailable");
  });

  it("reports unavailable (never a silent no-op or a fresh install) when the known-good binary was deleted from disk", async () => {
    const paths = await makePaths();
    await stageExecutable(paths, "0.155.1");
    await activateArcRuntimeVersion({
      ...baseArgs(paths),
      version: "0.155.1",
      source: "arc-bundled",
      digest: "a".repeat(64),
    });
    await promoteArcRuntimeKnownGood({ ...baseArgs(paths) });
    await stageExecutable(paths, "0.156.0");
    await activateArcRuntimeVersion({
      ...baseArgs(paths),
      version: "0.156.0",
      source: "arc-managed-download",
      digest: "b".repeat(64),
    });
    await rm(paths.versionRoot("codex", "0.155.1"), {
      recursive: true,
      force: true,
    });

    const result = await rollbackArcRuntimeVersion({ ...baseArgs(paths) });

    expect(result.kind).toBe("unavailable");
    const read = await readArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath: paths.manifestPath,
      platform: PLATFORM,
    });
    if (read.kind !== "ok") throw new Error("expected ok");
    expect(read.manifest.runtimes.codex.activeVersion).toBe("0.156.0");
  });
});
