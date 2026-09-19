import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareArcManagedRuntimes } from "../src/arc-runtime/bootstrap.js";
import { sha256File } from "../src/arc-runtime/digest.js";
import {
  buildArcManagedRuntimeEnvironment,
  resolveActiveArcRuntimes,
} from "../src/arc-runtime/environment.js";
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

const VERSION = "0.155.1";
const PLATFORM = "darwin-arm64";
const CREATED_BY = "0.43.1";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arc-bootstrap-test-"));
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
  seedPath: string;
  release: ArcRuntimeRelease;
  paths: ArcRuntimePaths;
}

async function makeFixture(
  seedContent: string = `#!/bin/sh\necho "codex-cli ${VERSION}"\n`,
): Promise<Fixture> {
  const root = await tempDir();
  const userDataPath = join(root, "userData");
  const seedRoot = join(root, "seed");
  const seedPath = join(seedRoot, "codex", VERSION, "codex");
  await mkdir(dirname(seedPath), { recursive: true });
  await writeFile(seedPath, seedContent, "utf8");
  await chmod(seedPath, 0o755);
  const release: ArcRuntimeRelease = {
    runtimeId: "codex",
    artifactKind: "archive",
    version: VERSION,
    platform: PLATFORM,
    releaseTag: "rust-v0.155.1",
    assetName: "codex-aarch64-apple-darwin.tar.gz",
    downloadUrl:
      "https://github.com/openai/codex/releases/download/rust-v0.155.1/codex-aarch64-apple-darwin.tar.gz",
    sha256: "0".repeat(64),
    executableSha256: await sha256File(seedPath),
    expectedExecutableVersion: VERSION,
    license: "Apache-2.0",
  };
  return {
    userDataPath,
    seedRoot,
    seedPath,
    release,
    paths: createArcRuntimePaths({ userDataPath }),
  };
}

async function readManifest(
  fixture: Fixture,
): Promise<ArcRuntimeManifest> {
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

async function writeManifest(
  fixture: Fixture,
  configure: (manifest: ArcRuntimeManifest) => void,
): Promise<void> {
  const manifest = createEmptyArcRuntimeManifest({
    createdByArcVersion: CREATED_BY,
    platform: PLATFORM,
  });
  configure(manifest);
  await writeArcRuntimeManifest({
    manifest,
    manifestPath: fixture.paths.manifestPath,
  });
}

async function runBootstrap(fixture: Fixture) {
  return prepareArcManagedRuntimes({
    createdByArcVersion: CREATED_BY,
    platform: PLATFORM,
    releases: [fixture.release],
    runtimePaths: fixture.paths,
    seedRoot: fixture.seedRoot,
  });
}

async function makeRunnableCodex(
  fixture: Fixture,
  version: string,
  content?: string,
): Promise<string> {
  const executablePath = fixture.paths.executablePath("codex", version);
  await mkdir(dirname(executablePath), { recursive: true });
  await writeFile(
    executablePath,
    content ?? `#!/bin/sh\necho "codex-cli ${version}"\n`,
    "utf8",
  );
  await chmod(executablePath, 0o755);
  return executablePath;
}

describe("prepareArcManagedRuntimes — fresh install", () => {
  it("A: installs and activates the pinned version from a valid seed", async () => {
    const fixture = await makeFixture();
    const results = await runBootstrap(fixture);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("installed");

    const manifest = await readManifest(fixture);
    const entry = manifest.runtimes.codex;
    expect(entry.activeVersion).toBe(VERSION);
    expect(entry.previousVersion).toBeNull();
    expect(entry.source).toBe("arc-bundled");
    expect(entry.digest).toBe(fixture.release.executableSha256);
    expect(entry.installedAt).toEqual(expect.any(Number));

    const executablePath = fixture.paths.executablePath("codex", VERSION);
    await expect(readFile(executablePath, "utf8")).resolves.toEqual(
      await readFile(fixture.seedPath, "utf8"),
    );
  });

  it("reports seed-missing and does not create a manifest", async () => {
    const fixture = await makeFixture();
    await rm(fixture.seedPath);
    const results = await runBootstrap(fixture);
    expect(results[0].action).toBe("seed-missing");
    await expect(readFile(fixture.paths.manifestPath, "utf8")).rejects.toThrow();
  });
});

describe("prepareArcManagedRuntimes — idempotence", () => {
  it("B: reuses an already-active verified runtime without rewriting it", async () => {
    const fixture = await makeFixture();
    await runBootstrap(fixture);
    const firstManifest = await readManifest(fixture);
    const executablePath = fixture.paths.executablePath("codex", VERSION);
    const firstContent = await readFile(executablePath, "utf8");

    const results = await runBootstrap(fixture);
    expect(results[0].action).toBe("already-active");

    const secondManifest = await readManifest(fixture);
    expect(secondManifest.runtimes.codex.installedAt).toBe(
      firstManifest.runtimes.codex.installedAt,
    );
    await expect(readFile(executablePath, "utf8")).resolves.toEqual(
      firstContent,
    );
  });
});

describe("prepareArcManagedRuntimes — same-version repair", () => {
  it("C: repairs a missing managed binary from the trusted seed", async () => {
    const fixture = await makeFixture();
    await runBootstrap(fixture);
    const beforeManifest = await readManifest(fixture);
    const executablePath = fixture.paths.executablePath("codex", VERSION);
    await rm(executablePath);

    const results = await runBootstrap(fixture);
    expect(results[0].action).toBe("repaired");

    const manifest = await readManifest(fixture);
    expect(manifest.runtimes.codex.activeVersion).toBe(VERSION);
    expect(manifest.runtimes.codex.previousVersion).toBe(
      beforeManifest.runtimes.codex.previousVersion,
    );
    await expect(readFile(executablePath, "utf8")).resolves.toEqual(
      await readFile(fixture.seedPath, "utf8"),
    );
  });
});

describe("prepareArcManagedRuntimes — existing different version", () => {
  it("D: keeps a valid newer active runtime without downgrading", async () => {
    const fixture = await makeFixture();
    const newerPath = await makeRunnableCodex(fixture, "0.156.0");
    const newerContent = await readFile(newerPath, "utf8");
    const newerDigest = await sha256File(newerPath);
    await writeManifest(fixture, (manifest) => {
      manifest.runtimes.codex.activeVersion = "0.156.0";
      manifest.runtimes.codex.source = "arc-managed-download";
      manifest.runtimes.codex.digest = newerDigest;
      manifest.runtimes.codex.installedAt = 1_700_000_000_000;
    });

    const results = await runBootstrap(fixture);
    expect(results[0].action).toBe("kept-existing");
    expect(results[0].detail).toContain("will not force a downgrade");

    const manifest = await readManifest(fixture);
    expect(manifest.runtimes.codex.activeVersion).toBe("0.156.0");
    await expect(readFile(newerPath, "utf8")).resolves.toEqual(newerContent);
    await expect(
      readFile(fixture.paths.executablePath("codex", VERSION), "utf8"),
    ).rejects.toThrow();
  });

  it("E: keeps a broken different-version runtime without silently replacing it", async () => {
    const fixture = await makeFixture();
    await writeManifest(fixture, (manifest) => {
      manifest.runtimes.codex.activeVersion = "0.156.0";
      manifest.runtimes.codex.source = "arc-managed-download";
      manifest.runtimes.codex.installedAt = 1_700_000_000_000;
    });

    const results = await runBootstrap(fixture);
    expect(results[0].action).toBe("kept-broken");

    const manifest = await readManifest(fixture);
    expect(manifest.runtimes.codex.activeVersion).toBe("0.156.0");
    await expect(
      readFile(fixture.paths.executablePath("codex", VERSION), "utf8"),
    ).rejects.toThrow();
  });
});

describe("prepareArcManagedRuntimes — failures never activate", () => {
  it("F: a copy failure leaves the manifest unchanged", async () => {
    const fixture = await makeFixture();
    await mkdir(join(fixture.userDataPath, "arc-runtimes", "runtimes"), {
      recursive: true,
    });
    await writeFile(
      join(fixture.userDataPath, "arc-runtimes", "runtimes", "codex"),
      "not a directory",
      "utf8",
    );

    const results = await runBootstrap(fixture);
    expect(results[0].action).toBe("failed");
    await expect(readFile(fixture.paths.manifestPath, "utf8")).rejects.toThrow();
  });

  it("G: a seed digest failure leaves the manifest unchanged", async () => {
    const fixture = await makeFixture();
    await writeFile(
      fixture.seedPath,
      `#!/bin/sh\necho "codex-cli ${VERSION}" # tampered\n`,
      "utf8",
    );
    await chmod(fixture.seedPath, 0o755);

    const results = await runBootstrap(fixture);
    expect(results[0].action).toBe("failed");
    expect(results[0].detail).toContain("digest mismatch");
    await expect(readFile(fixture.paths.manifestPath, "utf8")).rejects.toThrow();
  });

  it("H: a seed version-probe failure leaves the manifest unchanged", async () => {
    const fixture = await makeFixture("#!/bin/sh\necho hello\n");
    const results = await runBootstrap(fixture);
    expect(results[0].action).toBe("failed");
    expect(results[0].detail).toContain("version probe failed");
    await expect(readFile(fixture.paths.manifestPath, "utf8")).rejects.toThrow();
  });
});

describe("prepareArcManagedRuntimes — end-to-end resolution", () => {
  it("a fresh install produces a runtime that resolves and reports the pinned version", async () => {
    const fixture = await makeFixture();
    await runBootstrap(fixture);

    const activeRuntimes = await resolveActiveArcRuntimes({
      createdByArcVersion: CREATED_BY,
      platform: PLATFORM,
      runtimePaths: fixture.paths,
    });
    const env = buildArcManagedRuntimeEnvironment({
      activeRuntimes,
      env: { PATH: "/usr/bin:/bin" },
      platform: "darwin",
      runtimePaths: fixture.paths,
    });

    const output = await new Promise<string>((resolvePromise, rejectPromise) => {
      execFile(
        "codex",
        ["--version"],
        { env: { ...env, HOME: fixture.userDataPath } },
        (error, stdout) => {
          if (error !== null) {
            rejectPromise(error);
            return;
          }
          resolvePromise(stdout);
        },
      );
    });
    expect(output).toContain(VERSION);
  }, 20_000);
});
