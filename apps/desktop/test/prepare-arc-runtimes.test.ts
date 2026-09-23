import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256File } from "@bb/arc-domains/arc-runtime/digest.js";
import { ARC_CODEX_RELEASE } from "@bb/arc-domains/arc-runtime/releases.js";

/**
 * The build-side half of the Code Mode guarantee, driven through the real
 * build script as a subprocess: a release build fetches the helper from the
 * same pinned release as the binary it belongs to, verifies both digests, and
 * publishes them as siblings — and a seed that holds only the binary is
 * rebuilt rather than shipped as complete.
 *
 * The cases run against the real pinned release and the real asset cache, so
 * they exercise the actual archive extraction, the actual `--version` probe and
 * the actual digest checks. They are skipped when the cached assets are absent,
 * which is the case on a machine that has never run the seed pipeline.
 */

// vitest runs with the package directory as cwd.
const desktopPackageRoot = process.cwd();
const realCacheRoot = resolve(desktopPackageRoot, ".arc-runtime-cache");
const realResourcesRoot = resolve(
  desktopPackageRoot,
  "resources",
  "arc-runtimes",
);
const scriptPath = resolve(
  desktopPackageRoot,
  "scripts",
  "prepare-arc-runtimes.mts",
);

const companion = ARC_CODEX_RELEASE.companions?.[0];
const companionFileName = companion?.fileName ?? "";
const realCodexSeedPath = join(
  realResourcesRoot,
  "codex",
  ARC_CODEX_RELEASE.version,
  "codex",
);

/**
 * Whether the asset cache is warm. Deliberately a synchronous existence check:
 * `describe.skipIf` is evaluated while the file is collected, before any
 * `beforeAll`, so the decision cannot wait on I/O. Validity is not guessed here
 * — the cases below assert the real pinned digests, so a corrupt cache fails
 * loudly instead of quietly skipping.
 */
function cachedAssetPresent(sha256: string): boolean {
  return [".tar.gz", ".bin"].some((extension) =>
    existsSync(join(realCacheRoot, `${sha256}${extension}`)),
  );
}

const assetsCached =
  companion !== undefined &&
  companionFileName.length > 0 &&
  cachedAssetPresent(ARC_CODEX_RELEASE.sha256) &&
  cachedAssetPresent(companion.sha256);

const BUILD_TIMEOUT_MS = 600_000;
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeResourcesRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "arc-seed-build-"));
  tempDirs.push(root);
  return join(root, "arc-runtimes");
}

/** Runs the real build script against a disposable resources root, sharing the
 * real asset cache so the cases stay offline. */
async function runSeedBuild(resourcesRoot: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "pnpm",
      [
        "exec",
        "tsx",
        scriptPath,
        "--cache",
        realCacheRoot,
        "--resources",
        resourcesRoot,
      ],
      { cwd: desktopPackageRoot, timeout: BUILD_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error === null) resolvePromise(stdout);
        else rejectPromise(new Error(`${stdout}\n${stderr}`));
      },
    );
  });
}

describe.skipIf(!assetsCached)(
  "release build stages the pinned Codex and its Code Mode host together",
  () => {
    it(
      "builds a complete seed from nothing, verifying both digests",
      async () => {
        const resourcesRoot = await makeResourcesRoot();
        const versionDir = join(
          resourcesRoot,
          "codex",
          ARC_CODEX_RELEASE.version,
        );
        expect(existsSync(versionDir)).toBe(false);

        await runSeedBuild(resourcesRoot);

        // Exactly the two artifacts and nothing else: the binary under the name
        // Arc launches, and the helper under the name Codex looks for beside it.
        expect((await readdir(versionDir)).sort()).toEqual(
          ["codex", companionFileName].sort(),
        );
        expect(await sha256File(join(versionDir, "codex"))).toBe(
          ARC_CODEX_RELEASE.executableSha256,
        );
        expect(await sha256File(join(versionDir, companionFileName))).toBe(
          companion?.executableSha256,
        );
      },
      BUILD_TIMEOUT_MS,
    );

    it(
      "rebuilds a seed that has only the binary, adding the helper",
      async () => {
        const resourcesRoot = await makeResourcesRoot();
        const versionDir = join(
          resourcesRoot,
          "codex",
          ARC_CODEX_RELEASE.version,
        );
        await mkdir(versionDir, { recursive: true });
        // The exact state that used to ship: the binary is staged and
        // verified, and the helper was never fetched.
        await link(realCodexSeedPath, join(versionDir, "codex"));

        const log = await runSeedBuild(resourcesRoot);

        expect(log).toContain(companionFileName);
        expect(await sha256File(join(versionDir, companionFileName))).toBe(
          companion?.executableSha256,
        );
      },
      BUILD_TIMEOUT_MS,
    );

    it(
      "leaves a complete seed untouched on a second build",
      async () => {
        const resourcesRoot = await makeResourcesRoot();
        const versionDir = join(
          resourcesRoot,
          "codex",
          ARC_CODEX_RELEASE.version,
        );
        await runSeedBuild(resourcesRoot);
        const before = await readdir(versionDir);

        const log = await runSeedBuild(resourcesRoot);

        expect(log).toContain("already staged and verified");
        expect((await readdir(versionDir)).sort()).toEqual([...before].sort());
      },
      BUILD_TIMEOUT_MS,
    );
  },
);
