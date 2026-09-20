import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { downloadAndStageArcRuntimeRelease } from "../src/arc-runtime/update-download.js";
import { createArcRuntimePaths, type ArcRuntimePaths } from "../src/arc-runtime/paths.js";
import type { ArcRuntimeRelease } from "../src/arc-runtime/releases.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arc-update-download-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makePaths(): Promise<ArcRuntimePaths> {
  return createArcRuntimePaths({ userDataPath: await tempDir() });
}

const SCRIPT = "#!/bin/sh\necho omp/18.3.0\n";

function fakeRelease(overrides: Partial<ArcRuntimeRelease> = {}): ArcRuntimeRelease {
  const content = Buffer.from(SCRIPT, "utf8");
  const digest = createHash("sha256").update(content).digest("hex");
  return {
    runtimeId: "omp",
    artifactKind: "executable",
    version: "18.3.0",
    platform: "darwin-arm64",
    releaseTag: "v18.3.0",
    assetName: "omp-darwin-arm64",
    downloadUrl: "https://github.com/can1357/oh-my-pi/releases/download/v18.3.0/omp-darwin-arm64",
    sha256: digest,
    executableSha256: digest,
    expectedExecutableVersion: "18.3.0",
    license: "MIT",
    ...overrides,
  };
}

function fakeDownloadWriting(content: string) {
  return async (_url: string, destinationPath: string): Promise<void> => {
    await writeFile(destinationPath, content, "utf8");
  };
}

describe("downloadAndStageArcRuntimeRelease", () => {
  it("downloads, verifies, and stages a candidate without touching the active runtime", async () => {
    const paths = await makePaths();
    const release = fakeRelease();

    const result = await downloadAndStageArcRuntimeRelease({
      release,
      runtimePaths: paths,
      download: fakeDownloadWriting(SCRIPT),
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.version).toBe("18.3.0");
    expect(result.digest).toBe(release.executableSha256);
  });

  it("rejects and cleans up staging when the downloaded digest does not match", async () => {
    const paths = await makePaths();
    const release = fakeRelease();

    const result = await downloadAndStageArcRuntimeRelease({
      release,
      runtimePaths: paths,
      download: fakeDownloadWriting("this is not the pinned content"),
    });

    expect(result.kind).toBe("rejected");
    const staged = await readdir(paths.stagingRoot).catch(() => []);
    expect(staged.length).toBe(0);
  });

  it("rejects and cleans up staging when the download itself fails", async () => {
    const paths = await makePaths();
    const release = fakeRelease();

    const result = await downloadAndStageArcRuntimeRelease({
      release,
      runtimePaths: paths,
      download: async () => {
        throw new Error("network unreachable");
      },
    });

    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.reason).toContain("download failed");
    }
    const staged = await readdir(paths.stagingRoot).catch(() => []);
    expect(staged.length).toBe(0);
  });

  it("rejects when a runtime-specific verification hook fails (e.g. codesign), leaving no candidate behind", async () => {
    const paths = await makePaths();
    const release = fakeRelease();

    const result = await downloadAndStageArcRuntimeRelease({
      release,
      runtimePaths: paths,
      download: fakeDownloadWriting(SCRIPT),
      verifyExecutable: async () => false,
      verifyExecutableFailureReason: "code signature invalid",
    });

    expect(result).toEqual({
      kind: "rejected",
      reason: "code signature invalid",
    });
    const staged = await readdir(paths.stagingRoot).catch(() => []);
    expect(staged.length).toBe(0);
  });

  it("rejects invalid pinned release metadata before ever downloading", async () => {
    const paths = await makePaths();
    let downloadCalled = false;

    const result = await downloadAndStageArcRuntimeRelease({
      release: fakeRelease({ downloadUrl: "http://insecure.example/asset" }),
      runtimePaths: paths,
      download: async () => {
        downloadCalled = true;
      },
    });

    expect(result.kind).toBe("rejected");
    expect(downloadCalled).toBe(false);
  });
});
