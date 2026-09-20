import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverArcRuntimeUpdate } from "../src/arc-runtime/update-discovery.js";
import { createEmptyArcRuntimeManifest } from "../src/arc-runtime/manifest.js";
import { createArcRuntimePaths, type ArcRuntimePaths } from "../src/arc-runtime/paths.js";
import type { ArcRuntimeManifest } from "../src/arc-runtime/manifest.js";
import type { ArcRuntimeRelease } from "../src/arc-runtime/releases.js";

const PLATFORM = "darwin-arm64";
const CREATED_BY = "0.43.1";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makePaths(): Promise<ArcRuntimePaths> {
  const dir = await mkdtemp(join(tmpdir(), "arc-update-discovery-test-"));
  tempDirs.push(dir);
  return createArcRuntimePaths({ userDataPath: dir });
}

function manifestWith(
  overrides: Partial<{
    activeVersion: string | null;
    knownGoodVersion: string | null;
  }>,
): ArcRuntimeManifest {
  const manifest = createEmptyArcRuntimeManifest({
    createdByArcVersion: CREATED_BY,
    platform: PLATFORM,
  });
  manifest.runtimes.codex = {
    activeVersion: overrides.activeVersion ?? "0.155.1",
    previousVersion: null,
    knownGoodVersion: overrides.knownGoodVersion ?? "0.155.1",
    source: "arc-bundled",
    digest: "a".repeat(64),
    installedAt: 1,
  };
  return manifest;
}

function fakeCodexRelease(version: string): ArcRuntimeRelease {
  return {
    runtimeId: "codex",
    artifactKind: "archive",
    version,
    platform: PLATFORM,
    releaseTag: `rust-v${version}`,
    assetName: "codex-aarch64-apple-darwin.tar.gz",
    downloadUrl: `https://github.com/openai/codex/releases/download/rust-v${version}/codex-aarch64-apple-darwin.tar.gz`,
    sha256: "b".repeat(64),
    executableSha256: "b".repeat(64),
    expectedExecutableVersion: version,
    license: "Apache-2.0",
  };
}

describe("discoverArcRuntimeUpdate", () => {
  it("reports updateAvailable when a newer, compatible version is discovered", async () => {
    const paths = await makePaths();
    const result = await discoverArcRuntimeUpdate({
      runtimeId: "codex",
      manifest: manifestWith({}),
      runtimePaths: paths,
      compatibilityPolicy: {
        codex: { minimum: "0.136.0", maximumTested: "0.156.0" },
      },
      fetchLatestRelease: async () => fakeCodexRelease("0.156.0"),
    });

    expect(result.updateAvailable).toBe(true);
    expect(result.latestTrusted?.version).toBe("0.156.0");
    expect(result.latestTrustedCompatibility).toBe("supported");
  });

  it("does not report an update when the discovered version is already active", async () => {
    const paths = await makePaths();
    const result = await discoverArcRuntimeUpdate({
      runtimeId: "codex",
      manifest: manifestWith({}),
      runtimePaths: paths,
      fetchLatestRelease: async () => fakeCodexRelease("0.155.1"),
    });

    expect(result.updateAvailable).toBe(false);
  });

  it("does not report an update for a discovered version that is policy-blocked", async () => {
    const paths = await makePaths();
    const result = await discoverArcRuntimeUpdate({
      runtimeId: "codex",
      manifest: manifestWith({}),
      runtimePaths: paths,
      compatibilityPolicy: {
        codex: {
          minimum: "0.136.0",
          maximumTested: "0.157.0",
          blockedVersions: ["0.156.0"],
        },
      },
      fetchLatestRelease: async () => fakeCodexRelease("0.156.0"),
    });

    expect(result.updateAvailable).toBe(false);
    expect(result.latestTrustedCompatibility).toBe("blocked");
  });

  it("never installs, downloads, or writes the manifest (side-effect-free)", async () => {
    const paths = await makePaths();
    let fetchCalls = 0;

    await discoverArcRuntimeUpdate({
      runtimeId: "codex",
      manifest: manifestWith({}),
      runtimePaths: paths,
      fetchLatestRelease: async () => {
        fetchCalls += 1;
        return fakeCodexRelease("0.156.0");
      },
    });

    expect(fetchCalls).toBe(1);
    await expect(readFile(paths.manifestPath, "utf8")).rejects.toThrow(
      /ENOENT/,
    );
  });

  it("rejects a discovered release that fails trust validation instead of trusting it", async () => {
    const paths = await makePaths();
    const untrusted = {
      ...fakeCodexRelease("0.156.0"),
      downloadUrl: "https://evil.example/codex-aarch64-apple-darwin.tar.gz",
    };

    const result = await discoverArcRuntimeUpdate({
      runtimeId: "codex",
      manifest: manifestWith({}),
      runtimePaths: paths,
      fetchLatestRelease: async () => untrusted,
    });

    expect(result.latestTrusted).toBeNull();
    expect(result.updateAvailable).toBe(false);
    expect(result.discoveryError).toContain("trust validation");
  });

  it("reports discovery failure honestly instead of silently reporting no update", async () => {
    const paths = await makePaths();

    const result = await discoverArcRuntimeUpdate({
      runtimeId: "codex",
      manifest: manifestWith({}),
      runtimePaths: paths,
      fetchLatestRelease: async () => {
        throw new Error("network unreachable");
      },
    });

    expect(result.latestTrusted).toBeNull();
    expect(result.updateAvailable).toBe(false);
    expect(result.discoveryError).toBe("network unreachable");
  });

  it("reports rollbackAvailable exactly when knownGoodVersion differs from the active version", async () => {
    const paths = await makePaths();

    const noRollback = await discoverArcRuntimeUpdate({
      runtimeId: "codex",
      manifest: manifestWith({ activeVersion: "0.155.1", knownGoodVersion: "0.155.1" }),
      runtimePaths: paths,
      fetchLatestRelease: async () => null,
    });
    expect(noRollback.rollbackAvailable).toBe(false);

    const withRollback = await discoverArcRuntimeUpdate({
      runtimeId: "codex",
      manifest: manifestWith({ activeVersion: "0.156.0", knownGoodVersion: "0.155.1" }),
      runtimePaths: paths,
      fetchLatestRelease: async () => null,
    });
    expect(withRollback.rollbackAvailable).toBe(true);
  });

  it("lists installed versions from the filesystem", async () => {
    const paths = await makePaths();
    await mkdir(paths.versionRoot("codex", "0.155.1"), { recursive: true });
    await mkdir(paths.versionRoot("codex", "0.156.0"), { recursive: true });

    const result = await discoverArcRuntimeUpdate({
      runtimeId: "codex",
      manifest: manifestWith({}),
      runtimePaths: paths,
      fetchLatestRelease: async () => null,
    });

    expect(result.installedVersions).toEqual(["0.155.1", "0.156.0"]);
  });
});
