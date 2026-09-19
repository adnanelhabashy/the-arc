import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BB_CLAUDE_CODE_EXECUTABLE_ENV,
  buildArcManagedRuntimeEnvironment,
  resolveActiveArcRuntimes,
} from "../src/arc-runtime/environment.js";
import { createArcRuntimePaths } from "../src/arc-runtime/paths.js";
import type { ArcActiveRuntime } from "../src/arc-runtime/types.js";

const PLATFORM = process.platform;
const DELIMITER = PLATFORM === "win32" ? ";" : ":";
const PATH_KEY = PLATFORM === "win32" ? "Path" : "PATH";

function createPaths(userDataPath = "/tmp/arc-user-data") {
  return createArcRuntimePaths({ userDataPath });
}

function activeRuntime(
  id: ArcActiveRuntime["id"],
  userDataPath: string,
  version: string,
): ArcActiveRuntime {
  const paths = createPaths(userDataPath);
  return { id, executablePath: paths.executablePath(id, version) };
}

function buildEnv(
  env: NodeJS.ProcessEnv,
  activeRuntimes: readonly ArcActiveRuntime[] = [],
  userDataPath = "/tmp/arc-user-data",
): NodeJS.ProcessEnv {
  const runtimePaths = createPaths(userDataPath);
  return buildArcManagedRuntimeEnvironment({
    activeRuntimes,
    env,
    platform: PLATFORM,
    runtimePaths,
  });
}

describe("createArcRuntimePaths", () => {
  it("resolves the runtime layout under the Electron userData path", () => {
    const paths = createPaths("/Users/example/Library/Application Support/Arc");

    expect(paths.root).toBe(
      "/Users/example/Library/Application Support/Arc/arc-runtimes",
    );
    expect(paths.manifestPath).toBe(
      "/Users/example/Library/Application Support/Arc/arc-runtimes/runtime-manifest.json",
    );
    expect(paths.stagingRoot).toBe(
      "/Users/example/Library/Application Support/Arc/arc-runtimes/staging",
    );
    expect(paths.runtimeRoot("codex")).toBe(
      "/Users/example/Library/Application Support/Arc/arc-runtimes/runtimes/codex",
    );
    expect(paths.versionRoot("omp", "1.2.3")).toBe(
      "/Users/example/Library/Application Support/Arc/arc-runtimes/runtimes/omp/1.2.3",
    );
  });

  it("maps runtime ids to the executable names providers expect", () => {
    const paths = createPaths("/tmp/arc-user-data");

    expect(paths.executablePath("codex", "0.1.0")).toBe(
      "/tmp/arc-user-data/arc-runtimes/runtimes/codex/0.1.0/codex",
    );
    expect(paths.executablePath("claude-code", "managed")).toBe(
      "/tmp/arc-user-data/arc-runtimes/runtimes/claude-code/managed/claude",
    );
    expect(paths.executablePath("omp", "2.0.0")).toBe(
      "/tmp/arc-user-data/arc-runtimes/runtimes/omp/2.0.0/omp",
    );
  });

  it("supports userData paths containing spaces", () => {
    const paths = createPaths("/tmp/My Arc Data");

    expect(paths.executablePath("codex", "0.1.0")).toBe(
      "/tmp/My Arc Data/arc-runtimes/runtimes/codex/0.1.0/codex",
    );
  });
});

describe("resolveActiveArcRuntimes", () => {
  it("reports no active runtimes when no manifest exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arc-runtime-test-"));
    try {
      const paths = createArcRuntimePaths({ userDataPath: dir });
      await expect(
        resolveActiveArcRuntimes({
          createdByArcVersion: "0.43.1",
          platform: "darwin-arm64",
          runtimePaths: paths,
        }),
      ).resolves.toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildArcManagedRuntimeEnvironment", () => {
  it("leaves PATH untouched when no Arc runtimes are active", () => {
    const env = buildEnv({ PATH: "/usr/bin:/bin" });

    expect(env[PATH_KEY]).toBe("/usr/bin:/bin");
  });

  it("prepends the Codex directory before the original PATH", () => {
    const runtime = activeRuntime("codex", "/tmp/arc-user-data", "0.1.0");
    const env = buildEnv({ PATH: "/usr/bin:/bin" }, [runtime]);

    expect(env[PATH_KEY]).toBe(
      [
        "/tmp/arc-user-data/arc-runtimes/runtimes/codex/0.1.0",
        "/usr/bin",
        "/bin",
      ].join(DELIMITER),
    );
  });

  it("prepends the OMP directory before the original PATH", () => {
    const runtime = activeRuntime("omp", "/tmp/arc-user-data", "2.0.0");
    const env = buildEnv({ PATH: "/usr/bin:/bin" }, [runtime]);

    expect(env[PATH_KEY]).toBe(
      [
        "/tmp/arc-user-data/arc-runtimes/runtimes/omp/2.0.0",
        "/usr/bin",
        "/bin",
      ].join(DELIMITER),
    );
  });

  it("prepends Codex, OMP, then Claude in a deterministic order", () => {
    const runtimes = [
      activeRuntime("claude-code", "/tmp/arc-user-data", "managed"),
      activeRuntime("omp", "/tmp/arc-user-data", "2.0.0"),
      activeRuntime("codex", "/tmp/arc-user-data", "0.1.0"),
    ];
    const env = buildEnv({ PATH: "/usr/bin:/bin" }, runtimes);

    expect(env[PATH_KEY]).toBe(
      [
        "/tmp/arc-user-data/arc-runtimes/runtimes/codex/0.1.0",
        "/tmp/arc-user-data/arc-runtimes/runtimes/omp/2.0.0",
        "/tmp/arc-user-data/arc-runtimes/runtimes/claude-code/managed",
        "/usr/bin",
        "/bin",
      ].join(DELIMITER),
    );
  });

  it("sets BB_CLAUDE_CODE_EXECUTABLE to the absolute Claude path when active", () => {
    const runtime = activeRuntime(
      "claude-code",
      "/tmp/arc-user-data",
      "managed",
    );
    const env = buildEnv({ PATH: "/usr/bin:/bin" }, [runtime]);

    expect(env[BB_CLAUDE_CODE_EXECUTABLE_ENV]).toBe(
      "/tmp/arc-user-data/arc-runtimes/runtimes/claude-code/managed/claude",
    );
  });

  it("keeps an existing BB_CLAUDE_CODE_EXECUTABLE when no Arc Claude is active", () => {
    const env = buildEnv({
      PATH: "/usr/bin:/bin",
      [BB_CLAUDE_CODE_EXECUTABLE_ENV]: "/custom/claude",
    });

    expect(env[BB_CLAUDE_CODE_EXECUTABLE_ENV]).toBe("/custom/claude");
  });

  it("lets an active Arc Claude override an existing environment value", () => {
    const runtime = activeRuntime(
      "claude-code",
      "/tmp/arc-user-data",
      "managed",
    );
    const env = buildEnv(
      {
        PATH: "/usr/bin:/bin",
        [BB_CLAUDE_CODE_EXECUTABLE_ENV]: "/custom/claude",
      },
      [runtime],
    );

    expect(env[BB_CLAUDE_CODE_EXECUTABLE_ENV]).toBe(
      "/tmp/arc-user-data/arc-runtimes/runtimes/claude-code/managed/claude",
    );
  });

  it("omits BB_CLAUDE_CODE_EXECUTABLE when absent and no Arc Claude is active", () => {
    const env = buildEnv({ PATH: "/usr/bin:/bin" });

    expect(env[BB_CLAUDE_CODE_EXECUTABLE_ENV]).toBeUndefined();
  });

  it("handles a PATH containing spaces", () => {
    const runtime = activeRuntime("codex", "/tmp/arc-user-data", "0.1.0");
    const env = buildEnv({ PATH: "/usr/my dir/bin:/bin" }, [runtime]);

    expect(env[PATH_KEY]).toBe(
      [
        "/tmp/arc-user-data/arc-runtimes/runtimes/codex/0.1.0",
        "/usr/my dir/bin",
        "/bin",
      ].join(DELIMITER),
    );
  });

  it("handles a userData path containing spaces", () => {
    const runtime = activeRuntime("codex", "/tmp/My Arc Data", "0.1.0");
    const env = buildEnv({ PATH: "/usr/bin:/bin" }, [runtime], "/tmp/My Arc Data");

    expect(env[PATH_KEY]).toBe(
      [
        "/tmp/My Arc Data/arc-runtimes/runtimes/codex/0.1.0",
        "/usr/bin",
        "/bin",
      ].join(DELIMITER),
    );
  });

  it("never introduces an empty PATH entry when PATH is undefined", () => {
    const runtime = activeRuntime("codex", "/tmp/arc-user-data", "0.1.0");
    const env = buildEnv({}, [runtime]);

    expect(env[PATH_KEY]).toBe(
      "/tmp/arc-user-data/arc-runtimes/runtimes/codex/0.1.0",
    );
  });

  it("leaves PATH absent when it is undefined and no runtimes are active", () => {
    const env = buildEnv({});

    expect(env[PATH_KEY]).toBeUndefined();
  });

  it("drops an empty original PATH instead of adding a current-directory entry", () => {
    const runtime = activeRuntime("codex", "/tmp/arc-user-data", "0.1.0");
    const env = buildEnv({ PATH: "" }, [runtime]);

    expect(env[PATH_KEY]).toBe(
      "/tmp/arc-user-data/arc-runtimes/runtimes/codex/0.1.0",
    );
  });

  it("does not mutate the input environment", () => {
    const input: NodeJS.ProcessEnv = Object.freeze({
      PATH: "/usr/bin:/bin",
    });
    const runtime = activeRuntime("codex", "/tmp/arc-user-data", "0.1.0");

    const env = buildEnv(input, [runtime]);

    expect(input[PATH_KEY]).toBe("/usr/bin:/bin");
    expect(env).not.toBe(input);
    expect(env[PATH_KEY]).not.toBe(input[PATH_KEY]);
  });

  it("does not prepend the same directory twice", () => {
    const runtimes = [
      activeRuntime("codex", "/tmp/arc-user-data", "0.1.0"),
      activeRuntime("codex", "/tmp/arc-user-data", "0.1.0"),
    ];
    const env = buildEnv(
      { PATH: "/tmp/arc-user-data/arc-runtimes/runtimes/codex/0.1.0:/usr/bin" },
      runtimes,
    );

    expect(env[PATH_KEY]).toBe(
      "/tmp/arc-user-data/arc-runtimes/runtimes/codex/0.1.0:/usr/bin",
    );
  });
});
