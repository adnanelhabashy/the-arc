import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEmptyVoiceRuntimeManifest,
  mutateVoiceRuntimeManifest,
  readVoiceRuntimeManifest,
  writeVoiceRuntimeManifest,
} from "../src/manifest.js";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "arc-voice-manifest-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("createEmptyVoiceRuntimeManifest", () => {
  it("describes an uninstalled runtime", () => {
    expect(
      createEmptyVoiceRuntimeManifest({
        createdByArcVersion: "0.9.0",
        platform: "darwin-arm64",
        arch: "arm64",
      }),
    ).toEqual({
      schemaVersion: 1,
      runtimeId: "voicebox",
      createdByArcVersion: "0.9.0",
      platform: "darwin-arm64",
      arch: "arm64",
      activeVersion: null,
      previousVersion: null,
      knownGoodVersion: null,
      source: null,
      installPath: null,
      digest: null,
      digestsByVersion: {},
      installedAt: null,
      healthState: "unknown",
    });
  });
});

describe("readVoiceRuntimeManifest", () => {
  const args = {
    createdByArcVersion: "0.9.0",
    platform: "darwin-arm64",
    arch: "arm64",
  };

  it("reports a missing manifest rather than inventing one", async () => {
    const root = await createRoot();

    expect(
      await readVoiceRuntimeManifest({
        ...args,
        manifestPath: join(root, "runtime-manifest.json"),
      }),
    ).toEqual({ kind: "missing" });
  });

  it("reports a manifest that is not valid JSON", async () => {
    const root = await createRoot();
    const manifestPath = join(root, "runtime-manifest.json");
    await writeFile(manifestPath, "{not json", "utf8");

    const read = await readVoiceRuntimeManifest({ ...args, manifestPath });
    expect(read.kind).toBe("invalid");
  });

  it("reports a manifest that does not match the schema", async () => {
    const root = await createRoot();
    const manifestPath = join(root, "runtime-manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...createEmptyVoiceRuntimeManifest(args),
        healthState: "sick",
      }),
      "utf8",
    );

    const read = await readVoiceRuntimeManifest({ ...args, manifestPath });
    expect(read).toEqual({
      kind: "invalid",
      problem: expect.stringContaining("healthState"),
    });
  });

  it("round-trips a written manifest", async () => {
    const root = await createRoot();
    const manifestPath = join(root, "nested", "runtime-manifest.json");
    const manifest = {
      ...createEmptyVoiceRuntimeManifest(args),
      activeVersion: "0.5.0",
      healthState: "healthy" as const,
    };

    await writeVoiceRuntimeManifest({ manifestPath, manifest });

    expect(await readVoiceRuntimeManifest({ ...args, manifestPath })).toEqual({
      kind: "ok",
      manifest,
    });
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual(manifest);
  });
});

describe("mutateVoiceRuntimeManifest", () => {
  it("serializes concurrent read-modify-write cycles", async () => {
    const root = await createRoot();
    const manifestPath = join(root, "runtime-manifest.json");
    const args = {
      manifestPath,
      createdByArcVersion: "0.9.0",
      platform: "darwin-arm64",
      arch: "arm64",
    };

    await Promise.all([
      mutateVoiceRuntimeManifest({
        ...args,
        mutate: (manifest) => ({
          ...manifest,
          digestsByVersion: { ...manifest.digestsByVersion, "0.4.0": "aaaa" },
        }),
      }),
      mutateVoiceRuntimeManifest({
        ...args,
        mutate: (manifest) => ({
          ...manifest,
          digestsByVersion: { ...manifest.digestsByVersion, "0.5.0": "bbbb" },
        }),
      }),
    ]);

    const read = await readVoiceRuntimeManifest(args);
    expect(read.kind).toBe("ok");
    expect(read.kind === "ok" ? read.manifest.digestsByVersion : null).toEqual({
      "0.4.0": "aaaa",
      "0.5.0": "bbbb",
    });
  });
});
