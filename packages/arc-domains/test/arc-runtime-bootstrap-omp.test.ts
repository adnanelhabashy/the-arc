import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareArcManagedRuntimes } from "../src/arc-runtime/bootstrap.js";
import { sha256File } from "../src/arc-runtime/digest.js";
import {
  readArcRuntimeManifest,
  writeArcRuntimeManifest,
  createEmptyArcRuntimeManifest,
  type ArcRuntimeManifest,
} from "../src/arc-runtime/manifest.js";
import {
  createArcRuntimePaths,
  type ArcRuntimePaths,
} from "../src/arc-runtime/paths.js";
import type { ArcRuntimeRelease } from "../src/arc-runtime/releases.js";

const VERSION = "18.2.6";
const PLATFORM = "darwin-arm64";
const CREATED_BY = "0.43.1";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arc-omp-bootstrap-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface Fixture {
  userDataPath: string;
  seedRoot: string;
  paths: ArcRuntimePaths;
  release: ArcRuntimeRelease;
}

async function makeFixture(): Promise<Fixture> {
  const root = await tempDir();
  const userDataPath = join(root, "userData");
  const seedRoot = join(root, "seed");
  const seedPath = join(seedRoot, "omp", VERSION, "omp");
  await mkdir(dirname(seedPath), { recursive: true });
  await writeFile(seedPath, `#!/bin/sh\necho "omp/${VERSION}"\n`, "utf8");
  await chmod(seedPath, 0o755);
  const release: ArcRuntimeRelease = {
    runtimeId: "omp",
    artifactKind: "executable",
    version: VERSION,
    platform: PLATFORM,
    releaseTag: "v18.2.6",
    assetName: "omp-darwin-arm64",
    downloadUrl:
      "https://github.com/can1357/oh-my-pi/releases/download/v18.2.6/omp-darwin-arm64",
    sha256: await sha256File(seedPath),
    executableSha256: await sha256File(seedPath),
    expectedExecutableVersion: VERSION,
    license: "MIT",
  };
  return {
    userDataPath,
    seedRoot,
    paths: createArcRuntimePaths({ userDataPath }),
    release,
  };
}

async function readManifest(fixture: Fixture): Promise<ArcRuntimeManifest> {
  const result = await readArcRuntimeManifest({
    createdByArcVersion: CREATED_BY,
    manifestPath: fixture.paths.manifestPath,
    platform: PLATFORM,
  });
  if (result.kind === "unsupported-version") {
    throw new Error("unexpected unsupported-version manifest");
  }
  return result.manifest;
}

function runBootstrap(fixture: Fixture) {
  return prepareArcManagedRuntimes({
    createdByArcVersion: CREATED_BY,
    platform: PLATFORM,
    releases: [fixture.release],
    runtimePaths: fixture.paths,
    seedRoot: fixture.seedRoot,
  });
}

describe("prepareArcManagedRuntimes — OMP", () => {
  it("installs and activates the pinned OMP from a valid seed", async () => {
    const fixture = await makeFixture();
    const results = await runBootstrap(fixture);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      runtimeId: "omp",
      action: "installed",
    });

    const manifest = await readManifest(fixture);
    const entry = manifest.runtimes.omp;
    expect(entry.activeVersion).toBe(VERSION);
    expect(entry.source).toBe("arc-bundled");
    expect(entry.digest).toBe(fixture.release.executableSha256);
    expect(entry.previousVersion).toBeNull();
    expect(typeof entry.installedAt).toBe("number");
  });

  it("is idempotent across restarts", async () => {
    const fixture = await makeFixture();
    await runBootstrap(fixture);
    const firstManifest = await readManifest(fixture);

    const results = await runBootstrap(fixture);
    expect(results[0].action).toBe("already-active");

    const secondManifest = await readManifest(fixture);
    expect(secondManifest.runtimes.omp.installedAt).toBe(
      firstManifest.runtimes.omp.installedAt,
    );
  });

  it("repairs a same-version managed OMP missing its executable", async () => {
    const fixture = await makeFixture();
    await runBootstrap(fixture);
    const managedPath = fixture.paths.executablePath("omp", VERSION);
    await rm(managedPath);

    const results = await runBootstrap(fixture);
    expect(results[0].action).toBe("repaired");

    const manifest = await readManifest(fixture);
    expect(manifest.runtimes.omp.activeVersion).toBe(VERSION);
    await expect(access(managedPath, constants.X_OK)).resolves.toBeUndefined();
  });

  it("never force-downgrades a valid newer active OMP", async () => {
    const fixture = await makeFixture();
    const manifest = createEmptyArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      platform: PLATFORM,
    });
    manifest.runtimes.omp = {
      activeVersion: "18.3.0",
      previousVersion: null,
      knownGoodVersion: "18.3.0",
      source: "arc-managed-download",
      digest: "0".repeat(64),
      componentsByVersion: {},
      installedAt: Date.now(),
    };
    await writeArcRuntimeManifest({
      manifest,
      manifestPath: fixture.paths.manifestPath,
    });
    const newerPath = fixture.paths.executablePath("omp", "18.3.0");
    await mkdir(dirname(newerPath), { recursive: true });
    await writeFile(newerPath, `#!/bin/sh\necho "omp/18.3.0"\n`, "utf8");
    await chmod(newerPath, 0o755);

    const results = await runBootstrap(fixture);
    expect(results[0].action).toBe("kept-existing");

    const after = await readManifest(fixture);
    expect(after.runtimes.omp.activeVersion).toBe("18.3.0");
  });

  it("reports a broken different active version without silently replacing it", async () => {
    const fixture = await makeFixture();
    const manifest = createEmptyArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      platform: PLATFORM,
    });
    manifest.runtimes.omp = {
      activeVersion: "18.3.0",
      previousVersion: null,
      knownGoodVersion: "18.3.0",
      source: "arc-managed-download",
      digest: "0".repeat(64),
      componentsByVersion: {},
      installedAt: Date.now(),
    };
    await writeArcRuntimeManifest({
      manifest,
      manifestPath: fixture.paths.manifestPath,
    });

    const results = await runBootstrap(fixture);
    expect(results[0].action).toBe("kept-broken");
  });

  it("keeps the manifest untouched when the seed digest does not match the pin", async () => {
    const fixture = await makeFixture();
    const tamperedRelease: ArcRuntimeRelease = {
      ...fixture.release,
      executableSha256: "1".repeat(64),
    };

    const results = await prepareArcManagedRuntimes({
      createdByArcVersion: CREATED_BY,
      platform: PLATFORM,
      releases: [tamperedRelease],
      runtimePaths: fixture.paths,
      seedRoot: fixture.seedRoot,
    });
    expect(results[0].action).toBe("failed");

    const manifestResult = await readArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath: fixture.paths.manifestPath,
      platform: PLATFORM,
    });
    if (manifestResult.kind === "unsupported-version") {
      throw new Error("unexpected unsupported-version manifest");
    }
    expect(manifestResult.manifest.runtimes.omp.activeVersion).toBeNull();
  });
});
