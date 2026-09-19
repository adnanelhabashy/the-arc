import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BB_CLAUDE_CODE_EXECUTABLE_ENV,
  buildArcManagedRuntimeEnvironment,
  resolveActiveArcRuntimes,
} from "../src/arc-runtime/environment.js";
import {
  createEmptyArcRuntimeManifest,
  writeArcRuntimeManifest,
  type ArcRuntimeManifest,
} from "../src/arc-runtime/manifest.js";
import {
  createArcRuntimePaths,
  type ArcRuntimePaths,
} from "../src/arc-runtime/paths.js";

const CREATED_BY = "0.43.1";
const PLATFORM_IDENTITY = "darwin-arm64";
const DELIMITER = process.platform === "win32" ? ";" : ":";
const PATH_KEY = process.platform === "win32" ? "Path" : "PATH";

const tempDirs: string[] = [];

interface RuntimeFixture {
  userDataPath: string;
  paths: ArcRuntimePaths;
}

async function createRuntimeFixture(): Promise<RuntimeFixture> {
  const userDataPath = await mkdtemp(
    join(tmpdir(), "arc-runtime-resolution-test-"),
  );
  tempDirs.push(userDataPath);
  return { paths: createArcRuntimePaths({ userDataPath }), userDataPath };
}

async function installExecutable(
  fixture: RuntimeFixture,
  id: "codex" | "claude-code" | "omp",
  version: string,
): Promise<string> {
  const executablePath = fixture.paths.executablePath(id, version);
  await mkdir(join(executablePath, ".."), { recursive: true });
  await writeFile(executablePath, "#!/bin/sh\nexit 0\n", {
    encoding: "utf8",
    mode: 0o755,
  });
  await chmod(executablePath, 0o755);
  return executablePath;
}

async function writeManifest(
  fixture: RuntimeFixture,
  configure: (manifest: ArcRuntimeManifest) => void,
): Promise<void> {
  const manifest = createEmptyArcRuntimeManifest({
    createdByArcVersion: CREATED_BY,
    platform: PLATFORM_IDENTITY,
  });
  configure(manifest);
  await writeArcRuntimeManifest({
    manifest,
    manifestPath: fixture.paths.manifestPath,
  });
}

function resolve(fixture: RuntimeFixture) {
  const diagnostics: string[] = [];
  return {
    diagnostics,
    runtimes: resolveActiveArcRuntimes({
      createdByArcVersion: CREATED_BY,
      onDiagnostic: (message) => {
        diagnostics.push(message);
      },
      platform: PLATFORM_IDENTITY,
      runtimePaths: fixture.paths,
    }),
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("resolveActiveArcRuntimes", () => {
  it("activates nothing when the manifest has no active versions", async () => {
    const fixture = await createRuntimeFixture();
    await writeManifest(fixture, () => undefined);

    const { runtimes } = resolve(fixture);

    expect(await runtimes).toEqual([]);
  });

  it("activates a runtime when the manifest names it and the binary exists", async () => {
    const fixture = await createRuntimeFixture();
    await writeManifest(fixture, (manifest) => {
      manifest.runtimes.codex.activeVersion = "0.155.1";
    });
    const executablePath = await installExecutable(
      fixture,
      "codex",
      "0.155.1",
    );

    const { runtimes } = resolve(fixture);

    expect(await runtimes).toEqual([
      { executablePath, id: "codex" },
    ]);
  });

  it("does not activate a runtime whose manifest binary is missing", async () => {
    const fixture = await createRuntimeFixture();
    await writeManifest(fixture, (manifest) => {
      manifest.runtimes.codex.activeVersion = "0.155.1";
    });

    const { diagnostics, runtimes } = resolve(fixture);

    expect(await runtimes).toEqual([]);
    expect(diagnostics.join("\n")).toContain("stale");
  });

  it("does not activate a stray binary the manifest does not name", async () => {
    const fixture = await createRuntimeFixture();
    await writeManifest(fixture, () => undefined);
    await installExecutable(fixture, "omp", "18.2.6");

    const { runtimes } = resolve(fixture);

    expect(await runtimes).toEqual([]);
  });

  it("keeps the codex, omp, claude-code precedence order in the environment", async () => {
    const fixture = await createRuntimeFixture();
    await writeManifest(fixture, (manifest) => {
      manifest.runtimes["claude-code"].activeVersion = "managed";
      manifest.runtimes.omp.activeVersion = "18.2.6";
      manifest.runtimes.codex.activeVersion = "0.155.1";
    });
    await installExecutable(fixture, "codex", "0.155.1");
    await installExecutable(fixture, "omp", "18.2.6");
    await installExecutable(fixture, "claude-code", "managed");

    const { runtimes } = resolve(fixture);
    const env = buildArcManagedRuntimeEnvironment({
      activeRuntimes: await runtimes,
      env: { PATH: "/usr/bin:/bin" },
      platform: process.platform,
      runtimePaths: fixture.paths,
    });

    expect(env[PATH_KEY]).toBe(
      [
        fixture.paths.versionRoot("codex", "0.155.1"),
        fixture.paths.versionRoot("omp", "18.2.6"),
        fixture.paths.versionRoot("claude-code", "managed"),
        "/usr/bin",
        "/bin",
      ].join(DELIMITER),
    );
  });

  it("preserves an external Claude override when the manifest Claude binary is stale", async () => {
    const fixture = await createRuntimeFixture();
    await writeManifest(fixture, (manifest) => {
      manifest.runtimes["claude-code"].activeVersion = "managed";
    });

    const { runtimes } = resolve(fixture);
    const env = buildArcManagedRuntimeEnvironment({
      activeRuntimes: await runtimes,
      env: {
        PATH: "/usr/bin:/bin",
        [BB_CLAUDE_CODE_EXECUTABLE_ENV]: "/custom/claude",
      },
      platform: process.platform,
      runtimePaths: fixture.paths,
    });

    expect(await runtimes).toEqual([]);
    expect(env[BB_CLAUDE_CODE_EXECUTABLE_ENV]).toBe("/custom/claude");
  });

  it("ignores runtimes when the manifest uses a future schema version", async () => {
    const fixture = await createRuntimeFixture();
    await mkdir(fixture.paths.root, { recursive: true });
    await writeFile(
      fixture.paths.manifestPath,
      JSON.stringify({ schemaVersion: 99, runtimes: {} }),
      "utf8",
    );

    const { diagnostics, runtimes } = resolve(fixture);

    expect(await runtimes).toEqual([]);
    expect(diagnostics.join("\n")).toContain("unsupported schema version");
  });

  it("ignores runtimes when the manifest is corrupt", async () => {
    const fixture = await createRuntimeFixture();
    await mkdir(fixture.paths.root, { recursive: true });
    await writeFile(fixture.paths.manifestPath, "nope", "utf8");

    const { diagnostics, runtimes } = resolve(fixture);

    expect(await runtimes).toEqual([]);
    expect(diagnostics.join("\n")).toContain("not valid JSON");
  });
});
