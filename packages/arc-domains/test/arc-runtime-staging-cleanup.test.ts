import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanAbandonedArcRuntimeStaging } from "../src/arc-runtime/staging-cleanup.js";
import { createArcRuntimePaths, type ArcRuntimePaths } from "../src/arc-runtime/paths.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makePaths(): Promise<ArcRuntimePaths> {
  const dir = await mkdtemp(join(tmpdir(), "arc-staging-cleanup-test-"));
  tempDirs.push(dir);
  return createArcRuntimePaths({ userDataPath: dir });
}

describe("cleanAbandonedArcRuntimeStaging", () => {
  it("removes every entry left in the staging root", async () => {
    const paths = await makePaths();
    await mkdir(join(paths.stagingRoot, "codex-update-0.156.0-123"), {
      recursive: true,
    });
    await writeFile(
      join(paths.stagingRoot, "codex-update-0.156.0-123", "asset"),
      "partial",
      "utf8",
    );
    await mkdir(join(paths.stagingRoot, "omp-update-18.3.0-456"), {
      recursive: true,
    });

    const result = await cleanAbandonedArcRuntimeStaging(paths);

    expect(result.removed.sort()).toEqual(
      ["codex-update-0.156.0-123", "omp-update-18.3.0-456"].sort(),
    );
    expect(await readdir(paths.stagingRoot)).toEqual([]);
  });

  it("never touches the runtimes directory (only staging is scratch space)", async () => {
    const paths = await makePaths();
    await mkdir(paths.versionRoot("codex", "0.155.1"), { recursive: true });
    await writeFile(
      paths.executablePath("codex", "0.155.1"),
      "#!/bin/sh\nexit 0\n",
      "utf8",
    );
    await mkdir(join(paths.stagingRoot, "leftover"), { recursive: true });

    await cleanAbandonedArcRuntimeStaging(paths);

    expect(await readdir(paths.runtimeRoot("codex"))).toContain("0.155.1");
  });

  it("does nothing (and does not throw) when the staging root does not exist yet", async () => {
    const paths = await makePaths();

    const result = await cleanAbandonedArcRuntimeStaging(paths);

    expect(result).toEqual({ removed: [], failed: [] });
  });
});
