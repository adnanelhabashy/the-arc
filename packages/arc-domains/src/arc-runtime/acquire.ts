import { chmod, copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { extractArcRuntimeExecutable } from "./archive.js";
import { sha256File } from "./digest.js";
import { probeArcRuntimeVersion } from "./probe.js";
import { arcRuntimeExecutableName } from "./paths.js";
import type { ArcRuntimeCompanion, ArcRuntimeRelease } from "./releases.js";

export type ArcRuntimeStageResult =
  | {
      kind: "ok";
      executablePath: string;
      digest: string;
      version: string;
      /** Staged companion file name → digest of the staged executable. */
      components: Record<string, string>;
    }
  | { kind: "rejected"; reason: string };

export interface StageReleaseExecutableArgs {
  release: ArcRuntimeRelease;
  assetPath: string;
  stagingDir: string;
  /** Companion file name → the downloaded asset to stage it from. */
  companionAssetPaths?: Record<string, string>;
}

/**
 * Stages one companion into the same directory as the runtime executable.
 *
 * Deliberately no version probe: `codex-code-mode-host` has no `--version`
 * flag, and a companion is version-locked to the runtime by construction —
 * both are published from one release tag — so its identity rests on the
 * pinned asset digest and the pinned executable digest instead. Both are
 * verified here, so a companion can never be staged from a different release
 * than the binary beside it.
 */
export async function stageArcRuntimeCompanion(args: {
  companion: ArcRuntimeCompanion;
  assetPath: string;
  stagingDir: string;
  isWindows: boolean;
}): Promise<{ kind: "ok"; digest: string } | { kind: "rejected"; reason: string }> {
  const { companion, assetPath, stagingDir, isWindows } = args;
  const destination = join(stagingDir, companion.fileName);
  try {
    if (companion.artifactKind === "archive") {
      // Extract into a directory of its own: the archive extractor asserts the
      // destination holds exactly the one entry it extracted, and by the time a
      // companion is staged the shared staging directory already holds the
      // runtime executable.
      const extractDir = join(stagingDir, `extract-${companion.fileName}`);
      await rm(extractDir, { recursive: true, force: true });
      await mkdir(extractDir, { recursive: true });
      try {
        await extractArcRuntimeExecutable({
          archivePath: assetPath,
          destinationDir: extractDir,
          expectedFileName: companion.archiveEntryName,
        });
        await rename(join(extractDir, companion.archiveEntryName), destination);
      } finally {
        await rm(extractDir, { recursive: true, force: true });
      }
    } else {
      const assetStat = await stat(assetPath);
      if (!assetStat.isFile()) {
        return {
          kind: "rejected",
          reason: `companion asset ${assetPath} is not a regular file`,
        };
      }
      await copyFile(assetPath, destination);
    }
    await chmod(destination, isWindows ? 0o644 : 0o755);
    const digest = await sha256File(destination);
    if (digest !== companion.executableSha256) {
      return {
        kind: "rejected",
        reason: `staged ${companion.fileName} digest mismatch: expected ${companion.executableSha256}, got ${digest}`,
      };
    }
    return { kind: "ok", digest };
  } catch (error) {
    return {
      kind: "rejected",
      reason: `could not stage ${companion.fileName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Copies a companion out of the bundled seed into a staging directory and
 * verifies it against the pin. The seed is an Arc build artifact, not a
 * download, so there is no asset digest to check — the executable digest is
 * the whole contract, exactly as it is for the runtime's own seed.
 */
export async function stageArcRuntimeCompanionFromSeed(args: {
  companion: ArcRuntimeCompanion;
  seedPath: string;
  stagingDir: string;
  isWindows: boolean;
}): Promise<{ kind: "ok"; digest: string } | { kind: "rejected"; reason: string }> {
  const destination = join(args.stagingDir, args.companion.fileName);
  try {
    await copyFile(args.seedPath, destination);
    await chmod(destination, args.isWindows ? 0o644 : 0o755);
    const digest = await sha256File(destination);
    if (digest !== args.companion.executableSha256) {
      return {
        kind: "rejected",
        reason: `copied ${args.companion.fileName} digest mismatch: expected ${args.companion.executableSha256}, got ${digest}`,
      };
    }
    return { kind: "ok", digest };
  } catch (error) {
    return {
      kind: "rejected",
      reason: `could not copy ${args.companion.fileName} from the seed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
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

    const components: Record<string, string> = {};
    for (const companion of release.companions ?? []) {
      const companionAssetPath = args.companionAssetPaths?.[companion.fileName];
      if (companionAssetPath === undefined) {
        return {
          kind: "rejected",
          reason: `no asset was downloaded for required companion ${companion.fileName}`,
        };
      }
      const stagedCompanion = await stageArcRuntimeCompanion({
        companion,
        assetPath: companionAssetPath,
        stagingDir,
        isWindows: process.platform === "win32",
      });
      if (stagedCompanion.kind === "rejected") {
        return { kind: "rejected", reason: stagedCompanion.reason };
      }
      components[companion.fileName] = stagedCompanion.digest;
    }

    return { kind: "ok", executablePath, digest, version: probe.version, components };
  } catch (error) {
    return {
      kind: "rejected",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
