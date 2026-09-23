import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildArcManagedRuntimeEnvironment } from "../src/arc-runtime/environment.js";
import { createArcRuntimePaths } from "../src/arc-runtime/paths.js";
import type { ArcActiveRuntime } from "../src/arc-runtime/types.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arc-env-test-"));
  tempDirs.push(dir);
  return dir;
}

async function fakeCodex(dir: string, identity: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "codex");
  await writeFile(path, `#!/bin/sh\necho "${identity}"\n`, "utf8");
  await chmod(path, 0o755);
  return path;
}

function codexVersion(
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile("codex", ["--version"], { env, cwd }, (error, stdout) => {
      if (error !== null) {
        rejectPromise(error);
        return;
      }
      resolvePromise(stdout.trim());
    });
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("Arc-managed Codex environment resolution", () => {
  it("resolves Arc Codex even when a global Codex exists", async () => {
    const root = await tempDir();
    const userDataPath = join(root, "userData");
    const globalBin = join(root, "global-bin");
    const isolatedHome = join(root, "home");
    await mkdir(globalBin, { recursive: true });
    await mkdir(isolatedHome, { recursive: true });
    await fakeCodex(globalBin, "global-codex");
    const managedCodex = await fakeCodex(
      join(userDataPath, "arc-runtimes", "runtimes", "codex", "0.155.1"),
      "arc-managed-codex",
    );

    const runtimePaths = createArcRuntimePaths({ userDataPath });
    const activeRuntimes: ArcActiveRuntime[] = [
      { id: "codex", executablePath: managedCodex },
    ];
    const env = buildArcManagedRuntimeEnvironment({
      activeRuntimes,
      env: { PATH: globalBin, HOME: isolatedHome },
      platform: "darwin",
      runtimePaths,
    });

    await expect(codexVersion(env)).resolves.toBe("arc-managed-codex");
  });

  it("resolves Arc Codex with no Codex anywhere on the original PATH", async () => {
    const root = await tempDir();
    const userDataPath = join(root, "userData");
    const isolatedHome = join(root, "home");
    await mkdir(isolatedHome, { recursive: true });
    const managedCodex = await fakeCodex(
      join(userDataPath, "arc-runtimes", "runtimes", "codex", "0.155.1"),
      "arc-managed-codex",
    );

    const runtimePaths = createArcRuntimePaths({ userDataPath });
    const env = buildArcManagedRuntimeEnvironment({
      activeRuntimes: [{ id: "codex", executablePath: managedCodex }],
      env: { PATH: "/usr/bin:/bin", HOME: isolatedHome },
      platform: "darwin",
      runtimePaths,
    });

    expect(env.PATH?.startsWith(`${join(userDataPath, "arc-runtimes", "runtimes", "codex", "0.155.1")}:`)).toBe(
      true,
    );
    await expect(codexVersion(env)).resolves.toBe("arc-managed-codex");
  });

  it("preserves the original PATH when no Arc Codex is active", async () => {
    const userDataPath = join(await tempDir(), "userData");
    const runtimePaths = createArcRuntimePaths({ userDataPath });
    const env = buildArcManagedRuntimeEnvironment({
      activeRuntimes: [],
      env: { PATH: "/usr/bin:/bin" },
      platform: "darwin",
      runtimePaths,
    });
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  it("declares Arc mode for the spawned server", async () => {
    const userDataPath = join(await tempDir(), "userData");
    const runtimePaths = createArcRuntimePaths({ userDataPath });
    const env = buildArcManagedRuntimeEnvironment({
      activeRuntimes: [],
      arcAppVersion: "1.2.3",
      arcSeedRoot: "/opt/arc/resources/arc-runtimes",
      env: { PATH: "/usr/bin:/bin" },
      platform: "darwin",
      runtimePaths,
    });
    expect(env.BB_ARC_RUNTIME_ROOT).toBe(userDataPath);
    expect(env.BB_ARC_APP_VERSION).toBe("1.2.3");
    expect(env.BB_ARC_SEED_ROOT).toBe("/opt/arc/resources/arc-runtimes");
  });

  it("omits Arc version and seed when not provided", async () => {
    const userDataPath = join(await tempDir(), "userData");
    const runtimePaths = createArcRuntimePaths({ userDataPath });
    const env = buildArcManagedRuntimeEnvironment({
      activeRuntimes: [],
      env: { PATH: "/usr/bin:/bin" },
      platform: "darwin",
      runtimePaths,
    });
    expect(env.BB_ARC_RUNTIME_ROOT).toBe(userDataPath);
    expect(env.BB_ARC_APP_VERSION).toBeUndefined();
    expect(env.BB_ARC_SEED_ROOT).toBeUndefined();
  });
});

describe("Arc-managed voice environment", () => {
  it("selects Arc Voice and publishes the host roots for Arc-owned launches", async () => {
    const userDataPath = join(await tempDir(), "userData");
    const runtimePaths = createArcRuntimePaths({ userDataPath });
    const env = buildArcManagedRuntimeEnvironment({
      activeRuntimes: [],
      arcAppVersion: "1.2.3",
      arcSeedRoot: "/opt/arc/resources/arc-runtimes",
      env: { PATH: "/usr/bin:/bin" },
      platform: "darwin",
      runtimePaths,
    });

    expect(env.BB_TRANSCRIPTION).toBe("arc-voice/default");
    expect(env.ARC_VOICE_RUNTIME_ROOT).toBe(userDataPath);
    expect(env.ARC_VOICE_APP_VERSION).toBe("1.2.3");
    expect(env.ARC_VOICE_SEED_ROOT).toBe("/opt/arc/resources/arc-runtimes");
  });

  it("keeps an explicit transcription model over the Arc Voice default", async () => {
    const userDataPath = join(await tempDir(), "userData");
    const runtimePaths = createArcRuntimePaths({ userDataPath });
    const env = buildArcManagedRuntimeEnvironment({
      activeRuntimes: [],
      arcAppVersion: "1.2.3",
      arcSeedRoot: "/opt/arc/resources/arc-runtimes",
      env: { BB_TRANSCRIPTION: "codex/gpt-transcribe", PATH: "/usr/bin:/bin" },
      platform: "darwin",
      runtimePaths,
    });

    expect(env.BB_TRANSCRIPTION).toBe("codex/gpt-transcribe");
  });

  it("leaves non-Arc launches without voice variables", async () => {
    const userDataPath = join(await tempDir(), "userData");
    const runtimePaths = createArcRuntimePaths({ userDataPath });
    const env = buildArcManagedRuntimeEnvironment({
      activeRuntimes: [],
      env: { PATH: "/usr/bin:/bin" },
      platform: "darwin",
      runtimePaths,
    });

    expect(env.BB_TRANSCRIPTION).toBeUndefined();
    expect(env.ARC_VOICE_RUNTIME_ROOT).toBeUndefined();
    expect(env.ARC_VOICE_APP_VERSION).toBeUndefined();
    expect(env.ARC_VOICE_SEED_ROOT).toBeUndefined();
  });
});

async function fakeOmp(dir: string, identity: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "omp");
  await writeFile(path, `#!/bin/sh\necho "${identity}"\n`, "utf8");
  await chmod(path, 0o755);
  return path;
}

function ompVersion(env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile("omp", ["--version"], { env }, (error, stdout) => {
      if (error !== null) {
        rejectPromise(error);
        return;
      }
      resolvePromise(stdout.trim());
    });
  });
}

describe("Arc-managed OMP environment resolution", () => {
  it("resolves Arc OMP even when a global OMP exists", async () => {
    const root = await tempDir();
    const userDataPath = join(root, "userData");
    const globalBin = join(root, "global-bin");
    const managedOmp = await fakeOmp(
      join(userDataPath, "arc-runtimes", "runtimes", "omp", "18.2.6"),
      "arc-managed-omp",
    );
    await fakeOmp(globalBin, "global-omp");

    const runtimePaths = createArcRuntimePaths({ userDataPath });
    const env = buildArcManagedRuntimeEnvironment({
      activeRuntimes: [{ id: "omp", executablePath: managedOmp }],
      env: { PATH: globalBin },
      homeDirectory: join(root, "home"),
      platform: "darwin",
      runtimePaths,
    });

    await expect(ompVersion(env)).resolves.toBe("arc-managed-omp");
  });

  it("isolates OMP state under Arc userData via verified OMP overrides", async () => {
    const root = await tempDir();
    const homeDirectory = join(root, "home");
    // Mirrors macOS: Electron userData lives inside the user's home directory.
    const userDataPath = join(
      homeDirectory,
      "Library",
      "Application Support",
      "Arc Agent",
    );
    const managedOmp = await fakeOmp(
      join(userDataPath, "arc-runtimes", "runtimes", "omp", "18.2.6"),
      "arc-managed-omp",
    );

    const runtimePaths = createArcRuntimePaths({ userDataPath });
    const env = buildArcManagedRuntimeEnvironment({
      activeRuntimes: [{ id: "omp", executablePath: managedOmp }],
      env: { PATH: "/usr/bin:/bin" },
      homeDirectory,
      platform: "darwin",
      runtimePaths,
    });

    expect(env.PI_CODING_AGENT_DIR).toBe(join(userDataPath, "omp", "agent"));
    const relativeConfigDir = env.PI_CONFIG_DIR;
    expect(relativeConfigDir).toBeDefined();
    expect(join(homeDirectory, relativeConfigDir ?? "")).toBe(
      join(userDataPath, "omp"),
    );
  });

  it("does not leak isolation variables when Arc OMP is not active", async () => {
    const userDataPath = join(await tempDir(), "userData");
    const runtimePaths = createArcRuntimePaths({ userDataPath });
    const env = buildArcManagedRuntimeEnvironment({
      activeRuntimes: [],
      env: { PATH: "/usr/bin:/bin" },
      platform: "darwin",
      runtimePaths,
    });
    expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(env.PI_CONFIG_DIR).toBeUndefined();
  });

  it("keeps existing user OMP overrides untouched when Arc OMP is not active", async () => {
    const userDataPath = join(await tempDir(), "userData");
    const runtimePaths = createArcRuntimePaths({ userDataPath });
    const env = buildArcManagedRuntimeEnvironment({
      activeRuntimes: [],
      env: {
        PATH: "/usr/bin:/bin",
        PI_CODING_AGENT_DIR: "/Users/someone/.omp/agent",
        PI_CONFIG_DIR: ".omp",
      },
      platform: "darwin",
      runtimePaths,
    });
    expect(env.PI_CODING_AGENT_DIR).toBe("/Users/someone/.omp/agent");
    expect(env.PI_CONFIG_DIR).toBe(".omp");
  });

  it("skips PI_CONFIG_DIR when userData lives outside the home directory", async () => {
    const root = await tempDir();
    const userDataPath = join(root, "userData");
    const homeDirectory = join(root, "home");
    const managedOmp = await fakeOmp(
      join(userDataPath, "arc-runtimes", "runtimes", "omp", "18.2.6"),
      "arc-managed-omp",
    );

    const runtimePaths = createArcRuntimePaths({ userDataPath });
    const env = buildArcManagedRuntimeEnvironment({
      activeRuntimes: [{ id: "omp", executablePath: managedOmp }],
      env: { PATH: "/usr/bin:/bin" },
      homeDirectory,
      platform: "darwin",
      runtimePaths,
    });

    expect(env.PI_CODING_AGENT_DIR).toBe(join(userDataPath, "omp", "agent"));
    expect(env.PI_CONFIG_DIR).toBeUndefined();
  });
});

async function fakeClaude(dir: string, identity: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "claude");
  await writeFile(path, `#!/bin/sh\necho "${identity}"\n`, "utf8");
  await chmod(path, 0o755);
  return path;
}

describe("Arc-managed Claude Code environment", () => {
  it("points BB_CLAUDE_CODE_EXECUTABLE at the managed binary and disables self-updates", async () => {
    const root = await tempDir();
    const userDataPath = join(root, "userData");
    const globalBin = join(root, "global-bin");
    const managedClaude = await fakeClaude(
      join(userDataPath, "arc-runtimes", "runtimes", "claude-code", "2.1.276"),
      "arc-managed-claude",
    );
    await fakeClaude(globalBin, "global-claude");

    const runtimePaths = createArcRuntimePaths({ userDataPath });
    const env = buildArcManagedRuntimeEnvironment({
      activeRuntimes: [{ id: "claude-code", executablePath: managedClaude }],
      env: { PATH: globalBin },
      platform: "darwin",
      runtimePaths,
    });

    expect(env.BB_CLAUDE_CODE_EXECUTABLE).toBe(managedClaude);
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
    expect(env.DISABLE_UPDATES).toBe("1");
  });

  it("leaves update policy and executable override untouched when Claude is not active", async () => {
    const userDataPath = join(await tempDir(), "userData");
    const runtimePaths = createArcRuntimePaths({ userDataPath });
    const env = buildArcManagedRuntimeEnvironment({
      activeRuntimes: [],
      env: {
        PATH: "/usr/bin:/bin",
        BB_CLAUDE_CODE_EXECUTABLE: "/Users/someone/.local/bin/claude",
      },
      platform: "darwin",
      runtimePaths,
    });
    expect(env.BB_CLAUDE_CODE_EXECUTABLE).toBe(
      "/Users/someone/.local/bin/claude",
    );
    expect(env.DISABLE_AUTOUPDATER).toBeUndefined();
    expect(env.DISABLE_UPDATES).toBeUndefined();
  });

  it("serves all three engines from one child environment", async () => {
    const root = await tempDir();
    const userDataPath = join(root, "userData");
    const homeDirectory = join(root, "home");
    const globalBin = join(root, "global-bin");
    const managedCodex = await fakeCodex(
      join(userDataPath, "arc-runtimes", "runtimes", "codex", "0.155.1"),
      "arc-managed-codex",
    );
    const managedOmp = await fakeOmp(
      join(userDataPath, "arc-runtimes", "runtimes", "omp", "18.2.6"),
      "arc-managed-omp",
    );
    const managedClaude = await fakeClaude(
      join(userDataPath, "arc-runtimes", "runtimes", "claude-code", "2.1.276"),
      "arc-managed-claude",
    );
    await fakeCodex(globalBin, "global-codex");
    await fakeOmp(globalBin, "global-omp");
    await fakeClaude(globalBin, "global-claude");

    const runtimePaths = createArcRuntimePaths({ userDataPath });
    const env = buildArcManagedRuntimeEnvironment({
      activeRuntimes: [
        { id: "codex", executablePath: managedCodex },
        { id: "omp", executablePath: managedOmp },
        { id: "claude-code", executablePath: managedClaude },
      ],
      env: { PATH: globalBin, HOME: homeDirectory },
      homeDirectory,
      platform: "darwin",
      runtimePaths,
    });

    // PATH precedence: codex → omp → claude → original (Phase 1 ordering).
    const entries = env.PATH?.split(":") ?? [];
    expect(entries[0]).toBe(dirname(managedCodex));
    expect(entries[1]).toBe(dirname(managedOmp));
    expect(entries[2]).toBe(dirname(managedClaude));
    expect(entries[3]).toBe(globalBin);

    // Each Arc engine beats its global twin inside the child env.
    await expect(codexVersion(env)).resolves.toBe("arc-managed-codex");
    await expect(ompVersion(env)).resolves.toBe("arc-managed-omp");
    await expect(
      new Promise<string>((resolvePromise, rejectPromise) => {
        execFile(
          env.BB_CLAUDE_CODE_EXECUTABLE ?? "claude",
          ["--version"],
          { env },
          (error, stdout) => {
            if (error !== null) {
              rejectPromise(error);
              return;
            }
            resolvePromise(stdout.trim());
          },
        );
      }),
    ).resolves.toBe("arc-managed-claude");

    // Phase 4 OMP isolation survives alongside Claude.
    expect(env.PI_CODING_AGENT_DIR).toBe(join(userDataPath, "omp", "agent"));

    // Arc-owned Claude cannot silently self-update.
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
    expect(env.DISABLE_UPDATES).toBe("1");
  });
});

describe("Arc-managed runtime executable overrides", () => {
  it("names every managed runtime explicitly so PATH order cannot decide execution", async () => {
    const root = await tempDir();
    const userDataPath = join(root, "userData");
    const globalBin = join(root, "global-bin");
    await mkdir(globalBin, { recursive: true });
    const runtimesRoot = join(userDataPath, "arc-runtimes", "runtimes");
    const managedCodex = await fakeCodex(
      join(runtimesRoot, "codex", "0.155.1"),
      "arc-managed-codex",
    );
    const managedClaude = await fakeClaude(
      join(runtimesRoot, "claude-code", "2.1.276"),
      "arc-managed-claude",
    );
    const managedOmp = await fakeOmp(
      join(runtimesRoot, "omp", "18.2.6"),
      "arc-managed-omp",
    );

    const runtimePaths = createArcRuntimePaths({ userDataPath });
    const env = buildArcManagedRuntimeEnvironment({
      activeRuntimes: [
        { id: "codex", executablePath: managedCodex },
        { id: "claude-code", executablePath: managedClaude },
        { id: "omp", executablePath: managedOmp },
      ],
      env: { PATH: globalBin, HOME: join(root, "home") },
      platform: "darwin",
      runtimePaths,
    });

    expect(env.BB_CODEX_BRIDGE_APP_SERVER_COMMAND).toBe(managedCodex);
    expect(env.BB_CLAUDE_CODE_EXECUTABLE).toBe(managedClaude);
    expect(env.BB_OMP_EXECUTABLE).toBe(managedOmp);
    expect(env.BB_ARC_RUNTIME_ROOT).toBe(userDataPath);
  });

  it("leaves the overrides unset when a runtime is not active", async () => {
    const userDataPath = join(await tempDir(), "userData");
    const runtimePaths = createArcRuntimePaths({ userDataPath });
    const env = buildArcManagedRuntimeEnvironment({
      activeRuntimes: [],
      env: { PATH: "/usr/bin:/bin" },
      platform: "darwin",
      runtimePaths,
    });

    expect(env.BB_CODEX_BRIDGE_APP_SERVER_COMMAND).toBeUndefined();
    expect(env.BB_OMP_EXECUTABLE).toBeUndefined();
  });
});
