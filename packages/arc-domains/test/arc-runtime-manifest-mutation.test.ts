import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEmptyArcRuntimeManifest,
  mutateArcRuntimeManifest,
  readArcRuntimeManifest,
  writeArcRuntimeManifest,
  type ArcRuntimeManifest,
} from "../src/arc-runtime/manifest.js";

const PLATFORM = "darwin-arm64";
const CREATED_BY = "0.43.1";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arc-manifest-mutation-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function activate(
  manifest: ArcRuntimeManifest,
  runtimeId: "codex" | "claude-code" | "omp",
  version: string,
): ArcRuntimeManifest {
  return {
    ...manifest,
    runtimes: {
      ...manifest.runtimes,
      [runtimeId]: {
        activeVersion: version,
        previousVersion: manifest.runtimes[runtimeId].activeVersion,
        knownGoodVersion: version,
        source: "arc-bundled",
        digest: "0".repeat(64),
        installedAt: 1,
      },
    },
  };
}

async function seedManifest(manifestPath: string): Promise<void> {
  await writeArcRuntimeManifest({
    manifest: createEmptyArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      platform: PLATFORM,
    }),
    manifestPath,
  });
}


async function readManifestOrThrow(manifestPath: string): Promise<ArcRuntimeManifest> {
  const result = await readArcRuntimeManifest({
    createdByArcVersion: CREATED_BY,
    manifestPath,
    platform: PLATFORM,
  });
  if (result.kind !== "ok" && result.kind !== "missing") {
    throw new Error(`expected a readable manifest, got ${result.kind}`);
  }
  return result.manifest;
}

describe("mutateArcRuntimeManifest", () => {
  it("serializes concurrent mutations so disjoint agent updates both persist", async () => {
    const root = await tempDir();
    const manifestPath = join(root, "runtime-manifest.json");
    await seedManifest(manifestPath);

    // Deterministic interlock: the Codex mutator blocks until the test has
    // confirmed the Claude mutation is queued behind it, widening the
    // read-modify-write overlap without wall-clock sleeps. Without
    // serialization both mutators would read the empty manifest and the
    // second commit would drop the first agent's update.
    // Executor form: the desktop tsconfig lib predates Promise.withResolvers.
    let releaseCodex!: () => void;
    const codexGate = new Promise<void>((resolvePromise) => {
      releaseCodex = resolvePromise;
    });
    let signalCodexInside!: () => void;
    const codexInside = new Promise<void>((resolvePromise) => {
      signalCodexInside = resolvePromise;
    });
    const codexMutation = mutateArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath,
      platform: PLATFORM,
      mutate: async (manifest) => {
        signalCodexInside();
        await codexGate;
        return activate(manifest, "codex", "0.155.1");
      },
    });
    await codexInside;
    const claudeMutation = mutateArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath,
      platform: PLATFORM,
      mutate: async (manifest) => activate(manifest, "claude-code", "2.1.276"),
    });
    releaseCodex();
    await Promise.all([codexMutation, claudeMutation]);

    const result = await readManifestOrThrow(manifestPath);
    expect(result.runtimes.codex.activeVersion).toBe("0.155.1");
    expect(result.runtimes["claude-code"].activeVersion).toBe(
      "2.1.276",
    );
  });

  it("each mutator observes the previous mutator's committed state", async () => {
    const root = await tempDir();
    const manifestPath = join(root, "runtime-manifest.json");
    await seedManifest(manifestPath);

    const observedVersions: Array<string | null> = [];
    await mutateArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath,
      platform: PLATFORM,
      mutate: async (manifest) => activate(manifest, "codex", "0.155.1"),
    });
    await mutateArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath,
      platform: PLATFORM,
      mutate: async (manifest) => {
        observedVersions.push(manifest.runtimes.codex.activeVersion);
        return activate(manifest, "omp", "18.2.6");
      },
    });

    expect(observedVersions).toEqual(["0.155.1"]);
    const result = await readManifestOrThrow(manifestPath);
    expect(result.runtimes.omp.activeVersion).toBe("18.2.6");
  });

  it("does not write the file when the mutator leaves the manifest unchanged", async () => {
    const root = await tempDir();
    const manifestPath = join(root, "runtime-manifest.json");
    await mutateArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath,
      platform: PLATFORM,
      mutate: async (manifest) => manifest,
    });
    await expect(access(manifestPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("a failing mutator does not poison the chain for the next mutation", async () => {
    const root = await tempDir();
    const manifestPath = join(root, "runtime-manifest.json");
    await seedManifest(manifestPath);

    await expect(
      mutateArcRuntimeManifest({
        createdByArcVersion: CREATED_BY,
        manifestPath,
        platform: PLATFORM,
        mutate: async () => {
          throw new Error("simulated commit failure");
        },
      }),
    ).rejects.toThrow("simulated commit failure");

    await mutateArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath,
      platform: PLATFORM,
      mutate: async (manifest) => activate(manifest, "codex", "0.155.1"),
    });

    const result = await readManifestOrThrow(manifestPath);
    expect(result.runtimes.codex.activeVersion).toBe("0.155.1");
  });

  it("rejects mutations against a future schema version without touching the file", async () => {
    const root = await tempDir();
    const manifestPath = join(root, "runtime-manifest.json");
    const future = {
      ...createEmptyArcRuntimeManifest({
        createdByArcVersion: CREATED_BY,
        platform: PLATFORM,
      }),
      schemaVersion: 999,
    };
    await writeFile(manifestPath, `${JSON.stringify(future)}\n`, "utf8");
    const before = await readFile(manifestPath);

    await expect(
      mutateArcRuntimeManifest({
        createdByArcVersion: CREATED_BY,
        manifestPath,
        platform: PLATFORM,
        mutate: async (manifest) => activate(manifest, "codex", "0.155.1"),
      }),
    ).rejects.toThrow("unsupported schema version");

    expect(await readFile(manifestPath)).toEqual(before);
  });
});
