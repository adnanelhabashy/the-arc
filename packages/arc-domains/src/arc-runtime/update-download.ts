import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { stageReleaseExecutable, type ArcRuntimeStageResult } from "./acquire.js";
import type { ArcRuntimePaths } from "./paths.js";
import { validateArcRuntimeRelease, type ArcRuntimeRelease } from "./releases.js";

const DOWNLOAD_TIMEOUT_MS = 600_000;

export type DownloadArcRuntimeAsset = (
  url: string,
  destinationPath: string,
) => Promise<void>;

// Shared by every runtime's update path (Codex/OMP/Claude): claude-setup.ts
// keeps its own copy for the first-install flow so that already-shipped,
// live-verified behavior is untouched by this addition.
export async function defaultDownloadArcRuntimeAsset(
  url: string,
  destinationPath: string,
): Promise<void> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || response.body === null) {
    throw new Error(`download failed with HTTP ${response.status}`);
  }
  const temporaryPath = `${destinationPath}.partial-${process.pid}`;
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
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
  try {
    await promise;
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  await rename(temporaryPath, destinationPath);
}

export interface DownloadAndStageArcRuntimeReleaseArgs {
  release: ArcRuntimeRelease;
  runtimePaths: ArcRuntimePaths;
  // Verified inside the same staging directory, before digest/version are
  // trusted, so a rejected signature never leaves a runnable candidate
  // behind (e.g. macOS codesign verification for Claude, ADR-030).
  verifyExecutable?: (executablePath: string) => Promise<boolean>;
  verifyExecutableFailureReason?: string;
  download?: DownloadArcRuntimeAsset;
}

export type ArcRuntimeDownloadAndStageResult =
  | ArcRuntimeStageResult
  | { kind: "rejected"; reason: string };

// A candidate release, not necessarily the build-time pin: this is the
// engine's single "fetch and verify an update" pipeline, reusing
// acquire.ts's existing archive/executable staging and digest/version-probe
// verification rather than duplicating it. Staging happens in a scratch
// directory under runtimePaths.stagingRoot; nothing here ever touches the
// active runtime directory, so a crash or a rejected candidate leaves the
// current runtime exactly as it was.
export async function downloadAndStageArcRuntimeRelease(
  args: DownloadAndStageArcRuntimeReleaseArgs,
): Promise<ArcRuntimeDownloadAndStageResult> {
  const { release, runtimePaths } = args;
  const download = args.download ?? defaultDownloadArcRuntimeAsset;

  const validation = validateArcRuntimeRelease(release);
  if (validation.kind === "invalid") {
    return {
      kind: "rejected",
      reason: `invalid release metadata: ${validation.problem}`,
    };
  }

  await mkdir(runtimePaths.stagingRoot, { recursive: true });
  const workDir = join(
    runtimePaths.stagingRoot,
    `${release.runtimeId}-update-${release.version}-${process.pid}-${Date.now()}`,
  );
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const assetPath = join(workDir, "asset");
  const stagingDir = join(workDir, "staged");

  const companions = release.companions ?? [];
  const companionAssetPaths: Record<string, string> = {};

  try {
    await download(release.downloadUrl, assetPath);
    for (const companion of companions) {
      const companionAssetPath = join(
        workDir,
        `companion-${companion.fileName}`,
      );
      await download(companion.downloadUrl, companionAssetPath);
      companionAssetPaths[companion.fileName] = companionAssetPath;
    }
  } catch (error) {
    await rm(workDir, { recursive: true, force: true });
    return {
      kind: "rejected",
      reason: `download failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const staged = await stageReleaseExecutable({
    release,
    assetPath,
    stagingDir,
    companionAssetPaths,
  });
  if (staged.kind === "rejected") {
    await rm(workDir, { recursive: true, force: true });
    return staged;
  }

  if (args.verifyExecutable !== undefined) {
    const ok = await args.verifyExecutable(staged.executablePath);
    if (!ok) {
      await rm(workDir, { recursive: true, force: true });
      return {
        kind: "rejected",
        reason:
          args.verifyExecutableFailureReason ??
          "downloaded executable failed verification",
      };
    }
  }

  await rm(assetPath, { force: true });
  return staged;
}
