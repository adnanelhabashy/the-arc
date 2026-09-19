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
  ARC_RUNTIME_RELEASES,
  validateArcRuntimeRelease,
  type ArcRuntimeRelease,
} from "@bb/arc-domains/arc-runtime/releases.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopPackageRoot = resolve(scriptDirectory, "..");
const cacheRoot = resolve(desktopPackageRoot, ".arc-runtime-cache");
const stagedResourcesRoot = resolve(
  desktopPackageRoot,
  "resources",
  "arc-runtimes",
);
const noticesSources = [
  resolve(desktopPackageRoot, "third-party-notices", "codex.md"),
  resolve(desktopPackageRoot, "third-party-notices", "omp.md"),
];

const DOWNLOAD_TIMEOUT_MS = 600_000;

function log(message: string): void {
  console.log(`[arc-runtimes] ${message}`);
}

function cacheExtensionFor(release: ArcRuntimeRelease): string {
  return release.artifactKind === "archive" ? ".tar.gz" : ".bin";
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

async function ensureCachedAsset(release: ArcRuntimeRelease): Promise<string> {
  await mkdir(cacheRoot, { recursive: true });
  const assetPath = join(
    cacheRoot,
    `${release.sha256}${cacheExtensionFor(release)}`,
  );
  const cachedDigest = await sha256File(assetPath).catch(() => null);
  if (cachedDigest === release.sha256) {
    log(`using cached asset ${assetPath}`);
    return assetPath;
  }
  await downloadToFile(release.downloadUrl, assetPath);
  const digest = await sha256File(assetPath);
  if (digest !== release.sha256) {
    await rm(assetPath, { force: true });
    throw new Error(
      `digest mismatch for ${release.assetName}: expected ${release.sha256}, got ${digest}`,
    );
  }
  log(`asset digest verified: ${digest}`);
  return assetPath;
}

async function publishSeed(
  release: ArcRuntimeRelease,
  stagedExecutablePath: string,
): Promise<string> {
  const versionDir = join(
    stagedResourcesRoot,
    release.runtimeId,
    release.version,
  );
  await mkdir(versionDir, { recursive: true });
  const finalPath = join(
    versionDir,
    arcRuntimeExecutableName(release.runtimeId),
  );
  const temporaryPath = `${finalPath}.tmp-${process.pid}`;
  await rm(temporaryPath, { force: true });
  await copyFile(stagedExecutablePath, temporaryPath);
  await chmod(temporaryPath, 0o755);
  await rename(temporaryPath, finalPath);
  return finalPath;
}

async function copyNotices(): Promise<void> {
  const sections: string[] = [];
  for (const sourcePath of noticesSources) {
    const notices = await readFile(sourcePath, "utf8").catch(() => null);
    if (notices === null) {
      throw new Error(`missing third-party notices source: ${sourcePath}`);
    }
    sections.push(notices.trimEnd());
  }
  await mkdir(stagedResourcesRoot, { recursive: true });
  await writeFile(
    join(stagedResourcesRoot, "THIRD_PARTY_NOTICES.md"),
    `${sections.join("\n\n---\n\n")}\n`,
    "utf8",
  );
}

async function prepareRelease(release: ArcRuntimeRelease): Promise<void> {
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

  const seedPath = join(
    stagedResourcesRoot,
    release.runtimeId,
    release.version,
    arcRuntimeExecutableName(release.runtimeId),
  );
  const seedDigest = await sha256File(seedPath).catch(() => null);
  if (seedDigest === release.executableSha256) {
    log(
      `seed for ${release.runtimeId} ${release.version} already staged and verified; skipping`,
    );
    return;
  }

  const assetPath = await ensureCachedAsset(release);
  const stagingDir = await mkdtemp(
    join(cacheRoot, `stage-${release.runtimeId}-`),
  );
  try {
    const staged = await stageReleaseExecutable({
      assetPath,
      release,
      stagingDir,
    });
    if (staged.kind === "rejected") {
      throw new Error(staged.reason);
    }
    const finalPath = await publishSeed(release, staged.executablePath);
    log(
      `staged verified seed at ${finalPath} (version ${staged.version}, digest ${staged.digest})`,
    );
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await mkdir(stagedResourcesRoot, { recursive: true });
  await copyNotices();
  for (const release of ARC_RUNTIME_RELEASES) {
    await prepareRelease(release);
  }
  log("done");
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && import.meta.url === `file://${invokedPath}`) {
  await main().catch((error: unknown) => {
    console.error(
      `[arc-runtimes] FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}

export { prepareRelease, main as prepareArcRuntimes };
