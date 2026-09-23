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
import { afterEach, describe, expect, it } from "vitest";
import { sha256File } from "../src/digest.js";
import {
  activateArcVoiceboxVersion,
  inspectArcVoiceboxInstall,
  promoteArcVoiceboxKnownGood,
  rollbackArcVoiceboxVersion,
  setArcVoiceboxHealthState,
} from "../src/activation.js";
import {
  createEmptyVoiceRuntimeManifest,
  mutateVoiceRuntimeManifest,
  readVoiceRuntimeManifest,
  type VoiceRuntimeManifest,
} from "../src/manifest.js";
import {
  createArcVoicePaths,
  type ArcVoicePaths,
} from "../src/paths.js";
import {
  ARC_VOICEBOX_RELEASE,
  type ArcVoiceboxRelease,
} from "../src/release.js";

const roots: string[] = [];

async function createInstallFixture(): Promise<{
  root: string;
  paths: ArcVoicePaths;
  release: ArcVoiceboxRelease;
  stagedExecutablePath: string;
  digest: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "arc-voice-activation-"));
  roots.push(root);
  const paths = createArcVoicePaths({ userDataPath: root });
  const componentPath = join(root, "source-voicebox-server");
  await writeFile(componentPath, "voicebox-server-fixture", "utf8");
  const digest = await sha256File(componentPath);
  const stagedExecutablePath = join(
    paths.stagingVersionRoot(ARC_VOICEBOX_RELEASE.version),
    "voicebox-server",
  );
  await mkdir(paths.stagingVersionRoot(ARC_VOICEBOX_RELEASE.version), {
    recursive: true,
  });
  await writeFile(stagedExecutablePath, await readFile(componentPath));
  await chmod(stagedExecutablePath, 0o755);
  return {
    root,
    paths,
    digest,
    stagedExecutablePath,
    release: { ...ARC_VOICEBOX_RELEASE, componentSha256: digest },
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const baseArgs = {
  createdByArcVersion: "0.9.0",
  platform: "darwin-arm64",
  arch: "arm64",
};

async function readManifest(
  paths: ArcVoicePaths,
): Promise<VoiceRuntimeManifest> {
  const read = await readVoiceRuntimeManifest({
    manifestPath: paths.manifestPath,
    ...baseArgs,
  });
  if (read.kind !== "ok") {
    throw new Error(`expected a manifest, got ${read.kind}`);
  }
  return read.manifest;
}

describe("inspectArcVoiceboxInstall", () => {
  it("reports an absent runtime before anything is installed", async () => {
    const { paths, release } = await createInstallFixture();

    expect(
      await inspectArcVoiceboxInstall({ ...baseArgs, paths, release }),
    ).toEqual({
      kind: "absent",
      reason: "no voice runtime manifest is installed",
    });
  });

  it("reports an installed runtime with its verified digest", async () => {
    const { paths, release, stagedExecutablePath, digest } =
      await createInstallFixture();
    await activateArcVoiceboxVersion({
      ...baseArgs,
      paths,
      release,
      version: release.version,
      digest,
      stagedExecutablePath,
      source: "arc-bundled",
    });

    expect(
      await inspectArcVoiceboxInstall({ ...baseArgs, paths, release }),
    ).toEqual({
      kind: "installed",
      version: release.version,
      digest,
      executablePath: paths.executablePath,
    });
  });

  it("reports drift when the installed executable is gone", async () => {
    const { paths, release, stagedExecutablePath, digest } =
      await createInstallFixture();
    await activateArcVoiceboxVersion({
      ...baseArgs,
      paths,
      release,
      version: release.version,
      digest,
      stagedExecutablePath,
      source: "arc-bundled",
    });
    await rm(paths.executablePath);

    const state = await inspectArcVoiceboxInstall({
      ...baseArgs,
      paths,
      release,
    });
    expect(state.kind).toBe("drift");
    expect(state.kind === "drift" ? state.reason : "").toContain(
      "missing or not runnable",
    );
  });

  it("reports drift when the recorded version is not this build's pin", async () => {
    const { paths, release, stagedExecutablePath, digest } =
      await createInstallFixture();
    await activateArcVoiceboxVersion({
      ...baseArgs,
      paths,
      release,
      version: release.version,
      digest,
      stagedExecutablePath,
      source: "arc-bundled",
    });
    await mutateVoiceRuntimeManifest({
      manifestPath: paths.manifestPath,
      ...baseArgs,
      mutate: (manifest) => ({ ...manifest, activeVersion: "0.4.0" }),
    });

    const state = await inspectArcVoiceboxInstall({
      ...baseArgs,
      paths,
      release,
    });
    expect(state.kind).toBe("drift");
    expect(state.kind === "drift" ? state.reason : "").toContain("0.4.0");
  });
});

describe("activateArcVoiceboxVersion", () => {
  it("activates a staged component and records it in the manifest", async () => {
    const { paths, release, stagedExecutablePath, digest } =
      await createInstallFixture();

    const activated = await activateArcVoiceboxVersion({
      ...baseArgs,
      paths,
      release,
      version: release.version,
      digest,
      stagedExecutablePath,
      source: "arc-bundled",
      now: () => 1_700_000_000_000,
    });

    expect(activated).toEqual({
      kind: "activated",
      version: release.version,
      digest,
    });
    expect(await readFile(paths.executablePath, "utf8")).toBe(
      "voicebox-server-fixture",
    );
    expect(await readManifest(paths)).toEqual({
      ...createEmptyVoiceRuntimeManifest(baseArgs),
      activeVersion: release.version,
      source: "arc-bundled",
      installPath: paths.executablePath,
      digest,
      digestsByVersion: { [release.version]: digest },
      installedAt: 1_700_000_000_000,
    });
  });

  it("reports an already-active version without touching the install", async () => {
    const { paths, release, stagedExecutablePath, digest } =
      await createInstallFixture();
    await activateArcVoiceboxVersion({
      ...baseArgs,
      paths,
      release,
      version: release.version,
      digest,
      stagedExecutablePath,
      source: "arc-bundled",
      now: () => 1,
    });

    const again = await activateArcVoiceboxVersion({
      ...baseArgs,
      paths,
      release,
      version: release.version,
      digest,
      stagedExecutablePath,
      source: "arc-bundled",
      now: () => 2,
    });

    expect(again).toEqual({ kind: "already-active", version: release.version });
    expect((await readManifest(paths)).installedAt).toBe(1);
  });

  it("keeps the replaced install as the previous version", async () => {
    const { paths, release, stagedExecutablePath, digest } =
      await createInstallFixture();
    await activateArcVoiceboxVersion({
      ...baseArgs,
      paths,
      release,
      version: release.version,
      digest,
      stagedExecutablePath,
      source: "arc-bundled",
    });
    await mutateVoiceRuntimeManifest({
      manifestPath: paths.manifestPath,
      ...baseArgs,
      mutate: (manifest) => ({ ...manifest, activeVersion: "0.4.0" }),
    });
    await mkdir(paths.stagingVersionRoot(release.version), { recursive: true });
    await writeFile(stagedExecutablePath, "voicebox-server-fixture", "utf8");
    await chmod(stagedExecutablePath, 0o755);

    const activated = await activateArcVoiceboxVersion({
      ...baseArgs,
      paths,
      release,
      version: release.version,
      digest,
      stagedExecutablePath,
      source: "arc-managed-download",
    });

    expect(activated.kind).toBe("activated");
    expect(await readManifest(paths)).toMatchObject({
      activeVersion: release.version,
      previousVersion: "0.4.0",
      digestsByVersion: { [release.version]: digest },
    });
    expect(
      await readFile(join(paths.previousRoot, "voicebox-server"), "utf8"),
    ).toBe("voicebox-server-fixture");
  });

  it("refuses to activate a version this build does not pin", async () => {
    const { paths, release, stagedExecutablePath, digest } =
      await createInstallFixture();

    const activated = await activateArcVoiceboxVersion({
      ...baseArgs,
      paths,
      release,
      version: "0.4.0",
      digest,
      stagedExecutablePath,
      source: "arc-bundled",
    });

    expect(activated).toEqual({
      kind: "failed",
      reason: "refusing to activate version 0.4.0: this Arc build pins 0.5.0",
    });
    expect(await stat(paths.executablePath).catch(() => null)).toBeNull();
  });

  it("refuses a staged component whose digest is not the verified one", async () => {
    const { paths, release, stagedExecutablePath } =
      await createInstallFixture();

    const activated = await activateArcVoiceboxVersion({
      ...baseArgs,
      paths,
      release,
      version: release.version,
      digest:
        "1111111111111111111111111111111111111111111111111111111111111111",
      stagedExecutablePath,
      source: "arc-bundled",
    });

    expect(activated.kind).toBe("failed");
    expect(activated.kind === "failed" ? activated.reason : "").toContain(
      "staged voice runtime digest is",
    );
    expect(await stat(paths.executablePath).catch(() => null)).toBeNull();
  });
});

describe("promoteArcVoiceboxKnownGood", () => {
  it("promotes the active version only when asked", async () => {
    const { paths, release, stagedExecutablePath, digest } =
      await createInstallFixture();
    await activateArcVoiceboxVersion({
      ...baseArgs,
      paths,
      release,
      version: release.version,
      digest,
      stagedExecutablePath,
      source: "arc-bundled",
    });

    const promoted = await promoteArcVoiceboxKnownGood({ ...baseArgs, paths });
    expect(promoted).toEqual({ kind: "promoted", version: release.version });
    expect(await promoteArcVoiceboxKnownGood({ ...baseArgs, paths })).toEqual({
      kind: "already-known-good",
      version: release.version,
    });
  });

  it("refuses to promote when nothing is active", async () => {
    const { paths } = await createInstallFixture();

    expect(await promoteArcVoiceboxKnownGood({ ...baseArgs, paths })).toEqual({
      kind: "failed",
      reason: "no active voice runtime version to promote",
    });
  });
});

describe("rollbackArcVoiceboxVersion", () => {
  async function seedFailedUpdate(): Promise<{
    paths: ArcVoicePaths;
    release: ArcVoiceboxRelease;
    previousDigest: string;
  }> {
    const fixture = await createInstallFixture();
    const previousComponent = join(fixture.root, "previous-voicebox-server");
    await writeFile(previousComponent, "voicebox-server-0.4.0", "utf8");
    const previousDigest = await sha256File(previousComponent);
    await mkdir(fixture.paths.activeRoot, { recursive: true });
    await writeFile(
      join(fixture.paths.activeRoot, "voicebox-server"),
      "voicebox-server-fixture",
      "utf8",
    );
    await chmod(join(fixture.paths.activeRoot, "voicebox-server"), 0o755);
    await mkdir(fixture.paths.previousRoot, { recursive: true });
    const previousExecutable = join(
      fixture.paths.previousRoot,
      "voicebox-server",
    );
    await writeFile(previousExecutable, await readFile(previousComponent));
    await chmod(previousExecutable, 0o755);
    await mutateVoiceRuntimeManifest({
      manifestPath: fixture.paths.manifestPath,
      ...baseArgs,
      mutate: (manifest) => ({
        ...manifest,
        activeVersion: fixture.release.version,
        previousVersion: "0.4.0",
        knownGoodVersion: "0.4.0",
        installPath: fixture.paths.executablePath,
        digest: fixture.digest,
        digestsByVersion: {
          "0.4.0": previousDigest,
          [fixture.release.version]: fixture.digest,
        },
      }),
    });
    return { ...fixture, previousDigest };
  }

  it("reactivates the known-good version and preserves it for the manifest", async () => {
    const { paths, release, previousDigest } = await seedFailedUpdate();

    const rolledBack = await rollbackArcVoiceboxVersion({
      ...baseArgs,
      paths,
      release,
      now: () => 42,
    });

    expect(rolledBack).toEqual({
      kind: "rolled-back",
      from: release.version,
      to: "0.4.0",
    });
    expect(await readFile(paths.executablePath, "utf8")).toBe(
      "voicebox-server-0.4.0",
    );
    expect(
      await readFile(
        `${paths.rolledBackStagingPath(release.version)}/voicebox-server`,
        "utf8",
      ),
    ).toBe("voicebox-server-fixture");
    expect(await readManifest(paths)).toMatchObject({
      activeVersion: "0.4.0",
      previousVersion: null,
      knownGoodVersion: "0.4.0",
      digest: previousDigest,
      installedAt: 42,
      healthState: "unknown",
    });
  });

  it("reports unavailable when the active version is the known-good one", async () => {
    const { paths, release, stagedExecutablePath, digest } =
      await createInstallFixture();
    await activateArcVoiceboxVersion({
      ...baseArgs,
      paths,
      release,
      version: release.version,
      digest,
      stagedExecutablePath,
      source: "arc-bundled",
    });
    await promoteArcVoiceboxKnownGood({ ...baseArgs, paths });

    expect(
      await rollbackArcVoiceboxVersion({ ...baseArgs, paths, release }),
    ).toEqual({
      kind: "unavailable",
      reason: `active voice runtime ${release.version} is already the known-good version`,
    });
  });

  it("reports unavailable when the known-good files were removed", async () => {
    const { paths, release } = await seedFailedUpdate();
    await rm(paths.previousRoot, { recursive: true, force: true });

    const rolledBack = await rollbackArcVoiceboxVersion({
      ...baseArgs,
      paths,
      release,
    });
    expect(rolledBack).toEqual({
      kind: "unavailable",
      reason: `known-good voice runtime 0.4.0 is no longer on disk at ${join(paths.previousRoot, "voicebox-server")}`,
    });
  });

  it("fails when the known-good files no longer match the recorded digest", async () => {
    const { paths, release } = await seedFailedUpdate();
    await writeFile(
      join(paths.previousRoot, "voicebox-server"),
      "tampered",
      "utf8",
    );

    const rolledBack = await rollbackArcVoiceboxVersion({
      ...baseArgs,
      paths,
      release,
    });
    expect(rolledBack.kind).toBe("failed");
    expect(rolledBack.kind === "failed" ? rolledBack.reason : "").toContain(
      "known-good voice runtime digest is",
    );
  });

  it("reports unavailable when no known-good version is recorded", async () => {
    const { paths, release, stagedExecutablePath, digest } =
      await createInstallFixture();
    await activateArcVoiceboxVersion({
      ...baseArgs,
      paths,
      release,
      version: release.version,
      digest,
      stagedExecutablePath,
      source: "arc-bundled",
    });

    expect(
      await rollbackArcVoiceboxVersion({ ...baseArgs, paths, release }),
    ).toEqual({
      kind: "unavailable",
      reason: "no known-good voice runtime version is recorded",
    });
  });
});

describe("setArcVoiceboxHealthState", () => {
  it("records the observed health state", async () => {
    const { paths, release, stagedExecutablePath, digest } =
      await createInstallFixture();
    await activateArcVoiceboxVersion({
      ...baseArgs,
      paths,
      release,
      version: release.version,
      digest,
      stagedExecutablePath,
      source: "arc-bundled",
    });

    await setArcVoiceboxHealthState({
      ...baseArgs,
      paths,
      healthState: "healthy",
    });

    expect((await readManifest(paths)).healthState).toBe("healthy");
  });
});
