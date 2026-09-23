import { createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { sha256File } from "@bb/arc-domains/arc-runtime/digest.js";
import { resolveArcPlatformIdentity } from "@bb/arc-domains/arc-runtime/manifest.js";
import { arcRuntimeExecutableName } from "@bb/arc-domains/arc-runtime/paths.js";
import { stageReleaseExecutable } from "@bb/arc-domains/arc-runtime/acquire.js";
import {
  arcRuntimeSeedFileDigests,
  arcRuntimeSeedFileNames,
  arcRuntimeSeedVersionDir,
  planArcRuntimeSeedBuild,
} from "@bb/arc-domains/arc-runtime/seed-plan.js";
import {
  ARC_RUNTIME_RELEASES,
  validateArcRuntimeRelease,
  type ArcRuntimeRelease,
} from "@bb/arc-domains/arc-runtime/releases.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopPackageRoot = resolve(scriptDirectory, "..");

/**
 * Where the seed pipeline reads and writes. Injectable so a test can drive a
 * complete build against a temporary tree — the checkout's own resources
 * directory holds the real multi-hundred-megabyte artifacts and must never be
 * a test's scratch space.
 */
export interface ArcRuntimeSeedRoots {
  /** Downloaded release assets, keyed by their own sha256. */
  readonly cacheRoot: string;
  /** The staged seed tree that `electron-builder` copies into the app. */
  readonly stagedResourcesRoot: string;
}

const defaultSeedRoots: ArcRuntimeSeedRoots = {
  cacheRoot: resolve(desktopPackageRoot, ".arc-runtime-cache"),
  stagedResourcesRoot: resolve(
    desktopPackageRoot,
    "resources",
    "arc-runtimes",
  ),
};
const noticesSources = [
  resolve(desktopPackageRoot, "third-party-notices", "codex.md"),
  resolve(desktopPackageRoot, "third-party-notices", "omp.md"),
];

const DOWNLOAD_TIMEOUT_MS = 600_000;

function log(message: string): void {
  console.log(`[arc-runtimes] ${message}`);
}

/**
 * Everything the cache needs to key, download and verify an artifact. Both a
 * runtime executable and a companion satisfy this structurally, so a helper is
 * fetched, cached and digest-checked by the same code path as the binary it
 * belongs to — never by a second, weaker one.
 */
interface CachedArtifact {
  readonly artifactKind: ArcRuntimeRelease["artifactKind"];
  readonly assetName: string;
  readonly downloadUrl: string;
  readonly sha256: string;
}

function cacheExtensionFor(artifact: CachedArtifact): string {
  return artifact.artifactKind === "archive" ? ".tar.gz" : ".bin";
}

async function downloadToFile(
  url: string,
  destinationPath: string,
): Promise<void> {
  log(`downloading ${url}`);
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || response.body === null) {
    throw new Error(`download failed with HTTP ${response.status}`);
  }
  const temporaryPath = `${destinationPath}.tmp-${process.pid}`;
  const { promise, resolve: resolvePromise, reject: rejectPromise } =
    Promise.withResolvers<void>();
  const stream = Readable.fromWeb(
    response.body as Parameters<typeof Readable.fromWeb>[0],
  );
  const file = createWriteStream(temporaryPath, { flags: "wx" });
  stream.pipe(file);
  file.on("finish", () => {
    resolvePromise();
  });
  file.on("error", rejectPromise);
  stream.on("error", rejectPromise);
  await promise;
  await rename(temporaryPath, destinationPath);
}

async function ensureCachedAsset(
  artifact: CachedArtifact,
  roots: ArcRuntimeSeedRoots,
): Promise<string> {
  await mkdir(roots.cacheRoot, { recursive: true });
  const assetPath = join(
    roots.cacheRoot,
    `${artifact.sha256}${cacheExtensionFor(artifact)}`,
  );
  const cachedDigest = await sha256File(assetPath).catch(() => null);
  if (cachedDigest === artifact.sha256) {
    log(`using cached asset ${assetPath}`);
    return assetPath;
  }
  await downloadToFile(artifact.downloadUrl, assetPath);
  const digest = await sha256File(assetPath);
  if (digest !== artifact.sha256) {
    await rm(assetPath, { force: true });
    throw new Error(
      `digest mismatch for ${artifact.assetName}: expected ${artifact.sha256}, got ${digest}`,
    );
  }
  log(`asset digest verified: ${digest}`);
  return assetPath;
}

async function publishSeedFile(args: {
  release: ArcRuntimeRelease;
  stagedPath: string;
  fileName: string;
  roots: ArcRuntimeSeedRoots;
}): Promise<string> {
  const versionDir = arcRuntimeSeedVersionDir({
    release: args.release,
    stagedResourcesRoot: args.roots.stagedResourcesRoot,
  });
  await mkdir(versionDir, { recursive: true });
  const finalPath = join(versionDir, args.fileName);
  const temporaryPath = `${finalPath}.tmp-${process.pid}`;
  await rm(temporaryPath, { force: true });
  await copyFile(args.stagedPath, temporaryPath);
  await chmod(temporaryPath, 0o755);
  await rename(temporaryPath, finalPath);
  return finalPath;
}

async function copyNotices(roots: ArcRuntimeSeedRoots): Promise<void> {
  const sections: string[] = [];
  for (const sourcePath of noticesSources) {
    const notices = await readFile(sourcePath, "utf8").catch(() => null);
    if (notices === null) {
      throw new Error(`missing third-party notices source: ${sourcePath}`);
    }
    sections.push(notices.trimEnd());
  }
  await mkdir(roots.stagedResourcesRoot, { recursive: true });
  await writeFile(
    join(roots.stagedResourcesRoot, "THIRD_PARTY_NOTICES.md"),
    `${sections.join("\n\n---\n\n")}\n`,
    "utf8",
  );
}

export async function prepareRelease(
  release: ArcRuntimeRelease,
  roots: ArcRuntimeSeedRoots = defaultSeedRoots,
): Promise<void> {
  const validation = validateArcRuntimeRelease(release);
  if (validation.kind === "invalid") {
    throw new Error(`invalid release metadata: ${validation.problem}`);
  }

  const currentPlatform = resolveArcPlatformIdentity({
    arch: process.arch,
    platform: process.platform,
  });
  if (release.platform !== currentPlatform) {
    log(
      `skipping ${release.runtimeId} ${release.version}: pinned for ${release.platform}, building on ${currentPlatform}`,
    );
    return;
  }

  // The skip decision covers every file the seed directory must contain, not
  // just the executable: a checkout whose `codex` is staged but whose
  // `codex-code-mode-host` is missing — or is a leftover from a different
  // release — must be rebuilt, never silently shipped as a complete seed.
  const versionDir = arcRuntimeSeedVersionDir({ release, stagedResourcesRoot: roots.stagedResourcesRoot });
  const seedDigests: Record<string, string | null> = {};
  for (const expected of arcRuntimeSeedFileDigests(release)) {
    seedDigests[expected.fileName] = await sha256File(
      join(versionDir, expected.fileName),
    ).catch(() => null);
  }
  const plan = planArcRuntimeSeedBuild({ release, seedDigests });
  if (plan.kind === "complete") {
    log(
      `seed for ${release.runtimeId} ${release.version} already staged and verified (${arcRuntimeSeedFileNames(release).join(", ")}); skipping`,
    );
    return;
  }
  log(
    `seed for ${release.runtimeId} ${release.version} needs rebuilding: ${plan.missing.join(", ")}`,
  );

  const assetPath = await ensureCachedAsset(release, roots);
  const companionAssetPaths: Record<string, string> = {};
  for (const companion of release.companions ?? []) {
    companionAssetPaths[companion.fileName] = await ensureCachedAsset(
      companion,
      roots,
    );
  }

  const stagingDir = await mkdtemp(
    join(roots.cacheRoot, `stage-${release.runtimeId}-`),
  );
  try {
    const staged = await stageReleaseExecutable({
      assetPath,
      release,
      stagingDir,
      companionAssetPaths,
    });
    if (staged.kind === "rejected") {
      throw new Error(staged.reason);
    }
    const finalPath = await publishSeedFile({
      release,
      stagedPath: staged.executablePath,
      fileName: arcRuntimeExecutableName(release.runtimeId),
      roots,
    });
    const publishedCompanions: string[] = [];
    for (const companion of release.companions ?? []) {
      // `stageReleaseExecutable` refuses to return `ok` unless every declared
      // companion was staged and matched its digest, so reaching here means
      // each one is present in the staging directory under its own name.
      const companionPath = await publishSeedFile({
        release,
        stagedPath: join(stagingDir, companion.fileName),
        fileName: companion.fileName,
        roots,
      });
      publishedCompanions.push(companionPath);
    }
    log(
      `staged verified seed at ${finalPath} (version ${staged.version}, digest ${staged.digest}) with ${publishedCompanions.length} companion(s): ${publishedCompanions.join(", ")}`,
    );
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

/**
 * `--cache <dir>` and `--resources <dir>` override where the pipeline reads
 * downloaded assets and writes the seed tree. Defaults are the desktop
 * package's own directories; the arguments exist so a build or a test can
 * stage a complete seed somewhere disposable instead of over the checkout's
 * real artifacts.
 */
export function parseSeedRoots(argv: readonly string[]): ArcRuntimeSeedRoots {
  const roots: { cacheRoot?: string; stagedResourcesRoot?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--cache" && value !== undefined) {
      roots.cacheRoot = resolve(value);
      index += 1;
    } else if (flag === "--resources" && value !== undefined) {
      roots.stagedResourcesRoot = resolve(value);
      index += 1;
    } else if (flag !== undefined && flag.startsWith("--")) {
      throw new Error(`unknown argument ${flag}`);
    }
  }
  return {
    cacheRoot: roots.cacheRoot ?? defaultSeedRoots.cacheRoot,
    stagedResourcesRoot:
      roots.stagedResourcesRoot ?? defaultSeedRoots.stagedResourcesRoot,
  };
}

export async function main(
  roots: ArcRuntimeSeedRoots = defaultSeedRoots,
): Promise<void> {
  await mkdir(roots.stagedResourcesRoot, { recursive: true });
  await copyNotices(roots);
  for (const release of ARC_RUNTIME_RELEASES) {
    await prepareRelease(release, roots);
  }
  log("done");
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && import.meta.url === `file://${invokedPath}`) {
  await main(parseSeedRoots(process.argv.slice(2))).catch((error: unknown) => {
    console.error(
      `[arc-runtimes] FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}

