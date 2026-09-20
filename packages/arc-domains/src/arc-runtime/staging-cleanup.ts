import { readdir, rm } from "node:fs/promises";
import type { ArcRuntimePaths } from "./paths.js";

// A staging directory is always scratch space: a partial download, an
// unverified candidate, or a rejected one — never the source of truth for
// an active or known-good runtime (those live under runtimePaths.runtimeRoot,
// a different tree entirely). Sweeping it at startup is therefore always
// safe: nothing here can be "in use" by a running process across an app
// restart, and a crash mid-download or mid-verification leaves exactly this
// kind of abandoned directory (plan 2.7, 2.22).
export async function cleanAbandonedArcRuntimeStaging(
  runtimePaths: ArcRuntimePaths,
): Promise<{ removed: string[]; failed: string[] }> {
  const removed: string[] = [];
  const failed: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(runtimePaths.stagingRoot);
  } catch {
    return { removed, failed };
  }
  for (const entry of entries) {
    const path = `${runtimePaths.stagingRoot}/${entry}`;
    try {
      await rm(path, { recursive: true, force: true });
      removed.push(entry);
    } catch {
      failed.push(entry);
    }
  }
  return { removed, failed };
}
