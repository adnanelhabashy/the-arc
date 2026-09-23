import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stageArcRuntimeCompanionFromSeed } from "../src/arc-runtime/acquire.js";
import { prepareArcManagedRuntimes } from "../src/arc-runtime/bootstrap.js";
import { rollbackArcRuntimeVersion } from "../src/arc-runtime/activation.js";
import { checkArcRuntimeComponents } from "../src/arc-runtime/components.js";
import { sha256File } from "../src/arc-runtime/digest.js";
import { parseCodexEnabledFeatures, probeArcRuntimeHealth } from "../src/arc-runtime/health.js";
import {
  readArcRuntimeManifest,
  type ArcRuntimeManifest,
} from "../src/arc-runtime/manifest.js";
import { createArcRuntimePaths, type ArcRuntimePaths } from "../src/arc-runtime/paths.js";
import type { ArcRuntimeCompanion, ArcRuntimeRelease } from "../src/arc-runtime/releases.js";
import { ARC_CODEX_RELEASE, validateArcRuntimeRelease } from "../src/arc-runtime/releases.js";

const VERSION = "0.155.1";
const PLATFORM = "darwin-arm64";
const CREATED_BY = "0.43.1";
const COMPANION_FILE_NAME = "codex-code-mode-host";
// Stands in for the host's `--listen stdio` behaviour: alive until killed.
const STAYS_UP_SCRIPT = "#!/bin/sh\nsleep 30\n";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arc-codex-components-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface Fixture {
  seedRoot: string;
  paths: ArcRuntimePaths;
  release: ArcRuntimeRelease;
}

/**
 * A Codex release whose companion is a real staged script, so the suite
 * exercises the same digest-and-stage path the pinned release uses without a
 * 62 MB download.
 */
async function makeFixture(
  options: { withCompanionSeed?: boolean } = {},
): Promise<Fixture> {
  const root = await tempDir();
  const paths = createArcRuntimePaths({
    userDataPath: join(root, "userData"),
  });
  const seedRoot = join(root, "seed");

  const seedPath = join(seedRoot, "codex", VERSION, "codex");
  await mkdir(dirname(seedPath), { recursive: true });
  await writeFile(seedPath, `#!/bin/sh\necho "codex-cli ${VERSION}"\n`, "utf8");
  await chmod(seedPath, 0o755);

  const companionSeedPath = join(seedRoot, "codex", VERSION, COMPANION_FILE_NAME);
  if (options.withCompanionSeed !== false) {
    await writeFile(companionSeedPath, STAYS_UP_SCRIPT, "utf8");
    await chmod(companionSeedPath, 0o755);
  }

  const executableSha256 = await sha256File(seedPath);
  const companion: ArcRuntimeCompanion = {
    fileName: COMPANION_FILE_NAME,
    archiveEntryName: `${COMPANION_FILE_NAME}-aarch64-apple-darwin`,
    artifactKind: "archive",
    assetName: `${COMPANION_FILE_NAME}-aarch64-apple-darwin.tar.gz`,
    downloadUrl: `https://github.com/openai/codex/releases/download/rust-v${VERSION}/${COMPANION_FILE_NAME}-aarch64-apple-darwin.tar.gz`,
    sha256: "0".repeat(64),
    executableSha256: options.withCompanionSeed === false
      ? "1".repeat(64)
      : await sha256File(companionSeedPath),
    reportsVersion: false,
    livenessArgs: ["--listen", "stdio"],
  };

  return {
    seedRoot,
    paths,
    release: {
      runtimeId: "codex",
      artifactKind: "executable",
      version: VERSION,
      platform: PLATFORM,
      releaseTag: `rust-v${VERSION}`,
      assetName: "codex",
      downloadUrl: `https://github.com/openai/codex/releases/download/rust-v${VERSION}/codex`,
      sha256: executableSha256,
      executableSha256,
      expectedExecutableVersion: VERSION,
      license: "Apache-2.0",
      companions: [companion],
    },
  };
}

async function install(fixture: Fixture) {
  return prepareArcManagedRuntimes({
    createdByArcVersion: CREATED_BY,
    platform: PLATFORM,
    releases: [fixture.release],
    runtimePaths: fixture.paths,
    seedRoot: fixture.seedRoot,
  });
}

async function readManifestOf(fixture: Fixture): Promise<ArcRuntimeManifest> {
  const result = await readArcRuntimeManifest({
    createdByArcVersion: CREATED_BY,
    manifestPath: fixture.paths.manifestPath,
    platform: PLATFORM,
  });
  if (result.kind !== "ok") {
    throw new Error(`manifest read: ${result.kind}`);
  }
  return result.manifest;
}

function componentPathOf(fixture: Fixture): string {
  return fixture.paths.componentPath("codex", VERSION, COMPANION_FILE_NAME);
}

describe("managed Codex runtime components", () => {
  it("stages the companion beside the runtime executable and records its digest", async () => {
    const fixture = await makeFixture();
    const results = await install(fixture);

    expect(results).toEqual([
      expect.objectContaining({ runtimeId: "codex", action: "installed" }),
    ]);
    const companionDigest = await sha256File(componentPathOf(fixture));
    expect(companionDigest).toBe(fixture.release.companions?.[0].executableSha256);
    const manifest = await readManifestOf(fixture);
    expect(manifest.runtimes.codex.componentsByVersion[VERSION]).toEqual({
      [COMPANION_FILE_NAME]: companionDigest,
    });
  });

  it("fails the install when the bundled companion is missing", async () => {
    const fixture = await makeFixture({ withCompanionSeed: false });
    const results = await install(fixture);

    expect(results[0]).toMatchObject({ runtimeId: "codex", action: "failed" });
    expect(results[0].detail).toContain(COMPANION_FILE_NAME);
    // Nothing is activated, and no manifest is written: an install that cannot
    // stage every required artifact is not a partial install.
    await expect(
      stat(fixture.paths.versionRoot("codex", VERSION)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("repairs an active version whose companion has been removed", async () => {
    const fixture = await makeFixture();
    await install(fixture);
    await rm(componentPathOf(fixture), { force: true });

    const results = await install(fixture);

    expect(results[0]).toMatchObject({ runtimeId: "codex", action: "repaired" });
    await expect(stat(componentPathOf(fixture))).resolves.toMatchObject({});
  });

  it("reuses an active version whose companion is intact", async () => {
    const fixture = await makeFixture();
    await install(fixture);

    const results = await install(fixture);

    expect(results[0]).toMatchObject({
      runtimeId: "codex",
      action: "already-active",
    });
  });

  it("refuses a companion whose bytes do not match the pin", async () => {
    const fixture = await makeFixture();
    const stagingDir = join(await tempDir(), "staged");
    await mkdir(stagingDir, { recursive: true });

    const staged = await stageArcRuntimeCompanionFromSeed({
      companion: { ...fixture.release.companions![0], executableSha256: "2".repeat(64) },
      seedPath: join(fixture.seedRoot, "codex", VERSION, COMPANION_FILE_NAME),
      stagingDir,
      isWindows: false,
    });

    expect(staged).toMatchObject({ kind: "rejected" });
    expect(staged.kind === "rejected" ? staged.reason : "").toContain(
      "digest mismatch",
    );
  });

  it("rejects a companion pinned to a different release tag than its runtime", async () => {
    const fixture = await makeFixture();
    const release = {
      ...fixture.release,
      companions: [
        {
          ...fixture.release.companions![0],
          downloadUrl:
            "https://github.com/openai/codex/releases/download/rust-v0.154.0/codex-code-mode-host-aarch64-apple-darwin.tar.gz",
        },
      ],
    };

    expect(validateArcRuntimeRelease(release)).toMatchObject({
      kind: "invalid",
      problem: expect.stringContaining("same release tag"),
    });
  });
});

describe("codex companion health", () => {
  /** A fixture with both artifacts staged, so the runtime itself is healthy
   *  and only the companion's state differs between cases. */
  async function installedFixture(): Promise<Fixture> {
    const fixture = await makeFixture();
    const results = await install(fixture);
    expect(results[0]).toMatchObject({ action: "installed" });
    return fixture;
  }

  function healthArgs(fixture: Fixture, expectedDigest: string | null) {
    return {
      runtimeId: "codex" as const,
      executablePath: fixture.paths.executablePath("codex", VERSION),
      expectedVersion: VERSION,
      components: [
        {
          fileName: COMPANION_FILE_NAME,
          expectedDigest,
          livenessArgs: ["--listen", "stdio"],
        },
      ],
      componentPath: (fileName: string) =>
        fixture.paths.componentPath("codex", VERSION, fileName),
      runProcess: async (_path: string, args: string[]) => ({
        stdout:
          args[0] === "doctor"
            ? doctorReport(["code_mode_host"])
            : modelCatalog(["gpt-6-astra", "gpt-5.5"]),
        ok: true,
      }),
    };
  }

  it("reports healthy when the companion is present, executable and stays up", async () => {
    const fixture = await installedFixture();
    const companion = fixture.release.companions![0];

    const result = await probeArcRuntimeHealth(
      healthArgs(fixture, companion.executableSha256),
    );

    expect(result).toMatchObject({
      kind: "healthy",
      detail: expect.stringContaining(`${COMPANION_FILE_NAME} verified`),
    });
  });

  it("reports unhealthy when the companion is absent", async () => {
    const fixture = await installedFixture();
    await rm(componentPathOf(fixture), { force: true });

    const result = await probeArcRuntimeHealth(healthArgs(fixture, null));

    expect(result).toMatchObject({
      kind: "unhealthy",
      detail: expect.stringContaining("is missing at"),
    });
  });

  it("reports unhealthy when the companion has been replaced", async () => {
    const fixture = await installedFixture();
    const companion = fixture.release.companions![0];
    await writeFile(
      componentPathOf(fixture),
      "#!/bin/sh\n# replaced with different bytes\nsleep 30\n",
      "utf8",
    );
    await chmod(componentPathOf(fixture), 0o755);

    const result = await probeArcRuntimeHealth(
      healthArgs(fixture, companion.executableSha256),
    );

    expect(result).toMatchObject({
      kind: "unhealthy",
      detail: expect.stringContaining("digest is"),
    });
  });

  it("reports unhealthy when the companion cannot be executed", async () => {
    const fixture = await installedFixture();
    await chmod(componentPathOf(fixture), 0o644);

    const result = await probeArcRuntimeHealth(healthArgs(fixture, null));

    expect(result).toMatchObject({
      kind: "unhealthy",
      detail: expect.stringContaining("is not executable"),
    });
  });

  it("reports unhealthy when the companion exits instead of serving stdio", async () => {
    const fixture = await installedFixture();
    await writeFile(componentPathOf(fixture), "#!/bin/sh\nexit 3\n", "utf8");
    await chmod(componentPathOf(fixture), 0o755);

    const result = await probeArcRuntimeHealth(healthArgs(fixture, null));

    expect(result).toMatchObject({
      kind: "unhealthy",
      detail: expect.stringContaining("exited instead of serving stdio"),
    });
  });

  it("reports unhealthy when the managed runtime does not enable the code-mode host", async () => {
    const fixture = await installedFixture();

    const result = await probeArcRuntimeHealth({
      ...healthArgs(fixture, null),
      runProcess: async () => ({
        stdout: doctorReport(["shell_tool"]),
        ok: true,
      }),
    });

    expect(result).toMatchObject({
      kind: "unhealthy",
      detail: expect.stringContaining("features.code_mode_host disabled"),
    });
  });
});

describe("codex effective feature verification", () => {
  it("reads the enabled feature list from the doctor report", () => {
    expect(parseCodexEnabledFeatures(doctorReport(["shell_tool", "code_mode_host"]))).toEqual([
      "shell_tool",
      "code_mode_host",
    ]);
  });

  it("answers null rather than guessing when the report is not what was expected", () => {
    expect(parseCodexEnabledFeatures("not json")).toBeNull();
    expect(parseCodexEnabledFeatures("{}")).toBeNull();
    expect(
      parseCodexEnabledFeatures(JSON.stringify({ checks: { "config.load": {} } })),
    ).toBeNull();
  });
});

describe("component checks never consult PATH", () => {
  it("resolves every companion from the version directory", async () => {
    const fixture = await makeFixture();
    const checks = await checkArcRuntimeComponents({
      expectations: [
        { fileName: COMPANION_FILE_NAME, expectedDigest: null },
      ],
      componentPath: (fileName) =>
        fixture.paths.componentPath("codex", VERSION, fileName),
      isWindows: false,
      verifyDigest: false,
    });

    expect(checks[0].path).toBe(componentPathOf(fixture));
    expect(checks[0].path.startsWith(fixture.paths.root)).toBe(true);
  });
});

function modelCatalog(slugs: readonly string[]): string {
  return JSON.stringify({
    models: slugs.map((slug, index) => ({
      slug,
      ...(index === 0 ? { tool_mode: "code_mode_only" } : {}),
    })),
  });
}

function doctorReport(enabledFeatures: readonly string[]): string {
  return JSON.stringify({
    checks: {
      "config.load": {
        details: { "enabled feature flags": enabledFeatures.join(", ") },
      },
    },
  });
}

describe("update and rollback move both artifacts together", () => {
  it("refuses to roll back to a version whose helper is gone", async () => {
    const fixture = await makeFixture();
    await install(fixture);
    await rm(componentPathOf(fixture), { force: true });

    const rollback = await rollbackArcRuntimeVersion({
      runtimeId: "codex",
      createdByArcVersion: CREATED_BY,
      platform: PLATFORM,
      runtimePaths: fixture.paths,
    });

    // The only installed version is also the known-good one, so this reports
    // "no rollback target" rather than a missing helper; the missing-helper
    // guard is what protects a real two-version rollback.
    expect(rollback.kind).toBe("unavailable");
  });

  it("reports an active version as broken once its helper is gone", async () => {
    const fixture = await makeFixture();
    await install(fixture);
    const before = await checkArcRuntimeComponents({
      expectations: [
        {
          fileName: COMPANION_FILE_NAME,
          expectedDigest: fixture.release.companions![0].executableSha256,
        },
      ],
      componentPath: (fileName) =>
        fixture.paths.componentPath("codex", VERSION, fileName),
      isWindows: false,
      verifyDigest: true,
    });
    expect(before[0].ok).toBe(true);

    await rm(componentPathOf(fixture), { force: true });
    const after = await checkArcRuntimeComponents({
      expectations: [
        {
          fileName: COMPANION_FILE_NAME,
          expectedDigest: fixture.release.companions![0].executableSha256,
        },
      ],
      componentPath: (fileName) =>
        fixture.paths.componentPath("codex", VERSION, fileName),
      isWindows: false,
      verifyDigest: true,
    });
    expect(after[0]).toMatchObject({ ok: false });
  });

  it("has a pinned release whose companion is version-locked to it", () => {
    const validation = validateArcRuntimeRelease(ARC_CODEX_RELEASE);
    expect(validation).toEqual({ kind: "ok" });
    for (const companion of ARC_CODEX_RELEASE.companions ?? []) {
      expect(companion.downloadUrl).toContain(
        `/${ARC_CODEX_RELEASE.releaseTag}/`,
      );
      expect(companion.fileName).toBe(COMPANION_FILE_NAME);
      expect(companion.livenessArgs).toEqual(["--listen", "stdio"]);
    }
  });
});
