import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArcAgentManager,
  type ArcAgentManagerArgs,
} from "../src/arc-agent/manager.js";
import { sha256File } from "../src/arc-runtime/digest.js";
import {
  createArcRuntimePaths,
  type ArcRuntimePaths,
} from "../src/arc-runtime/paths.js";
import type { ArcRuntimeRelease } from "../src/arc-runtime/releases.js";

// Phase 14: update discovery is the one read-shaped Arc path that spends real
// external requests (api.github.com / downloads.claude.ai). Repeated checks
// reuse one discovery for a bounded window, concurrent checks share one call,
// and the update that changes the answer invalidates it.

const PLATFORM = "darwin-arm64";
const CREATED_BY = "0.43.1";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arc-update-discovery-test-"));
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

async function writeSeed(seedRoot: string, version: string): Promise<string> {
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
  nextSeed: string;
}

async function makeFixture(): Promise<Fixture> {
  const root = await tempDir();
  const seedRoot = join(root, "seed");
  const paths = createArcRuntimePaths({ userDataPath: join(root, "userData") });
  const ompSeed = await writeSeed(seedRoot, "18.2.6");
  return {
    paths,
    nextSeed: await writeSeed(await tempDir(), "18.3.0"),
    args: {
      createdByArcVersion: CREATED_BY,
      platform: PLATFORM,
      releases: { omp: await fakeRelease("18.2.6", ompSeed) },
      runtimePaths: paths,
      seedRoot,
    },
  };
}

function makeManager(
  fixture: Fixture,
  fetchLatestRelease: () => Promise<ArcRuntimeRelease | null>,
): { manager: ArcAgentManager; calls: () => number } {
  let calls = 0;
  const manager = new ArcAgentManager({
    ...fixture.args,
    fetchLatestRelease: async () => {
      calls += 1;
      return fetchLatestRelease();
    },
  });
  return { manager, calls: () => calls };
}

describe("ArcAgentManager update discovery cache", () => {
  it("reuses one discovery for repeated checks inside the window", async () => {
    const fixture = await makeFixture();
    const { manager, calls } = makeManager(fixture, () =>
      fakeRelease("18.3.0", fixture.nextSeed),
    );
    await manager.prepareAgent("omp");

    const first = await manager.checkForUpdate("omp");
    const second = await manager.checkForUpdate("omp");

    expect(calls()).toBe(1);
    expect(first.latestTrusted?.version).toBe("18.3.0");
    expect(second.latestTrusted?.version).toBe("18.3.0");
  });

  it("shares one discovery across concurrent checks", async () => {
    const fixture = await makeFixture();
    const { manager, calls } = makeManager(fixture, () =>
      fakeRelease("18.3.0", fixture.nextSeed),
    );
    await manager.prepareAgent("omp");

    const discoveries = await Promise.all([
      manager.checkForUpdate("omp"),
      manager.checkForUpdate("omp"),
      manager.checkForUpdate("omp"),
    ]);

    expect(calls()).toBe(1);
    expect(discoveries.map((entry) => entry.latestTrusted?.version)).toEqual([
      "18.3.0",
      "18.3.0",
      "18.3.0",
    ]);
  });

  it("re-checks after the window has passed", async () => {
    const fixture = await makeFixture();
    let now = 1_800_000_000_000;
    let calls = 0;
    const manager = new ArcAgentManager({
      ...fixture.args,
      now: () => now,
      fetchLatestRelease: async () => {
        calls += 1;
        return fakeRelease("18.3.0", fixture.nextSeed);
      },
    });
    await manager.prepareAgent("omp");

    await manager.checkForUpdate("omp");
    now += 10 * 60 * 1_000;
    await manager.checkForUpdate("omp");

    expect(calls).toBe(2);
  });

  it("invalidates the cached discovery once the runtime is updated", async () => {
    const fixture = await makeFixture();
    let callCount = 0;
    const manager = new ArcAgentManager({
      ...fixture.args,
      fetchLatestRelease: async () => {
        callCount += 1;
        return fakeRelease("18.3.0", fixture.nextSeed);
      },
      download: async (_url, destinationPath) => {
        await mkdir(dirname(destinationPath), { recursive: true });
        await writeFile(destinationPath, ompScript("18.3.0"), "utf8");
      },
    });
    await manager.prepareAgent("omp");

    await manager.checkForUpdate("omp");
    expect(callCount).toBe(1);

    const { outcome } = await manager.updateAgent("omp");
    expect(outcome.kind).toBe("updated");
    // The update performs its own discovery while it runs; what matters here
    // is that it did not leave a reusable cached answer behind.
    const callsAfterUpdate = callCount;

    // The runtime changed, so the previous "latest release" answer is no
    // longer the answer: the next check asks again.
    await manager.checkForUpdate("omp");
    expect(callCount).toBe(callsAfterUpdate + 1);
  });
});
