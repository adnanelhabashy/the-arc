import { chmod, copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { extractArcRuntimeExecutable } from "./archive.js";
import { sha256File } from "./digest.js";
import { probeArcRuntimeVersion } from "./probe.js";
import { arcRuntimeExecutableName } from "./paths.js";
import type { ArcRuntimeRelease } from "./releases.js";

export type ArcRuntimeStageResult =
  | { kind: "ok"; executablePath: string; digest: string; version: string }
  | { kind: "rejected"; reason: string };

export interface StageReleaseExecutableArgs {
  release: ArcRuntimeRelease;
  assetPath: string;
  stagingDir: string;
}

async function stageArchiveExecutable(
  release: ArcRuntimeRelease,
  assetPath: string,
  stagingDir: string,
): Promise<string> {
  const archiveEntryName = release.assetName.replace(/\.tar\.gz$/, "");
  await extractArcRuntimeExecutable({
    archivePath: assetPath,
    destinationDir: stagingDir,
    expectedFileName: archiveEntryName,
  });

  const extractedPath = join(stagingDir, archiveEntryName);
  const executablePath = join(
    stagingDir,
    arcRuntimeExecutableName(release.runtimeId),
  );
  await rename(extractedPath, executablePath);
  return executablePath;
}

async function stageDirectExecutable(
  release: ArcRuntimeRelease,
  assetPath: string,
  stagingDir: string,
): Promise<string> {
  const sourceStat = await stat(assetPath);
  if (!sourceStat.isFile()) {
    throw new Error(`asset ${assetPath} is not a regular file`);
  }
  const sourceDigest = await sha256File(assetPath);
  if (sourceDigest !== release.sha256) {
    throw new Error(
      `downloaded asset digest mismatch: expected ${release.sha256}, got ${sourceDigest}`,
    );
  }
  const executablePath = join(
    stagingDir,
    arcRuntimeExecutableName(release.runtimeId),
  );
  await copyFile(assetPath, executablePath);
  return executablePath;
}

export async function stageReleaseExecutable(
  args: StageReleaseExecutableArgs,
): Promise<ArcRuntimeStageResult> {
  const { release, assetPath, stagingDir } = args;
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  try {
    const executablePath =
      release.artifactKind === "archive"
        ? await stageArchiveExecutable(release, assetPath, stagingDir)
        : await stageDirectExecutable(release, assetPath, stagingDir);
    await chmod(executablePath, 0o755);

    const digest = await sha256File(executablePath);
    if (digest !== release.executableSha256) {
      return {
        kind: "rejected",
        reason: `staged executable digest mismatch: expected ${release.executableSha256}, got ${digest}`,
      };
    }

    const probe = await probeArcRuntimeVersion({ executablePath });
    if (probe.kind === "failed") {
      return { kind: "rejected", reason: `version probe failed: ${probe.reason}` };
    }
    if (probe.version !== release.expectedExecutableVersion) {
      return {
        kind: "rejected",
        reason: `version probe reported ${probe.version}, expected ${release.expectedExecutableVersion}`,
      };
    }

    return { kind: "ok", executablePath, digest, version: probe.version };
  } catch (error) {
    return {
      kind: "rejected",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
