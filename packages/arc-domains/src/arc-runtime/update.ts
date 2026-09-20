import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  activateArcRuntimeVersion,
  promoteArcRuntimeKnownGood,
  rollbackArcRuntimeVersion,
} from "./activation.js";
import type { ArcRuntimeCompatibilityPolicy } from "./compatibility.js";
import {
  probeArcRuntimeHealth,
  type ArcRuntimeHealthProbeResult,
  type ProbeArcRuntimeHealthArgs,
} from "./health.js";
import type { ArcRuntimeManifest } from "./manifest.js";
import type { ArcRuntimePaths } from "./paths.js";
import type { ArcRuntimeRelease } from "./releases.js";
import type { ArcRuntimeId, ArcRuntimeSource } from "./types.js";
import {
  discoverArcRuntimeUpdate,
  type FetchLatestArcRuntimeRelease,
} from "./update-discovery.js";
import {
  downloadAndStageArcRuntimeRelease,
  type DownloadArcRuntimeAsset,
} from "./update-download.js";

export type ArcRuntimeUpdateOutcome =
  | { kind: "updated"; version: string; detail: string }
  | { kind: "up-to-date"; version: string | null }
  | { kind: "no-trusted-update"; reason: string }
  | { kind: "staging-failed"; reason: string }
  | { kind: "pre-activation-health-failed"; reason: string }
  | { kind: "activation-failed"; reason: string }
  | {
      kind: "post-activation-unhealthy-rolled-back";
      from: string;
      to: string;
      reason: string;
    }
  | {
      kind: "post-activation-unhealthy-no-rollback-target";
      version: string;
      reason: string;
    };

export interface UpdateArcRuntimeArgs {
  runtimeId: ArcRuntimeId;
  manifest: ArcRuntimeManifest;
  createdByArcVersion: string;
  platform: string;
  runtimePaths: ArcRuntimePaths;
  compatibilityPolicy?: ArcRuntimeCompatibilityPolicy;
  fetchLatestRelease?: FetchLatestArcRuntimeRelease;
  download?: DownloadArcRuntimeAsset;
  verifyExecutable?: (executablePath: string) => Promise<boolean>;
  now?: () => number;
  // Test seam for exercising the pre/post-activation decision branches
  // without a real binary whose behavior differs by invocation path.
  probeHealth?: (
    args: ProbeArcRuntimeHealthArgs,
  ) => Promise<ArcRuntimeHealthProbeResult>;
}

function activationSourceFor(release: ArcRuntimeRelease): ArcRuntimeSource {
  return release.artifactKind === "direct-official"
    ? "official-managed-install"
    : "arc-managed-download";
}

async function moveStagedToVersionRoot(
  stagedExecutablePath: string,
  runtimePaths: ArcRuntimePaths,
  runtimeId: ArcRuntimeId,
  version: string,
): Promise<void> {
  const stagingDir = dirname(stagedExecutablePath);
  const versionRoot = runtimePaths.versionRoot(runtimeId, version);
  await mkdir(dirname(versionRoot), { recursive: true });
  await rm(versionRoot, { recursive: true, force: true });
  await rename(stagingDir, versionRoot);
}

// The full lifecycle from plan 2.30: discover → download → verify → local
// health check → activate → successful startup → mark known-good, with
// automatic rollback exactly at the boundary plan 2.10/2.15 draws — a
// runtime that will not start or answer its own health probe rolls back;
// nothing here ever inspects account, quota, or network state, so those
// failures (out of this function's reach entirely) can never trigger it.
// Callers are expected to run this inside the same per-runtime exclusive
// lock prepare/repair already use (ArcAgentManager.runExclusive), so this
// function assumes it is the only in-flight operation for runtimeId.
export async function updateArcRuntime(
  args: UpdateArcRuntimeArgs,
): Promise<ArcRuntimeUpdateOutcome> {
  const discovery = await discoverArcRuntimeUpdate({
    runtimeId: args.runtimeId,
    manifest: args.manifest,
    runtimePaths: args.runtimePaths,
    compatibilityPolicy: args.compatibilityPolicy,
    fetchLatestRelease: args.fetchLatestRelease,
  });

  if (discovery.latestTrusted === null) {
    return {
      kind: "no-trusted-update",
      reason: discovery.discoveryError ?? "no trusted release discovered",
    };
  }
  if (!discovery.updateAvailable) {
    return { kind: "up-to-date", version: discovery.activeVersion };
  }
  const release = discovery.latestTrusted;

  const staged = await downloadAndStageArcRuntimeRelease({
    release,
    runtimePaths: args.runtimePaths,
    download: args.download,
    verifyExecutable: args.verifyExecutable,
  });
  if (staged.kind === "rejected") {
    return { kind: "staging-failed", reason: staged.reason };
  }

  const probeHealth = args.probeHealth ?? probeArcRuntimeHealth;
  const preHealth = await probeHealth({
    runtimeId: args.runtimeId,
    executablePath: staged.executablePath,
    expectedVersion: release.version,
  });
  if (preHealth.kind === "unhealthy") {
    await rm(dirname(staged.executablePath), { recursive: true, force: true });
    return { kind: "pre-activation-health-failed", reason: preHealth.detail };
  }

  await moveStagedToVersionRoot(
    staged.executablePath,
    args.runtimePaths,
    args.runtimeId,
    release.version,
  );

  const activated = await activateArcRuntimeVersion({
    runtimeId: args.runtimeId,
    version: release.version,
    source: activationSourceFor(release),
    digest: staged.digest,
    createdByArcVersion: args.createdByArcVersion,
    platform: args.platform,
    runtimePaths: args.runtimePaths,
    now: args.now,
  });
  if (activated.kind === "failed") {
    return { kind: "activation-failed", reason: activated.reason };
  }

  const postHealth = await probeHealth({
    runtimeId: args.runtimeId,
    executablePath: args.runtimePaths.executablePath(
      args.runtimeId,
      release.version,
    ),
    expectedVersion: release.version,
  });
  if (postHealth.kind === "unhealthy") {
    const rollback = await rollbackArcRuntimeVersion({
      runtimeId: args.runtimeId,
      createdByArcVersion: args.createdByArcVersion,
      platform: args.platform,
      runtimePaths: args.runtimePaths,
      now: args.now,
    });
    if (rollback.kind === "rolled-back") {
      return {
        kind: "post-activation-unhealthy-rolled-back",
        from: rollback.from,
        to: rollback.to,
        reason: postHealth.detail,
      };
    }
    return {
      kind: "post-activation-unhealthy-no-rollback-target",
      version: release.version,
      reason: postHealth.detail,
    };
  }

  await promoteArcRuntimeKnownGood({
    runtimeId: args.runtimeId,
    createdByArcVersion: args.createdByArcVersion,
    platform: args.platform,
    runtimePaths: args.runtimePaths,
  });

  return {
    kind: "updated",
    version: release.version,
    detail: `${args.runtimeId} updated to ${release.version} and promoted to known-good`,
  };
}
