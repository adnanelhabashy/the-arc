import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import {
  mutateArcRuntimeManifest,
  type ArcRuntimeManifest,
} from "./manifest.js";
import type { ArcRuntimePaths } from "./paths.js";
import type { ArcRuntimeId, ArcRuntimeSource } from "./types.js";

async function isRunnableExecutable(
  path: string,
  isWindows: boolean,
): Promise<boolean> {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) return false;
    if (isWindows) return true;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ActivateArcRuntimeVersionArgs {
  runtimeId: ArcRuntimeId;
  version: string;
  source: ArcRuntimeSource;
  digest: string;
  /** Companion file name → digest of the staged companion, as verified. */
  components?: Record<string, string>;
  createdByArcVersion: string;
  platform: string;
  runtimePaths: ArcRuntimePaths;
  now?: () => number;
}

export type ActivateArcRuntimeVersionResult =
  | { kind: "activated"; version: string }
  | { kind: "already-active"; version: string }
  | { kind: "failed"; reason: string };

// Atomic activation is the manifest write itself (ADR-016/037): the
// candidate's files are already staged and verified by the time this runs,
// so this function's only job is the atomic activeVersion swap. Callers
// route every operation for a given runtime through the manager's per-agent
// lock (ArcAgentManager.runExclusive), so same-runtime activation is never
// concurrent with itself; mutateArcRuntimeManifest's serialization exists
// for cross-runtime safety (e.g. Codex and Claude activating at once), not
// for this. Never deletes the previous version's directory.
export async function activateArcRuntimeVersion(
  args: ActivateArcRuntimeVersionArgs,
): Promise<ActivateArcRuntimeVersionResult> {
  const isWindows = args.platform.startsWith("win32");
  const candidateExecutable = args.runtimePaths.executablePath(
    args.runtimeId,
    args.version,
  );
  if (!(await isRunnableExecutable(candidateExecutable, isWindows))) {
    return {
      kind: "failed",
      reason: `staged executable for ${args.runtimeId} ${args.version} is missing or not runnable at ${candidateExecutable}`,
    };
  }

  let outcome: ActivateArcRuntimeVersionResult | null = null;
  await mutateArcRuntimeManifest({
    createdByArcVersion: args.createdByArcVersion,
    manifestPath: args.runtimePaths.manifestPath,
    platform: args.platform,
    mutate: (manifest) => {
      const entry = manifest.runtimes[args.runtimeId];
      if (entry.activeVersion === args.version) {
        outcome = { kind: "already-active", version: args.version };
        return manifest;
      }
      outcome = { kind: "activated", version: args.version };
      const next: ArcRuntimeManifest = {
        ...manifest,
        runtimes: {
          ...manifest.runtimes,
          [args.runtimeId]: {
            activeVersion: args.version,
            previousVersion: entry.activeVersion,
            knownGoodVersion: entry.knownGoodVersion,
            source: args.source,
            digest: args.digest,
            componentsByVersion: {
              ...entry.componentsByVersion,
              [args.version]: args.components ?? {},
            },
            installedAt: (args.now ?? Date.now)(),
          },
        },
      };
      return next;
    },
  });
  return (
    outcome ?? { kind: "failed", reason: "activation produced no result" }
  );
}

export interface PromoteArcRuntimeKnownGoodArgs {
  runtimeId: ArcRuntimeId;
  createdByArcVersion: string;
  platform: string;
  runtimePaths: ArcRuntimePaths;
}

export type PromoteArcRuntimeKnownGoodResult =
  | { kind: "promoted"; version: string }
  | { kind: "already-known-good"; version: string }
  | { kind: "failed"; reason: string };

// Promotion never happens implicitly on download or activation (plan
// 2.13): it is a distinct, explicit step the caller takes only after
// observing the newly-activated version actually work (a health probe or a
// real provider startup), so a candidate that activates but never proves
// itself never becomes the rollback target that a later failure would
// preserve.
export async function promoteArcRuntimeKnownGood(
  args: PromoteArcRuntimeKnownGoodArgs,
): Promise<PromoteArcRuntimeKnownGoodResult> {
  let outcome: PromoteArcRuntimeKnownGoodResult | null = null;
  await mutateArcRuntimeManifest({
    createdByArcVersion: args.createdByArcVersion,
    manifestPath: args.runtimePaths.manifestPath,
    platform: args.platform,
    mutate: (manifest) => {
      const entry = manifest.runtimes[args.runtimeId];
      if (entry.activeVersion === null) {
        outcome = {
          kind: "failed",
          reason: `${args.runtimeId} has no active version to promote`,
        };
        return manifest;
      }
      if (entry.knownGoodVersion === entry.activeVersion) {
        outcome = {
          kind: "already-known-good",
          version: entry.activeVersion,
        };
        return manifest;
      }
      outcome = { kind: "promoted", version: entry.activeVersion };
      return {
        ...manifest,
        runtimes: {
          ...manifest.runtimes,
          [args.runtimeId]: {
            ...entry,
            knownGoodVersion: entry.activeVersion,
          },
        },
      };
    },
  });
  return outcome ?? { kind: "failed", reason: "promotion produced no result" };
}

export interface RollbackArcRuntimeVersionArgs {
  runtimeId: ArcRuntimeId;
  createdByArcVersion: string;
  platform: string;
  runtimePaths: ArcRuntimePaths;
  now?: () => number;
}

export type RollbackArcRuntimeVersionResult =
  | { kind: "rolled-back"; from: string; to: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "failed"; reason: string };

// Explicit rollback (plan 2.14): reactivates knownGoodVersion, never
// previousVersion directly — knownGoodVersion is the version that actually
// proved itself, which is the only thing "rollback" should mean. Never
// redownloads: a known-good target whose files are no longer on disk is a
// distinct, reported failure, not a silent no-op or a fresh install.
export async function rollbackArcRuntimeVersion(
  args: RollbackArcRuntimeVersionArgs,
): Promise<RollbackArcRuntimeVersionResult> {
  const isWindows = args.platform.startsWith("win32");
  let target: { from: string; to: string; digest: string | null } | null =
    null;
  let unavailable: string | null = null;

  await mutateArcRuntimeManifest({
    createdByArcVersion: args.createdByArcVersion,
    manifestPath: args.runtimePaths.manifestPath,
    platform: args.platform,
    mutate: async (manifest) => {
      const entry = manifest.runtimes[args.runtimeId];
      if (
        entry.knownGoodVersion === null ||
        entry.knownGoodVersion === entry.activeVersion
      ) {
        unavailable = `${args.runtimeId} has no rollback target (knownGoodVersion is ${
          entry.knownGoodVersion === null ? "unset" : "already active"
        })`;
        return manifest;
      }
      const targetExecutable = args.runtimePaths.executablePath(
        args.runtimeId,
        entry.knownGoodVersion,
      );
      if (!(await isRunnableExecutable(targetExecutable, isWindows))) {
        unavailable = `known-good ${args.runtimeId} ${entry.knownGoodVersion} is no longer installed at ${targetExecutable}; rollback cannot proceed without a fresh install`;
        return manifest;
      }
      // A version is only as restorable as its helpers: rolling back to a
      // binary whose required companions are gone would restore a runtime that
      // cannot do what it is for, so the target's recorded components are
      // checked here rather than discovered after the swap.
      const targetComponents =
        entry.componentsByVersion[entry.knownGoodVersion] ?? {};
      for (const fileName of Object.keys(targetComponents)) {
        const componentPath = args.runtimePaths.componentPath(
          args.runtimeId,
          entry.knownGoodVersion,
          fileName,
        );
        if (!(await isRunnableExecutable(componentPath, isWindows))) {
          unavailable = `known-good ${args.runtimeId} ${entry.knownGoodVersion} is missing its required helper ${fileName} at ${componentPath}; rollback cannot proceed without a fresh install`;
          return manifest;
        }
      }
      target = {
        from: entry.activeVersion ?? "none",
        to: entry.knownGoodVersion,
        digest: entry.digest,
      };
      return {
        ...manifest,
        runtimes: {
          ...manifest.runtimes,
          [args.runtimeId]: {
            activeVersion: entry.knownGoodVersion,
            previousVersion: entry.activeVersion,
            knownGoodVersion: entry.knownGoodVersion,
            source: entry.source,
            digest: entry.digest,
            componentsByVersion: entry.componentsByVersion,
            installedAt: (args.now ?? Date.now)(),
          },
        },
      };
    },
  });

  if (unavailable !== null) {
    return { kind: "unavailable", reason: unavailable };
  }
  if (target === null) {
    return { kind: "failed", reason: "rollback produced no result" };
  }
  const resolved: { from: string; to: string } = target;
  return { kind: "rolled-back", from: resolved.from, to: resolved.to };
}
