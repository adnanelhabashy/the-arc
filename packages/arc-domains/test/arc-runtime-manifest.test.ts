import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ARC_RUNTIME_MANIFEST_SCHEMA_VERSION,
  arcRuntimeManifestSchema,
  createEmptyArcRuntimeManifest,
  readArcRuntimeManifest,
  writeArcRuntimeManifest,
  type ArcRuntimeManifest,
} from "../src/arc-runtime/manifest.js";

const CREATED_BY = "0.43.1";
const PLATFORM_IDENTITY = "darwin-arm64";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arc-runtime-manifest-test-"));
  tempDirs.push(dir);
  return dir;
}

function readArgs(manifestPath: string) {
  return {
    createdByArcVersion: CREATED_BY,
    manifestPath,
    platform: PLATFORM_IDENTITY,
  };
}

function populatedManifest(): ArcRuntimeManifest {
  const manifest = createEmptyArcRuntimeManifest({
    createdByArcVersion: CREATED_BY,
    platform: PLATFORM_IDENTITY,
  });
  manifest.runtimes.codex = {
    activeVersion: "0.155.1",
    previousVersion: "0.154.0",
    source: "arc-bundled",
    digest: "sha256:abc123",
    installedAt: 1_800_000_000_000,
  };
  manifest.runtimes["claude-code"] = {
    activeVersion: "2.1.0",
    previousVersion: null,
    source: "official-managed-install",
    digest: null,
    installedAt: 1_800_000_000_500,
  };
  return manifest;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("readArcRuntimeManifest", () => {
  it("returns a default empty manifest when the file is absent", async () => {
    const dir = await createTempDir();
    const result = await readArcRuntimeManifest(
      readArgs(join(dir, "arc-runtimes", "runtime-manifest.json")),
    );

    expect(result.kind).toBe("missing");
    if (result.kind !== "missing") {
      return;
    }
    expect(result.manifest.schemaVersion).toBe(
      ARC_RUNTIME_MANIFEST_SCHEMA_VERSION,
    );
    expect(result.manifest.platform).toBe(PLATFORM_IDENTITY);
    expect(result.manifest.runtimes.codex.activeVersion).toBeNull();
    expect(result.manifest.runtimes["claude-code"].activeVersion).toBeNull();
    expect(result.manifest.runtimes.omp.activeVersion).toBeNull();
  });

  it("reads a valid v1 manifest", async () => {
    const dir = await createTempDir();
    const manifestPath = join(dir, "runtime-manifest.json");
    const manifest = populatedManifest();
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    const result = await readArcRuntimeManifest(readArgs(manifestPath));

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    expect(result.manifest).toEqual(manifest);
  });

  it("recovers from malformed JSON without throwing", async () => {
    const dir = await createTempDir();
    const manifestPath = join(dir, "runtime-manifest.json");
    await writeFile(manifestPath, "{ not json", "utf8");

    const result = await readArcRuntimeManifest(readArgs(manifestPath));

    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") {
      return;
    }
    expect(result.problem).toContain("not valid JSON");
    expect(result.manifest.runtimes.codex.activeVersion).toBeNull();
  });

  it("recovers from a schema mismatch without throwing", async () => {
    const dir = await createTempDir();
    const manifestPath = join(dir, "runtime-manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: ARC_RUNTIME_MANIFEST_SCHEMA_VERSION,
        runtimes: { codex: { activeVersion: 42 } },
      }),
      "utf8",
    );

    const result = await readArcRuntimeManifest(readArgs(manifestPath));

    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") {
      return;
    }
    expect(result.manifest.runtimes.codex.activeVersion).toBeNull();
  });

  it("preserves a future schema version and does not treat it as invalid", async () => {
    const dir = await createTempDir();
    const manifestPath = join(dir, "runtime-manifest.json");
    const futureManifest = {
      schemaVersion: ARC_RUNTIME_MANIFEST_SCHEMA_VERSION + 1,
      futureField: { anything: true },
      runtimes: {},
    };
    await writeFile(manifestPath, JSON.stringify(futureManifest), "utf8");

    const result = await readArcRuntimeManifest(readArgs(manifestPath));

    expect(result.kind).toBe("unsupported-version");
    if (result.kind !== "unsupported-version") {
      return;
    }
    expect(result.schemaVersion).toBe(
      ARC_RUNTIME_MANIFEST_SCHEMA_VERSION + 1,
    );
    const preserved = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(preserved).toEqual(futureManifest);
  });
});

describe("writeArcRuntimeManifest", () => {
  it("atomically creates the manifest at the final path", async () => {
    const dir = await createTempDir();
    const manifestPath = join(dir, "nested", "runtime-manifest.json");
    const manifest = populatedManifest();

    await writeArcRuntimeManifest({ manifest, manifestPath });

    const written = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(written).toEqual(manifest);
    expect(await readdir(join(dir, "nested"))).not.toContain(
      ".runtime-manifest.json.tmp",
    );
  });

  it("round-trips through read", async () => {
    const dir = await createTempDir();
    const manifestPath = join(dir, "runtime-manifest.json");
    const manifest = populatedManifest();

    await writeArcRuntimeManifest({ manifest, manifestPath });
    const result = await readArcRuntimeManifest(readArgs(manifestPath));

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.manifest).toEqual(manifest);
    }
  });

  it("rejects a manifest that violates the schema", async () => {
    const dir = await createTempDir();
    const manifestPath = join(dir, "runtime-manifest.json");
    const invalid = {
      ...populatedManifest(),
      schemaVersion: 0,
    } as unknown as ArcRuntimeManifest;

    await expect(
      writeArcRuntimeManifest({ manifest: invalid, manifestPath }),
    ).rejects.toThrow();
    await expect(readFile(manifestPath, "utf8")).rejects.toThrow();
  });
});

describe("arc runtime manifest schema", () => {
  it("has no fields that can carry credentials", () => {
    const shape = arcRuntimeManifestSchema.parse(populatedManifest());
    const serialized = JSON.stringify(shape);

    expect(serialized).not.toMatch(
      /token|apiKey|api[_-]?key|password|secret|credential|auth/i,
    );
  });

  it("strips unknown fields such as planted secrets during parse", () => {
    const withSecret = {
      ...JSON.parse(JSON.stringify(populatedManifest())),
      oauthToken: "plant",
      runtimes: {
        codex: {
          activeVersion: "0.155.1",
          previousVersion: null,
          source: "arc-bundled",
          digest: null,
          installedAt: null,
          apiKey: "plant",
        },
        "claude-code": {
          activeVersion: null,
          previousVersion: null,
          source: null,
          digest: null,
          installedAt: null,
        },
        omp: {
          activeVersion: null,
          previousVersion: null,
          source: null,
          digest: null,
          installedAt: null,
        },
      },
    };

    const parsed = arcRuntimeManifestSchema.parse(withSecret);

    expect(JSON.stringify(parsed)).not.toContain("plant");
  });
});
