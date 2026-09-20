import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateArcRuntimeVersion,
  promoteArcRuntimeKnownGood,
} from "../src/arc-runtime/activation.js";
import { createEmptyArcRuntimeManifest, readArcRuntimeManifest } from "../src/arc-runtime/manifest.js";
import { createArcRuntimePaths, type ArcRuntimePaths } from "../src/arc-runtime/paths.js";
import type { ArcRuntimeManifest } from "../src/arc-runtime/manifest.js";
import type { ArcRuntimeRelease } from "../src/arc-runtime/releases.js";
import { updateArcRuntime } from "../src/arc-runtime/update.js";

const PLATFORM = "darwin-arm64";
const CREATED_BY = "0.43.1";
const SCRIPT = "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo omp/18.3.0; else exit 0; fi\n";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makePaths(): Promise<ArcRuntimePaths> {
  const dir = await mkdtemp(join(tmpdir(), "arc-update-test-"));
  tempDirs.push(dir);
  return createArcRuntimePaths({ userDataPath: dir });
}

function digestOf(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

function fakeRelease(overrides: Partial<ArcRuntimeRelease> = {}): ArcRuntimeRelease {
  const digest = digestOf(SCRIPT);
  return {
    runtimeId: "omp",
    artifactKind: "executable",
    version: "18.3.0",
    platform: PLATFORM,
    releaseTag: "v18.3.0",
    assetName: "omp-darwin-arm64",
    downloadUrl:
      "https://github.com/can1357/oh-my-pi/releases/download/v18.3.0/omp-darwin-arm64",
    sha256: digest,
    executableSha256: digest,
    expectedExecutableVersion: "18.3.0",
    license: "MIT",
    ...overrides,
  };
}

async function emptyManifest(): Promise<ArcRuntimeManifest> {
  return createEmptyArcRuntimeManifest({
    createdByArcVersion: CREATED_BY,
    platform: PLATFORM,
  });
}

async function activateInitial(paths: ArcRuntimePaths): Promise<void> {
  const path = paths.executablePath("omp", "18.2.6");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo omp/18.2.6; else exit 0; fi\n", "utf8");
  await chmod(path, 0o755);
  await activateArcRuntimeVersion({
    runtimeId: "omp",
    version: "18.2.6",
    source: "arc-bundled",
    digest: "a".repeat(64),
    createdByArcVersion: CREATED_BY,
    platform: PLATFORM,
    runtimePaths: paths,
  });
  await promoteArcRuntimeKnownGood({
    runtimeId: "omp",
    createdByArcVersion: CREATED_BY,
    platform: PLATFORM,
    runtimePaths: paths,
  });
}

function fakeDownload(content: string) {
  return async (_url: string, destinationPath: string): Promise<void> => {
    await writeFile(destinationPath, content, "utf8");
  };
}

describe("updateArcRuntime", () => {
  it("updates, activates and promotes to known-good on a healthy candidate", async () => {
    const paths = await makePaths();
    await activateInitial(paths);
    const manifestRead = await readArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath: paths.manifestPath,
      platform: PLATFORM,
    });
    if (manifestRead.kind !== "ok") throw new Error("expected ok");

    const outcome = await updateArcRuntime({
      runtimeId: "omp",
      manifest: manifestRead.manifest,
      createdByArcVersion: CREATED_BY,
      platform: PLATFORM,
      runtimePaths: paths,
      fetchLatestRelease: async () => fakeRelease(),
      download: fakeDownload(SCRIPT),
      compatibilityPolicy: { omp: { minimum: "18.2.6", maximumTested: "18.3.0" } },
      probeHealth: async () => ({ kind: "healthy", detail: "ok" }),
    });

    expect(outcome).toEqual({
      kind: "updated",
      version: "18.3.0",
      detail: expect.stringContaining("18.3.0"),
    });
    const after = await readArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath: paths.manifestPath,
      platform: PLATFORM,
    });
    if (after.kind !== "ok") throw new Error("expected ok");
    expect(after.manifest.runtimes.omp.activeVersion).toBe("18.3.0");
    expect(after.manifest.runtimes.omp.previousVersion).toBe("18.2.6");
    expect(after.manifest.runtimes.omp.knownGoodVersion).toBe("18.3.0");
  });

  it("reports up-to-date without touching the manifest when no update is available", async () => {
    const paths = await makePaths();
    await activateInitial(paths);
    const manifestRead = await readArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath: paths.manifestPath,
      platform: PLATFORM,
    });
    if (manifestRead.kind !== "ok") throw new Error("expected ok");

    const outcome = await updateArcRuntime({
      runtimeId: "omp",
      manifest: manifestRead.manifest,
      createdByArcVersion: CREATED_BY,
      platform: PLATFORM,
      runtimePaths: paths,
      fetchLatestRelease: async () => fakeRelease({ version: "18.2.6" }),
    });

    expect(outcome).toEqual({ kind: "up-to-date", version: "18.2.6" });
  });

  it("leaves the current runtime intact when staging (digest mismatch) fails", async () => {
    const paths = await makePaths();
    await activateInitial(paths);
    const manifestRead = await readArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath: paths.manifestPath,
      platform: PLATFORM,
    });
    if (manifestRead.kind !== "ok") throw new Error("expected ok");

    const outcome = await updateArcRuntime({
      runtimeId: "omp",
      manifest: manifestRead.manifest,
      createdByArcVersion: CREATED_BY,
      platform: PLATFORM,
      runtimePaths: paths,
      fetchLatestRelease: async () => fakeRelease(),
      download: fakeDownload("corrupted content, wrong digest"),
      compatibilityPolicy: { omp: { minimum: "18.2.6", maximumTested: "18.3.0" } },
    });

    expect(outcome.kind).toBe("staging-failed");
    const after = await readArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath: paths.manifestPath,
      platform: PLATFORM,
    });
    if (after.kind !== "ok") throw new Error("expected ok");
    expect(after.manifest.runtimes.omp.activeVersion).toBe("18.2.6");
  });

  it("never stages a candidate that fails even the basic version probe", async () => {
    const paths = await makePaths();
    await activateInitial(paths);
    const manifestRead = await readArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath: paths.manifestPath,
      platform: PLATFORM,
    });
    if (manifestRead.kind !== "ok") throw new Error("expected ok");
    const brokenScript = "#!/bin/sh\nexit 1\n";

    const outcome = await updateArcRuntime({
      runtimeId: "omp",
      manifest: manifestRead.manifest,
      createdByArcVersion: CREATED_BY,
      platform: PLATFORM,
      runtimePaths: paths,
      fetchLatestRelease: async () =>
        fakeRelease({ sha256: digestOf(brokenScript), executableSha256: digestOf(brokenScript) }),
      download: fakeDownload(brokenScript),
      compatibilityPolicy: { omp: { minimum: "18.2.6", maximumTested: "18.3.0" } },
    });

    expect(outcome.kind).toBe("staging-failed");
    const after = await readArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath: paths.manifestPath,
      platform: PLATFORM,
    });
    if (after.kind !== "ok") throw new Error("expected ok");
    expect(after.manifest.runtimes.omp.activeVersion).toBe("18.2.6");
  });

  it("never activates a candidate that stages fine but fails the richer pre-activation health probe", async () => {
    const paths = await makePaths();
    await activateInitial(paths);
    const manifestRead = await readArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath: paths.manifestPath,
      platform: PLATFORM,
    });
    if (manifestRead.kind !== "ok") throw new Error("expected ok");

    const outcome = await updateArcRuntime({
      runtimeId: "omp",
      manifest: manifestRead.manifest,
      createdByArcVersion: CREATED_BY,
      platform: PLATFORM,
      runtimePaths: paths,
      fetchLatestRelease: async () => fakeRelease(),
      download: fakeDownload(SCRIPT),
      compatibilityPolicy: { omp: { minimum: "18.2.6", maximumTested: "18.3.0" } },
      probeHealth: async () => ({
        kind: "unhealthy",
        detail: "acp handshake never answered",
      }),
    });

    expect(outcome.kind).toBe("pre-activation-health-failed");
    const after = await readArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath: paths.manifestPath,
      platform: PLATFORM,
    });
    if (after.kind !== "ok") throw new Error("expected ok");
    expect(after.manifest.runtimes.omp.activeVersion).toBe("18.2.6");
  });

  it("rolls back automatically when the newly-activated version fails its post-activation health probe", async () => {
    const paths = await makePaths();
    await activateInitial(paths);
    const manifestRead = await readArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath: paths.manifestPath,
      platform: PLATFORM,
    });
    if (manifestRead.kind !== "ok") throw new Error("expected ok");

    let probeCalls = 0;
    const outcome = await updateArcRuntime({
      runtimeId: "omp",
      manifest: manifestRead.manifest,
      createdByArcVersion: CREATED_BY,
      platform: PLATFORM,
      runtimePaths: paths,
      fetchLatestRelease: async () => fakeRelease(),
      download: fakeDownload(SCRIPT),
      compatibilityPolicy: { omp: { minimum: "18.2.6", maximumTested: "18.3.0" } },
      probeHealth: async () => {
        probeCalls += 1;
        return probeCalls === 1
          ? { kind: "healthy", detail: "pre-activation probe" }
          : { kind: "unhealthy", detail: "acp handshake never answered" };
      },
    });

    expect(probeCalls).toBe(2);
    expect(outcome.kind).toBe("post-activation-unhealthy-rolled-back");
    if (outcome.kind === "post-activation-unhealthy-rolled-back") {
      expect(outcome.from).toBe("18.3.0");
      expect(outcome.to).toBe("18.2.6");
    }
    const after = await readArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath: paths.manifestPath,
      platform: PLATFORM,
    });
    if (after.kind !== "ok") throw new Error("expected ok");
    expect(after.manifest.runtimes.omp.activeVersion).toBe("18.2.6");
  });

  it("reports no-rollback-target when an unhealthy first-ever activation has nothing known-good to fall back to", async () => {
    const paths = await makePaths();
    const manifest = await emptyManifest();

    let probeCalls = 0;
    const outcome = await updateArcRuntime({
      runtimeId: "omp",
      manifest,
      createdByArcVersion: CREATED_BY,
      platform: PLATFORM,
      runtimePaths: paths,
      fetchLatestRelease: async () => fakeRelease(),
      download: fakeDownload(SCRIPT),
      compatibilityPolicy: { omp: { minimum: "18.3.0", maximumTested: "18.3.0" } },
      probeHealth: async () => {
        probeCalls += 1;
        return probeCalls === 1
          ? { kind: "healthy", detail: "pre-activation probe" }
          : { kind: "unhealthy", detail: "acp handshake never answered" };
      },
    });

    expect(outcome.kind).toBe("post-activation-unhealthy-no-rollback-target");
  });

  it("reports no-trusted-update honestly when discovery fails, without touching anything", async () => {
    const paths = await makePaths();
    await activateInitial(paths);
    const manifestRead = await readArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath: paths.manifestPath,
      platform: PLATFORM,
    });
    if (manifestRead.kind !== "ok") throw new Error("expected ok");

    const outcome = await updateArcRuntime({
      runtimeId: "omp",
      manifest: manifestRead.manifest,
      createdByArcVersion: CREATED_BY,
      platform: PLATFORM,
      runtimePaths: paths,
      fetchLatestRelease: async () => {
        throw new Error("network unreachable");
      },
    });

    expect(outcome).toEqual({
      kind: "no-trusted-update",
      reason: "network unreachable",
    });
  });
});
