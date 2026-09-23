import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArcAgentManager,
  type ArcAgentManagerArgs,
} from "../src/arc-agent/manager.js";
import { ArcAgentError } from "../src/arc-agent/types.js";
import { sha256File } from "../src/arc-runtime/digest.js";
import {
  createEmptyArcRuntimeManifest,
  readArcRuntimeManifest,
  writeArcRuntimeManifest,
} from "../src/arc-runtime/manifest.js";
import {
  createArcRuntimePaths,
  type ArcRuntimePaths,
} from "../src/arc-runtime/paths.js";
import type { ArcRuntimeRelease } from "../src/arc-runtime/releases.js";

const PLATFORM = "darwin-arm64";
const CREATED_BY = "0.43.1";
const CLAUDE_FAKE_BINARY = '#!/bin/sh\necho "2.1.276 (Claude Code)"\n';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arc-agent-actions-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface Fixture {
  userDataPath: string;
  seedRoot: string;
  paths: ArcRuntimePaths;
  releases: Record<"codex" | "omp", ArcRuntimeRelease>;
  args: ArcAgentManagerArgs;
}

async function writeSeed(
  seedRoot: string,
  runtimeId: "codex" | "omp",
  version: string,
  probeOutput: string,
): Promise<string> {
  const seedPath = join(seedRoot, runtimeId, version, runtimeId);
  await mkdir(dirname(seedPath), { recursive: true });
  await writeFile(seedPath, `#!/bin/sh\necho "${probeOutput}"\n`, "utf8");
  await chmod(seedPath, 0o755);
  return seedPath;
}

function fakeRelease(
  runtimeId: "codex" | "omp",
  version: string,
  seedPath: string,
): Promise<ArcRuntimeRelease> {
  return sha256File(seedPath).then((digest) => ({
    runtimeId,
    artifactKind: "executable",
    version,
    platform: PLATFORM,
    releaseTag: `v${version}`,
    assetName: `${runtimeId}-darwin-arm64`,
    downloadUrl: `https://github.com/${
      runtimeId === "codex" ? "openai/codex" : "can1357/oh-my-pi"
    }/releases/download/v${version}/${runtimeId}-darwin-arm64`,
    sha256: digest,
    executableSha256: digest,
    expectedExecutableVersion: version,
    license: "MIT",
  }));
}

function fakeClaudeRelease(): ArcRuntimeRelease {
  const digest = createHash("sha256")
    .update(CLAUDE_FAKE_BINARY, "utf8")
    .digest("hex");
  return {
    runtimeId: "claude-code",
    artifactKind: "direct-official",
    version: "2.1.276",
    platform: PLATFORM,
    releaseTag: "v2.1.276",
    assetName: "claude",
    downloadUrl:
      "https://downloads.claude.ai/claude-code-releases/2.1.276/darwin-arm64/claude",
    sha256: digest,
    executableSha256: digest,
    expectedExecutableVersion: "2.1.276",
    license: "Anthropic Commercial Terms",
  };
}

async function makeFixture(): Promise<Fixture> {
  const root = await tempDir();
  const userDataPath = join(root, "userData");
  const seedRoot = join(root, "seed");
  const paths = createArcRuntimePaths({ userDataPath });

  const codexVersion = "0.155.1";
  const ompVersion = "18.2.6";
  const codexSeed = await writeSeed(
    seedRoot,
    "codex",
    codexVersion,
    `codex-cli ${codexVersion}`,
  );
  const ompSeed = await writeSeed(
    seedRoot,
    "omp",
    ompVersion,
    `omp/${ompVersion}`,
  );
  const releases = {
    codex: await fakeRelease("codex", codexVersion, codexSeed),
    omp: await fakeRelease("omp", ompVersion, ompSeed),
  };
  const args: ArcAgentManagerArgs = {
    createdByArcVersion: CREATED_BY,
    platform: PLATFORM,
    releases,
    runtimePaths: paths,
    seedRoot,
  };
  return { userDataPath, seedRoot, paths, releases, args };
}

function claudeSeams() {
  return {
    download: async (_url: string, destinationPath: string) => {
      await mkdir(dirname(destinationPath), { recursive: true });
      await writeFile(destinationPath, CLAUDE_FAKE_BINARY, "utf8");
    },
    runDoctor: async () => "No installation issues found",
    verifyCodeSignature: async () => true,
  };
}

function claudeArgs(fixture: Fixture) {
  return {
    ...fixture.args,
    ...claudeSeams(),
    releases: {
      ...fixture.args.releases,
      "claude-code": fakeClaudeRelease(),
    },
  };
}

async function readManifest(paths: ArcRuntimePaths) {
  const result = await readArcRuntimeManifest({
    createdByArcVersion: CREATED_BY,
    manifestPath: paths.manifestPath,
    platform: PLATFORM,
  });
  if (result.kind !== "ok" && result.kind !== "missing") {
    throw new Error(`expected a readable manifest, got ${result.kind}`);
  }
  return result.manifest;
}

describe("ArcAgentManager — prepare", () => {
  it("prepares Codex from the bundled seed and returns refreshed ready status", async () => {
    const fixture = await makeFixture();
    const manager = new ArcAgentManager(fixture.args);

    const status = await manager.prepareAgent("codex");
    expect(status.runtime.state).toBe("ready");
    expect(status.runtime.version).toBe("0.155.1");
    expect(status.runtime.source).toBe("arc-bundled");
    expect(status.overallState).toBe("runtime-ready");
  });

  it("prepares OMP from the bundled seed", async () => {
    const fixture = await makeFixture();
    const manager = new ArcAgentManager(fixture.args);

    const status = await manager.prepareAgent("omp");
    expect(status.runtime.state).toBe("ready");
    expect(status.runtime.version).toBe("18.2.6");
  });

  it("prepares Claude Code through the official setup flow with mocked network", async () => {
    const fixture = await makeFixture();
    const manager = new ArcAgentManager(claudeArgs(fixture));

    const status = await manager.prepareAgent("claude-code");
    expect(status.runtime.state).toBe("ready");
    expect(status.runtime.version).toBe("2.1.276");
    expect(status.runtime.source).toBe("official-managed-install");
  });

  it("prepare is idempotent: a second call reuses the healthy runtime", async () => {
    const fixture = await makeFixture();
    const manager = new ArcAgentManager(fixture.args);

    await manager.prepareAgent("codex");
    const manifestAfterFirst = await readManifest(fixture.paths)
    const second = await manager.prepareAgent("codex");
    const manifestAfterSecond = await readManifest(fixture.paths)

    expect(second.runtime.state).toBe("ready");
    expect(
      manifestAfterSecond.runtimes.codex.installedAt,
    ).toBe(manifestAfterFirst.runtimes.codex.installedAt);
  });

  it("concurrent prepares of different agents cannot lose each other's manifest update", async () => {
    const fixture = await makeFixture();
    const manager = new ArcAgentManager(claudeArgs(fixture));

    const [codex, claude] = await Promise.all([
      manager.prepareAgent("codex"),
      manager.prepareAgent("claude-code"),
    ]);
    expect(codex.runtime.state).toBe("ready");
    expect(claude.runtime.state).toBe("ready");

    const manifest = await readManifest(fixture.paths)
    expect(manifest.runtimes.codex.activeVersion).toBe("0.155.1");
    expect(manifest.runtimes["claude-code"].activeVersion).toBe(
      "2.1.276",
    );
  });

  it("duplicate concurrent prepares of the same agent run a single operation", async () => {
    const fixture = await makeFixture();
    let downloadCount = 0;
    let signalDownloadStarted!: () => void;
    let releaseDownload!: () => void;
    const downloadStarted = new Promise<void>((resolvePromise) => {
      signalDownloadStarted = resolvePromise;
    });
    const downloadGate = new Promise<void>((resolvePromise) => {
      releaseDownload = resolvePromise;
    });
    const manager = new ArcAgentManager({
      ...claudeArgs(fixture),
      download: async (_url: string, destinationPath: string) => {
        downloadCount += 1;
        signalDownloadStarted();
        await downloadGate;
        await mkdir(dirname(destinationPath), { recursive: true });
        await writeFile(destinationPath, CLAUDE_FAKE_BINARY, "utf8");
      },
    });

    const first = manager.prepareAgent("claude-code");
    await downloadStarted;
    const second = manager.prepareAgent("claude-code");
    releaseDownload();

    const [firstStatus, secondStatus] = await Promise.all([first, second]);
    expect(downloadCount).toBe(1);
    expect(firstStatus.runtime.state).toBe("ready");
    expect(secondStatus.runtime.state).toBe("ready");
  });

  it("fails with a typed error when the bundled seed is missing", async () => {
    const fixture = await makeFixture();
    const emptySeedRoot = join(await tempDir(), "no-seeds");
    const manager = new ArcAgentManager({
      ...fixture.args,
      seedRoot: emptySeedRoot,
    });

    const failure = await manager.prepareAgent("codex").catch((error) => error);
    expect(failure).toBeInstanceOf(ArcAgentError);
    expect(failure.code).toBe("runtime-prepare-failed");
    expect(failure.detail).toContain("seed");
  });
});

describe("ArcAgentManager — repair", () => {
  it("repairs a broken Codex runtime from the trusted seed without changing the version", async () => {
    const fixture = await makeFixture();
    const manager = new ArcAgentManager(fixture.args);
    await manager.prepareAgent("codex");

    await rm(
      fixture.paths.executablePath("codex", "0.155.1"),
      { force: true },
    );
    expect((await manager.getArcAgent("codex")).runtime.state).toBe("broken");

    const repaired = await manager.repairAgent("codex");
    expect(repaired.runtime.state).toBe("ready");
    expect(repaired.runtime.version).toBe("0.155.1");
  });

  it("repairs a broken OMP runtime", async () => {
    const fixture = await makeFixture();
    const manager = new ArcAgentManager(fixture.args);
    await manager.prepareAgent("omp");

    await rm(fixture.paths.executablePath("omp", "18.2.6"), { force: true });
    const repaired = await manager.repairAgent("omp");
    expect(repaired.runtime.state).toBe("ready");
    expect(repaired.runtime.version).toBe("18.2.6");
  });

  it("repairs a broken Claude runtime of the pinned version through the official flow", async () => {
    const fixture = await makeFixture();
    const manager = new ArcAgentManager(claudeArgs(fixture));
    await manager.prepareAgent("claude-code");

    await rm(
      fixture.paths.executablePath("claude-code", "2.1.276"),
      { force: true },
    );
    expect((await manager.getArcAgent("claude-code")).runtime.state).toBe(
      "broken",
    );

    const repaired = await manager.repairAgent("claude-code");
    expect(repaired.runtime.state).toBe("ready");
    expect(repaired.runtime.version).toBe("2.1.276");
  });

  it("repair on a healthy runtime is a safe no-op that never changes the version", async () => {
    const fixture = await makeFixture();
    const manager = new ArcAgentManager(fixture.args);
    await manager.prepareAgent("codex");

    const repaired = await manager.repairAgent("codex");
    expect(repaired.runtime.state).toBe("ready");
    expect(repaired.runtime.version).toBe("0.155.1");
  });

  it("repair on a not-prepared agent fails with a typed error pointing to prepare", async () => {
    const fixture = await makeFixture();
    const manager = new ArcAgentManager(fixture.args);

    const failure = await manager.repairAgent("codex").catch((error) => error);
    expect(failure).toBeInstanceOf(ArcAgentError);
    expect(failure.code).toBe("runtime-repair-failed");
    expect(failure.detail).toContain("prepare");
  });

  it("duplicate concurrent repairs of the same agent run a single operation", async () => {
    const fixture = await makeFixture();
    const manager = new ArcAgentManager(fixture.args);
    await manager.prepareAgent("codex");
    await rm(
      fixture.paths.executablePath("codex", "0.155.1"),
      { force: true },
    );

    const [first, second] = await Promise.all([
      manager.repairAgent("codex"),
      manager.repairAgent("codex"),
    ]);
    expect(first.runtime.state).toBe("ready");
    expect(second.runtime.state).toBe("ready");

    const manifest = await readManifest(fixture.paths)
    expect(manifest.runtimes.codex.activeVersion).toBe("0.155.1");
    expect(manifest.runtimes.codex.installedAt).not.toBeNull();
  });

  it("repair never upgrades: a valid newer active version is kept, not replaced", async () => {
    const fixture = await makeFixture();
    const manager = new ArcAgentManager(fixture.args);
    const manifest = createEmptyArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      platform: PLATFORM,
    });
    manifest.runtimes.codex = {
      activeVersion: "0.156.0",
      previousVersion: null,
      knownGoodVersion: "0.156.0",
      source: "arc-managed-download",
      digest: "0".repeat(64),
      componentsByVersion: {},
      installedAt: 1,
    };
    await writeArcRuntimeManifest({
      manifest,
      manifestPath: fixture.paths.manifestPath,
    });
    const newerPath = fixture.paths.executablePath("codex", "0.156.0");
    await mkdir(dirname(newerPath), { recursive: true });
    await writeFile(
      newerPath,
      '#!/bin/sh\necho "codex-cli 0.156.0"\n',
      "utf8",
    );
    await chmod(newerPath, 0o755);

    const repaired = await manager.repairAgent("codex");
    expect(repaired.runtime.state).toBe("ready-with-warning");
    expect(repaired.runtime.version).toBe("0.156.0");
  });
});
