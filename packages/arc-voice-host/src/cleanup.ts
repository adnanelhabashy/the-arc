import { readdir, rm } from "node:fs/promises";
import type { ArcVoicePaths } from "./paths.js";

export async function cleanAbandonedArcVoiceStaging(
  paths: ArcVoicePaths,
): Promise<{ removed: string[]; failed: string[] }> {
  const removed: string[] = [];
  const failed: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(paths.stagingRoot);
  } catch {
    return { removed, failed };
  }
  for (const entry of entries) {
    try {
      await rm(`${paths.stagingRoot}/${entry}`, {
        recursive: true,
        force: true,
      });
      removed.push(entry);
    } catch {
      failed.push(entry);
    }
  }
  return { removed, failed };
}

export interface RemoveArcVoiceboxInstallArgs {
  paths: ArcVoicePaths;
  removeVoiceData?: boolean;
}

export async function removeArcVoiceboxInstall(
  args: RemoveArcVoiceboxInstallArgs,
): Promise<{ removed: string[]; failed: string[] }> {
  const targets = [
    args.paths.activeRoot,
    args.paths.previousRoot,
    args.paths.stagingRoot,
    args.paths.manifestPath,
    ...(args.removeVoiceData === true
      ? [args.paths.modelsRoot, args.paths.dataDir]
      : []),
  ];
  const removed: string[] = [];
  const failed: string[] = [];
  for (const target of targets) {
    try {
      await rm(target, { recursive: true, force: true });
      removed.push(target);
    } catch {
      failed.push(target);
    }
  }
  return { removed, failed };
}
