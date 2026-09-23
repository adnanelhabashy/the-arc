import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256File } from "../src/digest.js";
import type { ArcVoiceboxProbe } from "../src/acquire.js";
import {
  ARC_VOICEBOX_RELEASE,
  type ArcVoiceboxRelease,
} from "../src/release.js";
import {
  arcVoiceboxSeedFileDigests,
  arcVoiceboxSeedVersionDir,
  planArcVoiceboxSeedBuild,
  stageArcVoiceboxSeed,
} from "../src/seed.js";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "arc-voice-seed-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const COMPONENT_BYTES = "voicebox-server-fixture";

const probe: ArcVoiceboxProbe = () =>
  Promise.resolve({
    kind: "ok",
    stdout: ARC_VOICEBOX_RELEASE.expectedVersionOutput,
  });

async function createFixtureBundle(root: string): Promise<{
  bundlePath: string;
  release: ArcVoiceboxRelease;
}> {
  const bundlePath = join(root, "Voicebox.app");
  const macosDir = join(bundlePath, "Contents", "MacOS");
  await mkdir(macosDir, { recursive: true });
  const componentPath = join(macosDir, "voicebox-server");
  await writeFile(componentPath, COMPONENT_BYTES, "utf8");
  await writeFile(join(macosDir, "voicebox"), "gui-fixture", "utf8");
  await writeFile(join(macosDir, "voicebox-mcp"), "mcp-fixture", "utf8");
  return {
    bundlePath,
    release: {
      ...ARC_VOICEBOX_RELEASE,
      componentSha256: await sha256File(componentPath),
    },
  };
}

describe("arcVoiceboxSeedVersionDir", () => {
  it("places the seed under the runtime id and version", () => {
    expect(
      arcVoiceboxSeedVersionDir({
        release: ARC_VOICEBOX_RELEASE,
        stagedResourcesRoot: "/staged/resources",
      }),
    ).toBe(join("/staged/resources", "voicebox", "0.5.0"));
  });
});

describe("planArcVoiceboxSeedBuild", () => {
  const digest = ARC_VOICEBOX_RELEASE.componentSha256;

  it("requires exactly the component Arc verified", () => {
    expect(arcVoiceboxSeedFileDigests(ARC_VOICEBOX_RELEASE)).toEqual([
      { fileName: "voicebox-server", sha256: digest },
    ]);
  });

  it("is complete when the component matches the pin", () => {
    expect(
      planArcVoiceboxSeedBuild({
        release: ARC_VOICEBOX_RELEASE,
        seedDigests: { "voicebox-server": digest },
      }),
    ).toEqual({ kind: "complete" });
  });

  it("rebuilds a seed whose component is absent", () => {
    expect(
      planArcVoiceboxSeedBuild({
        release: ARC_VOICEBOX_RELEASE,
        seedDigests: { "voicebox-server": null },
      }),
    ).toEqual({ kind: "rebuild", missing: ["voicebox-server"] });
  });

  it("rebuilds a seed whose component is a different build", () => {
    expect(
      planArcVoiceboxSeedBuild({
        release: ARC_VOICEBOX_RELEASE,
        seedDigests: {
          "voicebox-server":
            "1111111111111111111111111111111111111111111111111111111111111111",
        },
      }),
    ).toEqual({ kind: "rebuild", missing: ["voicebox-server"] });
  });
});

describe("stageArcVoiceboxSeed", () => {
  it("packages only the verified component out of the upstream bundle", async () => {
    const root = await createRoot();
    const { bundlePath, release } = await createFixtureBundle(root);
    const stagedResourcesRoot = join(root, "resources");

    const result = await stageArcVoiceboxSeed({
      release,
      artifactPath: bundlePath,
      stagedResourcesRoot,
      probe,
    });

    const seedDir = arcVoiceboxSeedVersionDir({ release, stagedResourcesRoot });
    expect(result).toEqual({
      kind: "staged",
      seedPath: join(seedDir, "voicebox-server"),
      digest: release.componentSha256,
      version: release.version,
    });
    expect(await readFile(join(seedDir, "voicebox-server"), "utf8")).toBe(
      COMPONENT_BYTES,
    );
    expect(
      (await stat(join(seedDir, "voicebox-server"))).mode & 0o111,
    ).not.toBe(0);
    expect(await stat(join(seedDir, "voicebox")).catch(() => null)).toBeNull();
    expect(
      await stat(join(seedDir, "voicebox-mcp")).catch(() => null),
    ).toBeNull();
    expect(await readdir(stagedResourcesRoot)).toEqual(["voicebox"]);
  });

  it("accepts a component the release engineer already extracted", async () => {
    const root = await createRoot();
    const { release } = await createFixtureBundle(root);
    const componentPath = join(root, "voicebox-server");
    await writeFile(componentPath, COMPONENT_BYTES, "utf8");
    await chmod(componentPath, 0o755);

    const result = await stageArcVoiceboxSeed({
      release: { ...release, componentSha256: await sha256File(componentPath) },
      artifactPath: componentPath,
      stagedResourcesRoot: join(root, "resources"),
      probe,
    });

    expect(result.kind).toBe("staged");
  });

  it("skips a seed that is already staged and verified", async () => {
    const root = await createRoot();
    const { bundlePath, release } = await createFixtureBundle(root);
    const stagedResourcesRoot = join(root, "resources");
    await stageArcVoiceboxSeed({
      release,
      artifactPath: bundlePath,
      stagedResourcesRoot,
      probe,
    });
    const seedPath = join(
      arcVoiceboxSeedVersionDir({ release, stagedResourcesRoot }),
      "voicebox-server",
    );
    const stamped = await stat(seedPath);

    expect(
      await stageArcVoiceboxSeed({
        release,
        artifactPath: join(root, "does-not-exist"),
        stagedResourcesRoot,
        probe,
      }),
    ).toEqual({ kind: "complete" });
    expect((await stat(seedPath)).mtimeMs).toBe(stamped.mtimeMs);
  });

  it("rejects an artifact whose component digest is not the pinned one", async () => {
    const root = await createRoot();
    const { bundlePath, release } = await createFixtureBundle(root);

    await expect(
      stageArcVoiceboxSeed({
        release: {
          ...release,
          componentSha256:
            "0000000000000000000000000000000000000000000000000000000000000000",
        },
        artifactPath: bundlePath,
        stagedResourcesRoot: join(root, "resources"),
        probe,
      }),
    ).rejects.toThrow("digest mismatch");
  });

  it("rejects an artifact that does not exist", async () => {
    const root = await createRoot();
    const { release } = await createFixtureBundle(root);

    await expect(
      stageArcVoiceboxSeed({
        release,
        artifactPath: join(root, "absent"),
        stagedResourcesRoot: join(root, "resources"),
        probe,
      }),
    ).rejects.toThrow("does not exist");
  });

  it("skips a release pinned for another platform", async () => {
    const root = await createRoot();
    const { release } = await createFixtureBundle(root);

    expect(
      await stageArcVoiceboxSeed({
        release: { ...release, platform: "linux-x64" },
        artifactPath: join(root, "absent"),
        stagedResourcesRoot: join(root, "resources"),
        probe,
        platform: "darwin",
        arch: "arm64",
      }),
    ).toEqual({
      kind: "skipped",
      reason: "pinned for linux-x64, building on darwin-arm64",
    });
  });

  it("refuses release metadata that fails validation", async () => {
    const root = await createRoot();
    const { release, bundlePath } = await createFixtureBundle(root);

    await expect(
      stageArcVoiceboxSeed({
        release: { ...release, version: "not-a-version" },
        artifactPath: bundlePath,
        stagedResourcesRoot: join(root, "resources"),
        probe,
      }),
    ).rejects.toThrow("invalid voice release metadata");
  });
});
