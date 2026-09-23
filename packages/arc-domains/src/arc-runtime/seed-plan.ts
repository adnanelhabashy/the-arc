import { join } from "node:path";
import { arcRuntimeExecutableName } from "./paths.js";
import type { ArcRuntimeRelease } from "./releases.js";

/**
 * What a runtime's staged seed directory must contain, and whether it does.
 *
 * The desktop seed pipeline (`apps/desktop/scripts/prepare-arc-runtimes.mts`)
 * writes one directory per runtime version, and `electron-builder` copies that
 * tree into the app verbatim. This module owns the definition of "complete",
 * because getting it wrong is how a clean build could ship Codex without the
 * `codex-code-mode-host` beside it: a seed was considered finished once the
 * executable's digest matched, so a directory that had never held the helper
 * looked done.
 */

/** The file names a seed directory must contain for this release. */
export function arcRuntimeSeedFileNames(
  release: ArcRuntimeRelease,
): readonly string[] {
  return [
    arcRuntimeExecutableName(release.runtimeId),
    ...(release.companions ?? []).map((companion) => companion.fileName),
  ];
}

/** Where a release's seed directory lives under a resources root. */
export function arcRuntimeSeedVersionDir(args: {
  release: ArcRuntimeRelease;
  stagedResourcesRoot: string;
}): string {
  return join(
    args.stagedResourcesRoot,
    args.release.runtimeId,
    args.release.version,
  );
}

/** The digest every seed file must have, so a partial seed is detectable. */
export function arcRuntimeSeedFileDigests(
  release: ArcRuntimeRelease,
): readonly { readonly fileName: string; readonly sha256: string }[] {
  return [
    {
      fileName: arcRuntimeExecutableName(release.runtimeId),
      sha256: release.executableSha256,
    },
    ...(release.companions ?? []).map((companion) => ({
      fileName: companion.fileName,
      sha256: companion.executableSha256,
    })),
  ];
}

export type ArcRuntimeSeedPlan =
  | { readonly kind: "complete" }
  | { readonly kind: "rebuild"; readonly missing: readonly string[] };

/**
 * Whether a seed directory is complete, given the digest each of its files
 * actually has — `null` for a file that is absent or unreadable. Any file whose
 * digest differs from its pin makes the whole seed a rebuild candidate, and the
 * report names every such file so a partial seed is visible in the build log.
 */
export function planArcRuntimeSeedBuild(args: {
  release: ArcRuntimeRelease;
  seedDigests: Readonly<Record<string, string | null>>;
}): ArcRuntimeSeedPlan {
  const missing = arcRuntimeSeedFileDigests(args.release)
    .filter(
      (expected) => args.seedDigests[expected.fileName] !== expected.sha256,
    )
    .map((expected) => expected.fileName);
  return missing.length === 0
    ? { kind: "complete" }
    : { kind: "rebuild", missing };
}
