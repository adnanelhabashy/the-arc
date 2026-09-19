import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArcAgentManager,
  type ArcProviderStatusSource,
} from "../src/arc-agent/manager.js";
import type { ArcAgentStatus } from "../src/arc-agent/types.js";
import {
  readArcRuntimeManifest,
  writeArcRuntimeManifest,
  type ArcRuntimeManifest,
} from "../src/arc-runtime/manifest.js";
import {
  createArcRuntimePaths,
  type ArcRuntimePaths,
} from "../src/arc-runtime/paths.js";
import type { ArcRuntimeId } from "../src/arc-runtime/types.js";

const PLATFORM = "darwin-arm64";
const CREATED_BY = "0.43.1";

const PINNED_VERSIONS: Record<ArcRuntimeId, string> = {
  codex: "0.155.1",
  omp: "18.2.6",
  "claude-code": "2.1.276",
};

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arc-agent-status-test-"));
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
  paths: ArcRuntimePaths;
  manager: ArcAgentManager;
}

async function makeFixture(): Promise<Fixture> {
  const root = await tempDir();
  const userDataPath = join(root, "userData");
  const paths = createArcRuntimePaths({ userDataPath });
  const manager = new ArcAgentManager({
    createdByArcVersion: CREATED_BY,
    platform: PLATFORM,
    runtimePaths: paths,
  });
  return { userDataPath, paths, manager };
}

async function writeRunnableExecutable(path: string, probeOutput: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\necho "${probeOutput}"\n`, "utf8");
  await chmod(path, 0o755);
}

async function activateRuntime(
  fixture: Fixture,
  runtimeId: ArcRuntimeId,
  version: string,
  options: { executable?: boolean; probeOutput?: string } = {},
): Promise<void> {
  const manifest = await readManifest(fixture.paths);
  manifest.runtimes[runtimeId] = {
    activeVersion: version,
    previousVersion: null,
    source:
      runtimeId === "claude-code" ? "official-managed-install" : "arc-bundled",
    digest: "0".repeat(64),
    installedAt: 1,
  };
  await writeArcRuntimeManifest({
    manifest,
    manifestPath: fixture.paths.manifestPath,
  });
  if (options.executable !== false) {
    await writeRunnableExecutable(
      fixture.paths.executablePath(runtimeId, version),
      options.probeOutput ?? `${runtimeId} ${version}`,
    );
  }
}

async function readManifest(paths: ArcRuntimePaths): Promise<ArcRuntimeManifest> {
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

function actionStatus(status: ArcAgentStatus, actionId: string) {
  const action = status.actions.find((entry) => entry.id === actionId);
  expect(action).toBeDefined();
  return action!;
}

async function listUserDataTree(userDataPath: string): Promise<string[]> {
  const entries: string[] = [];
  async function walk(dir: string): Promise<void> {
    let children: string[];
    try {
      children = await readdir(dir);
    } catch {
      return;
    }
    for (const child of children) {
      const full = join(dir, child);
      entries.push(full.slice(userDataPath.length + 1));
      await walk(full);
    }
  }
  await walk(userDataPath);
  return entries.sort();
}

describe("ArcAgentManager — status", () => {
  it("reports all three agents as not-prepared on a fresh userData", async () => {
    const fixture = await makeFixture();
    const statuses = await fixture.manager.listArcAgents();

    expect(statuses.map((status) => status.id)).toEqual([
      "omp",
      "codex",
      "claude-code",
    ]);
    for (const status of statuses) {
      expect(status.runtime.state).toBe("not-prepared");
      expect(status.runtime.version).toBeNull();
      expect(status.overallState).toBe("not-prepared");
      expect(status.account.state).toBe("unknown");
      expect(status.provider.state).toBe("unknown");
      expect(actionStatus(status, "prepare").available).toBe(true);
      expect(actionStatus(status, "repair").available).toBe(false);
    }
  });

  it("reports all three agents ready with manifest versions when runtimes are healthy", async () => {
    const fixture = await makeFixture();
    for (const runtimeId of ["codex", "omp", "claude-code"] as const) {
      await activateRuntime(fixture, runtimeId, PINNED_VERSIONS[runtimeId]);
    }

    const statuses = await fixture.manager.listArcAgents();
    for (const status of statuses) {
      expect(status.runtime.state).toBe("ready");
      expect(status.runtime.version).toBe(PINNED_VERSIONS[status.runtimeId]);
      expect(status.runtime.compatibility).toBe("supported");
      expect(status.overallState).toBe("runtime-ready");
      expect(actionStatus(status, "prepare").available).toBe(false);
      expect(actionStatus(status, "repair").available).toBe(false);
    }

    const codex = statuses.find((status) => status.id === "codex")!;
    expect(codex.runtime.source).toBe("arc-bundled");
    const claude = statuses.find((status) => status.id === "claude-code")!;
    expect(claude.runtime.source).toBe("official-managed-install");
    expect(claude.providerId).toBe("claude-code");
    const omp = statuses.find((status) => status.id === "omp")!;
    expect(omp.providerId).toBe("acp-omp");
  });

  it("reports a broken runtime honestly when the manifest records an intent the filesystem does not fulfill", async () => {
    const fixture = await makeFixture();
    await activateRuntime(fixture, "omp", PINNED_VERSIONS.omp, {
      executable: false,
    });

    const status = await fixture.manager.getArcAgent("omp");
    expect(status.runtime.state).toBe("broken");
    expect(status.runtime.version).toBe(PINNED_VERSIONS.omp);
    expect(status.overallState).toBe("broken");
    expect(actionStatus(status, "repair").available).toBe(true);
    expect(actionStatus(status, "prepare").available).toBe(false);
  });

  it("maps blocked compatibility to unsupported without auto-repairing", async () => {
    const fixture = await makeFixture();
    await activateRuntime(fixture, "codex", "0.120.0");

    const status = await fixture.manager.getArcAgent("codex");
    expect(status.runtime.state).toBe("unsupported");
    expect(status.runtime.compatibility).toBe("blocked");
    expect(status.overallState).toBe("unsupported");
    expect(actionStatus(status, "repair").available).toBe(false);
    expect(actionStatus(status, "repair").reason).toContain("blocked");
  });

  it("maps untested compatibility to ready-with-warning, not silently supported", async () => {
    const fixture = await makeFixture();
    await activateRuntime(fixture, "omp", "18.3.0");

    const status = await fixture.manager.getArcAgent("omp");
    expect(status.runtime.state).toBe("ready-with-warning");
    expect(status.runtime.compatibility).toBe("untested");
    expect(status.overallState).toBe("runtime-ready");
  });

  it("marks a runtime unavailable when the manifest is corrupt, without throwing", async () => {
    const fixture = await makeFixture();
    await mkdir(dirname(fixture.paths.manifestPath), { recursive: true });
    await writeFile(fixture.paths.manifestPath, "not json", "utf8");

    const status = await fixture.manager.getArcAgent("codex");
    expect(status.runtime.state).toBe("unavailable");
    expect(status.overallState).toBe("unavailable");
    expect(status.runtime.compatibilityReason).toContain("JSON");
  });

  it("takes versions from the manifest, never from probing the binary", async () => {
    const fixture = await makeFixture();
    await activateRuntime(fixture, "codex", PINNED_VERSIONS.codex, {
      probeOutput: "codex-cli 999.999.999",
    });

    const status = await fixture.manager.getArcAgent("codex");
    expect(status.runtime.version).toBe(PINNED_VERSIONS.codex);
  });

  it("never reports unknown provider or account state as ready", async () => {
    const fixture = await makeFixture();
    await activateRuntime(fixture, "codex", PINNED_VERSIONS.codex);

    const status = await fixture.manager.getArcAgent("codex");
    expect(status.provider.state).toBe("unknown");
    expect(status.account.state).toBe("unknown");
    expect(status.overallState).toBe("runtime-ready");
    expect(status.overallState).not.toBe("ready");
  });

  it("reflects a real provider status source when one is injected", async () => {
    const fixture = await makeFixture();
    await activateRuntime(fixture, "codex", PINNED_VERSIONS.codex);
    const readySource: ArcProviderStatusSource = {
      async getProviderStatus() {
        return "ready";
      },
    };
    const manager = new ArcAgentManager({
      createdByArcVersion: CREATED_BY,
      platform: PLATFORM,
      providerStatusSource: readySource,
      runtimePaths: fixture.paths,
    });

    const status = await manager.getArcAgent("codex");
    expect(status.provider.state).toBe("ready");
  });

  it("status reads are side-effect-free: no manifest, directories, or files appear", async () => {
    const fixture = await makeFixture();
    const before = await listUserDataTree(fixture.userDataPath);

    await fixture.manager.listArcAgents();
    await fixture.manager.getArcAgent("claude-code");

    expect(await listUserDataTree(fixture.userDataPath)).toEqual(before);
    const manifestAfter = await readArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath: fixture.paths.manifestPath,
      platform: PLATFORM,
    });
    expect(manifestAfter.kind).toBe("missing");
  });

  it("stamps each status with an observation timestamp", async () => {
    const fixture = await makeFixture();
    const before = Date.now();
    const statuses = await fixture.manager.listArcAgents();
    const after = Date.now();
    for (const status of statuses) {
      expect(status.observedAt).toBeGreaterThanOrEqual(before);
      expect(status.observedAt).toBeLessThanOrEqual(after);
    }
  });

  it("reserves future actions as unavailable with an honest reason", async () => {
    const fixture = await makeFixture();
    const status = await fixture.manager.getArcAgent("codex");
    for (const actionId of ["connect-account", "update", "rollback"]) {
      const action = actionStatus(status, actionId);
      expect(action.available).toBe(false);
      expect(action.reason).toBeTruthy();
    }
  });
});

describe("ArcAgentManager — runtime states during operations", () => {
  it("exposes a preparing state while an operation is in flight", async () => {
    const fixture = await makeFixture();
    const fakeBinary = '#!/bin/sh\necho "2.1.276 (Claude Code)"\n';
    const fakeDigest = createHash("sha256").update(fakeBinary, "utf8").digest("hex");
    let observedDuringOperation: string | null = null;
    const download = async (_url: string, destinationPath: string) => {
      observedDuringOperation = (
        await manager.getArcAgent("claude-code")
      ).runtime.state;
      await mkdir(dirname(destinationPath), { recursive: true });
      await writeFile(destinationPath, fakeBinary, "utf8");
      await chmod(destinationPath, 0o755);
    };

    const manager = new ArcAgentManager({
      createdByArcVersion: CREATED_BY,
      download,
      platform: PLATFORM,
      releases: {
        "claude-code": {
          runtimeId: "claude-code",
          artifactKind: "direct-official",
          version: "2.1.276",
          platform: PLATFORM,
          releaseTag: "v2.1.276",
          assetName: "claude",
          downloadUrl:
            "https://downloads.claude.ai/claude-code-releases/2.1.276/darwin-arm64/claude",
          sha256: fakeDigest,
          executableSha256: fakeDigest,
          expectedExecutableVersion: "2.1.276",
          license: "Anthropic Commercial Terms",
        },
      },
      runDoctor: async () => "No installation issues found",
      runtimePaths: fixture.paths,
      verifyCodeSignature: async () => true,
    });

    const status = await manager.prepareAgent("claude-code");
    expect(observedDuringOperation).toBe("preparing");
    expect(status.runtime.state).toBe("ready");
    expect(status.runtime.version).toBe("2.1.276");
  });
});
