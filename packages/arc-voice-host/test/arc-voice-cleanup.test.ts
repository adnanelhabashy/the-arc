import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanAbandonedArcVoiceStaging,
  removeArcVoiceboxInstall,
} from "../src/cleanup.js";
import {
  createArcVoicePaths,
  type ArcVoicePaths,
} from "../src/paths.js";

const roots: string[] = [];

async function createPaths(): Promise<{ root: string; paths: ArcVoicePaths }> {
  const root = await mkdtemp(join(tmpdir(), "arc-voice-cleanup-"));
  roots.push(root);
  return { root, paths: createArcVoicePaths({ userDataPath: root }) };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("cleanAbandonedArcVoiceStaging", () => {
  it("sweeps every abandoned staging directory", async () => {
    const { paths } = await createPaths();
    await mkdir(paths.stagingVersionRoot("0.5.0"), { recursive: true });
    await writeFile(
      join(paths.stagingVersionRoot("0.5.0"), "voicebox-server"),
      "partial",
      "utf8",
    );
    await mkdir(paths.rolledBackStagingPath("0.5.0"), { recursive: true });

    const swept = await cleanAbandonedArcVoiceStaging(paths);

    expect(swept).toEqual({
      removed: ["0.5.0", "rolled-back-0.5.0"],
      failed: [],
    });
    expect(
      await stat(paths.stagingVersionRoot("0.5.0")).catch(() => null),
    ).toBeNull();
    expect(
      await stat(paths.rolledBackStagingPath("0.5.0")).catch(() => null),
    ).toBeNull();
  });

  it("reports nothing to sweep when staging never existed", async () => {
    const { paths } = await createPaths();

    expect(await cleanAbandonedArcVoiceStaging(paths)).toEqual({
      removed: [],
      failed: [],
    });
  });
});

describe("removeArcVoiceboxInstall", () => {
  it("removes the runtime, its manifest, and its staging tree", async () => {
    const { paths } = await createPaths();
    await mkdir(paths.activeRoot, { recursive: true });
    await writeFile(
      join(paths.activeRoot, "voicebox-server"),
      "runtime",
      "utf8",
    );
    await writeFile(paths.manifestPath, "{}", "utf8");
    await mkdir(paths.dataDir, { recursive: true });
    await mkdir(paths.modelsRoot, { recursive: true });

    const removed = await removeArcVoiceboxInstall({ paths });

    expect(removed.failed).toEqual([]);
    expect(removed.removed).toEqual([
      paths.activeRoot,
      paths.previousRoot,
      paths.stagingRoot,
      paths.manifestPath,
    ]);
    expect(await stat(paths.dataDir).catch(() => null)).not.toBeNull();
  });

  it("removes downloaded models and runtime data when asked", async () => {
    const { paths } = await createPaths();
    await mkdir(paths.dataDir, { recursive: true });
    await mkdir(paths.modelsRoot, { recursive: true });
    await writeFile(
      join(paths.modelsRoot, "kokoro-v1_0.pth"),
      "weights",
      "utf8",
    );

    await removeArcVoiceboxInstall({ paths, removeVoiceData: true });

    expect(await stat(paths.modelsRoot).catch(() => null)).toBeNull();
    expect(await stat(paths.dataDir).catch(() => null)).toBeNull();
  });
});
