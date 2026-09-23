import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createArcOmpRuntimeResolver } from "../src/arc-account/omp-account-source.js";
import {
  readArcRuntimeManifest,
  writeArcRuntimeManifest,
} from "../src/arc-runtime/manifest.js";
import { createArcRuntimePaths } from "../src/arc-runtime/paths.js";

const PLATFORM = "darwin-arm64";
const CREATED_BY = "0.43.1";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arc-omp-resolver-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("createArcOmpRuntimeResolver", () => {
  it("resolves the manifest-active OMP with Arc-private state isolation", async () => {
    const root = await tempDir();
    const home = join(root, "home");
    const userDataPath = join(home, "Library", "Application Support", "Arc Agent");
    await mkdir(home, { recursive: true });
    const paths = createArcRuntimePaths({ userDataPath });
    await mkdir(dirname(paths.executablePath("omp", "18.2.6")), {
      recursive: true,
    });
    await writeFile(
      paths.executablePath("omp", "18.2.6"),
      "#!/bin/sh\necho ok\n",
      "utf8",
    );
    await chmod(paths.executablePath("omp", "18.2.6"), 0o755);

    const read = await readArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath: paths.manifestPath,
      platform: PLATFORM,
    });
    if (read.kind === "unsupported-version") {
      throw new Error(`unexpected manifest state: ${read.schemaVersion}`);
    }
    const manifest = read.manifest;
    manifest.runtimes.omp = {
      activeVersion: "18.2.6",
      previousVersion: null,
      knownGoodVersion: "18.2.6",
      source: "arc-bundled",
      digest: "0".repeat(64),
      componentsByVersion: {},
      installedAt: 1,
    };
    await writeArcRuntimeManifest({
      manifest,
      manifestPath: paths.manifestPath,
    });

    const resolver = createArcOmpRuntimeResolver({
      createdByArcVersion: CREATED_BY,
      homeDirectory: home,
      platform: PLATFORM,
      runtimePaths: paths,
      env: { HOME: home, PATH: "/usr/bin" },
    });
    const runtime = await resolver();
    expect(runtime).not.toBeNull();
    // The managed binary — never a global `omp` from PATH.
    expect(runtime?.executablePath).toBe(
      paths.executablePath("omp", "18.2.6"),
    );
    // Arc-private OMP state root; the user's standalone ~/.omp is untouched
    // because the child HOME stays the user's home and both PI overrides
    // point under Arc's userData.
    expect(runtime?.env["PI_CODING_AGENT_DIR"]).toBe(
      join(userDataPath, "omp", "agent"),
    );
    const configDir = runtime?.env["PI_CONFIG_DIR"];
    expect(typeof configDir).toBe("string");
    expect(runtime?.env["HOME"]).toBe(home);
    // No env var points OMP at the standalone install.
    for (const value of Object.values(runtime?.env ?? {})) {
      expect(String(value)).not.toContain("/.omp");
    }
  });

  it("returns null when OMP is not prepared", async () => {
    const root = await tempDir();
    const paths = createArcRuntimePaths({
      userDataPath: join(root, "userData"),
    });
    const resolver = createArcOmpRuntimeResolver({
      createdByArcVersion: CREATED_BY,
      homeDirectory: join(root, "home"),
      platform: PLATFORM,
      runtimePaths: paths,
      env: {},
    });
    expect(await resolver()).toBeNull();
  });
});
