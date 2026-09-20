import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArcAgentManager,
  type ArcAgentManagerArgs,
} from "../src/arc-agent/manager.js";
import { activateArcRuntimeVersion } from "../src/arc-runtime/activation.js";
import { sha256File } from "../src/arc-runtime/digest.js";
import { readArcRuntimeManifest } from "../src/arc-runtime/manifest.js";
import {
  createArcRuntimePaths,
  type ArcRuntimePaths,
} from "../src/arc-runtime/paths.js";
import type { ArcRuntimeRelease } from "../src/arc-runtime/releases.js";

const PLATFORM = "darwin-arm64";
const CREATED_BY = "0.43.1";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arc-agent-updates-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function ompScript(version: string): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo omp/${version}
elif [ "$1" = "acp" ]; then
  echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
  sleep 5
else
  exit 0
fi
`;
}

async function writeSeed(
  seedRoot: string,
  version: string,
): Promise<string> {
  const seedPath = join(seedRoot, "omp", version, "omp");
  await mkdir(dirname(seedPath), { recursive: true });
  await writeFile(seedPath, ompScript(version), "utf8");
  await chmod(seedPath, 0o755);
  return seedPath;
}

async function fakeRelease(
  version: string,
  seedOrDest: string,
): Promise<ArcRuntimeRelease> {
  const digest = await sha256File(seedOrDest);
  return {
    runtimeId: "omp",
    artifactKind: "executable",
    version,
    platform: PLATFORM,
    releaseTag: `v${version}`,
    assetName: "omp-darwin-arm64",
    downloadUrl: `https://github.com/can1357/oh-my-pi/releases/download/v${version}/omp-darwin-arm64`,
    sha256: digest,
    executableSha256: digest,
    expectedExecutableVersion: version,
    license: "MIT",
  };
}

interface Fixture {
  paths: ArcRuntimePaths;
  args: ArcAgentManagerArgs;
}

async function makeFixture(): Promise<Fixture> {
  const root = await tempDir();
  const userDataPath = join(root, "userData");
  const seedRoot = join(root, "seed");
  const paths = createArcRuntimePaths({ userDataPath });
  const ompSeed = await writeSeed(seedRoot, "18.2.6");
  const args: ArcAgentManagerArgs = {
    createdByArcVersion: CREATED_BY,
    platform: PLATFORM,
    releases: { omp: await fakeRelease("18.2.6", ompSeed) },
    runtimePaths: paths,
    seedRoot,
  };
  return { paths, args };
}

describe("ArcAgentManager.checkForUpdate", () => {
  it("is side-effect-free and reports a compatible newer version as available", async () => {
    const fixture = await makeFixture();
    const newSeed = await writeSeed(await tempDir(), "18.3.0");
    const manager = new ArcAgentManager({
      ...fixture.args,
      fetchLatestRelease: async () => fakeRelease("18.3.0", newSeed),
    });
    await manager.prepareAgent("omp");

    const discovery = await manager.checkForUpdate("omp");

    expect(discovery.activeVersion).toBe("18.2.6");
    expect(discovery.latestTrusted?.version).toBe("18.3.0");
  });
});

describe("ArcAgentManager.updateAgent", () => {
  it("updates omp to a discovered newer version and promotes it to known-good", async () => {
    const fixture = await makeFixture();
    const newSeed = await writeSeed(join((await tempDir())), "18.3.0");
    const manager = new ArcAgentManager({
      ...fixture.args,
      fetchLatestRelease: async () => fakeRelease("18.3.0", newSeed),
      download: async (_url, destinationPath) => {
        await mkdir(dirname(destinationPath), { recursive: true });
        await writeFile(
          destinationPath,
          ompScript("18.3.0"),
          "utf8",
        );
      },
    });
    await manager.prepareAgent("omp");

    const { outcome, agent } = await manager.updateAgent("omp");

    expect(outcome.kind).toBe("updated");
    expect(agent.runtime.version).toBe("18.3.0");
    expect(agent.runtime.knownGoodVersion).toBe("18.3.0");
    const manifest = await readArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath: fixture.paths.manifestPath,
      platform: PLATFORM,
    });
    if (manifest.kind !== "ok") throw new Error("expected ok");
    expect(manifest.manifest.runtimes.omp.previousVersion).toBe("18.2.6");
  });

  it("does not leave rollback available after a fully successful, promoted update", async () => {
    const fixture = await makeFixture();
    const manager = new ArcAgentManager(fixture.args);
    const prepared = await manager.prepareAgent("omp");
    const prepareRollback = prepared.actions.find((a) => a.id === "rollback");
    expect(prepareRollback?.available).toBe(false);

    const newSeed = await writeSeed(await tempDir(), "18.3.0");
    const updater = new ArcAgentManager({
      ...fixture.args,
      fetchLatestRelease: async () => fakeRelease("18.3.0", newSeed),
      download: async (_url, destinationPath) => {
        await mkdir(dirname(destinationPath), { recursive: true });
        await writeFile(destinationPath, ompScript("18.3.0"), "utf8");
      },
    });
    const { outcome, agent } = await updater.updateAgent("omp");

    // A promoted update makes the new version the known-good version too —
    // rollback is for the gap between activation and promotion (or a
    // promotion that never completed), not "go back to the prior version".
    expect(outcome.kind).toBe("updated");
    expect(agent.runtime.knownGoodVersion).toBe(agent.runtime.version);
    const rollback = agent.actions.find((a) => a.id === "rollback");
    expect(rollback?.available).toBe(false);
  });
});

describe("ArcAgentManager.rollbackAgent", () => {
  it("reactivates the known-good version without redownloading, from an activated-but-not-yet-promoted state", async () => {
    const fixture = await makeFixture();
    const manager = new ArcAgentManager(fixture.args);
    await manager.prepareAgent("omp");
    const newVersionPath = fixture.paths.executablePath("omp", "18.3.0");
    await mkdir(dirname(newVersionPath), { recursive: true });
    await writeFile(newVersionPath, ompScript("18.3.0"), "utf8");
    await chmod(newVersionPath, 0o755);
    await activateArcRuntimeVersion({
      runtimeId: "omp",
      version: "18.3.0",
      source: "arc-managed-download",
      digest: await sha256File(newVersionPath),
      createdByArcVersion: CREATED_BY,
      platform: PLATFORM,
      runtimePaths: fixture.paths,
    });

    const { outcome, agent } = await manager.rollbackAgent("omp");

    expect(outcome.kind).toBe("rolled-back");
    expect(agent.runtime.version).toBe("18.2.6");
  });

  it("reports unavailable, not a silent no-op, when there is no rollback target", async () => {
    const fixture = await makeFixture();
    const manager = new ArcAgentManager(fixture.args);
    await manager.prepareAgent("omp");

    const { outcome, agent } = await manager.rollbackAgent("omp");

    expect(outcome.kind).toBe("unavailable");
    expect(agent.runtime.version).toBe("18.2.6");
  });
});
