import { constants } from "node:fs";
import { access, mkdir, rename, rm, stat } from "node:fs/promises";
import { sha256File } from "./digest.js";
import type { ArcVoicePaths } from "./paths.js";
import {
  createEmptyVoiceRuntimeManifest,
  mutateVoiceRuntimeManifest,
  readVoiceRuntimeManifest,
  type VoiceRuntimeManifest,
  type VoiceRuntimeManifestSource,
} from "./manifest.js";
import type { ArcVoiceboxRelease } from "./release.js";

export type ArcVoiceboxInstallState =
  | {
      kind: "installed";
      version: string;
      digest: string;
      executablePath: string;
    }
  | { kind: "absent"; reason: string }
  | { kind: "drift"; reason: string };

async function isRunnableFile(
  path: string,
  isWindows: boolean,
): Promise<boolean> {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) {
      return false;
    }
    if (isWindows) {
      return true;
    }
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface InspectArcVoiceboxInstallArgs {
  release: ArcVoiceboxRelease;
  paths: ArcVoicePaths;
  createdByArcVersion: string;
  platform: string;
  arch: string;
}

export async function inspectArcVoiceboxInstall(
  args: InspectArcVoiceboxInstallArgs,
): Promise<ArcVoiceboxInstallState> {
  const read = await readVoiceRuntimeManifest({
    manifestPath: args.paths.manifestPath,
    createdByArcVersion: args.createdByArcVersion,
    platform: args.platform,
    arch: args.arch,
  });
  if (read.kind === "missing") {
    return { kind: "absent", reason: "no voice runtime manifest is installed" };
  }
  if (read.kind === "invalid") {
    return { kind: "absent", reason: read.problem };
  }
  const manifest = read.manifest;
  if (manifest.activeVersion === null) {
    return {
      kind: "absent",
      reason: "voice runtime manifest records no active version",
    };
  }
  if (manifest.activeVersion !== args.release.version) {
    return {
      kind: "drift",
      reason: `voice runtime manifest records version ${manifest.activeVersion}, this Arc build pins ${args.release.version}`,
    };
  }
  if (manifest.installPath !== args.paths.executablePath) {
    return {
      kind: "drift",
      reason: `voice runtime is installed at ${manifest.installPath ?? "an unrecorded path"}, expected ${args.paths.executablePath}`,
    };
  }
  if (
    !(await isRunnableFile(
      args.paths.executablePath,
      args.platform.startsWith("win32"),
    ))
  ) {
    return {
      kind: "drift",
      reason: `voice runtime executable is missing or not runnable at ${args.paths.executablePath}`,
    };
  }
  const digest = await sha256File(args.paths.executablePath);
  if (digest !== args.release.componentSha256) {
    return {
      kind: "drift",
      reason: `installed voice runtime digest is ${digest}, expected ${args.release.componentSha256}`,
    };
  }
  return {
    kind: "installed",
    version: manifest.activeVersion,
    digest,
    executablePath: args.paths.executablePath,
  };
}

export type ActivateArcVoiceboxResult =
  | { kind: "activated"; version: string; digest: string }
  | { kind: "already-active"; version: string }
  | { kind: "failed"; reason: string };

export interface ActivateArcVoiceboxVersionArgs {
  release: ArcVoiceboxRelease;
  paths: ArcVoicePaths;
  createdByArcVersion: string;
  platform: string;
  arch: string;
  version: string;
  digest: string;
  stagedExecutablePath: string;
  source: VoiceRuntimeManifestSource;
  now?: () => number;
}

export async function activateArcVoiceboxVersion(
  args: ActivateArcVoiceboxVersionArgs,
): Promise<ActivateArcVoiceboxResult> {
  if (args.version !== args.release.version) {
    return {
      kind: "failed",
      reason: `refusing to activate version ${args.version}: this Arc build pins ${args.release.version}`,
    };
  }

  const install = await inspectArcVoiceboxInstall(args);
  if (install.kind === "installed") {
    return { kind: "already-active", version: install.version };
  }

  if (
    !(await isRunnableFile(
      args.stagedExecutablePath,
      args.platform.startsWith("win32"),
    ))
  ) {
    return {
      kind: "failed",
      reason: `staged voice runtime is missing or not runnable at ${args.stagedExecutablePath}`,
    };
  }
  const stagedDigest = await sha256File(args.stagedExecutablePath);
  if (
    stagedDigest !== args.digest ||
    stagedDigest !== args.release.componentSha256
  ) {
    return {
      kind: "failed",
      reason: `staged voice runtime digest is ${stagedDigest}, expected ${args.digest}`,
    };
  }

  try {
    await rm(args.paths.previousRoot, { recursive: true, force: true });
    const activeExists =
      (await stat(args.paths.activeRoot).catch(() => null)) !== null;
    if (activeExists) {
      await rename(args.paths.activeRoot, args.paths.previousRoot);
    }
    await mkdir(args.paths.activeRoot, { recursive: true });
    await rename(
      args.stagedExecutablePath,
      `${args.paths.activeRoot}/${args.release.componentFileName}`,
    );
  } catch (error) {
    return {
      kind: "failed",
      reason: `could not activate voice runtime ${args.version}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  await mutateVoiceRuntimeManifest({
    manifestPath: args.paths.manifestPath,
    createdByArcVersion: args.createdByArcVersion,
    platform: args.platform,
    arch: args.arch,
    mutate: (manifest) => ({
      ...manifest,
      activeVersion: args.version,
      previousVersion:
        manifest.activeVersion === args.version
          ? manifest.previousVersion
          : manifest.activeVersion,
      source: args.source,
      installPath: args.paths.executablePath,
      digest: stagedDigest,
      digestsByVersion: {
        ...manifest.digestsByVersion,
        [args.version]: stagedDigest,
      },
      installedAt: (args.now ?? Date.now)(),
      healthState: "unknown",
    }),
  });

  return { kind: "activated", version: args.version, digest: stagedDigest };
}

export type PromoteArcVoiceboxKnownGoodResult =
  | { kind: "promoted"; version: string }
  | { kind: "already-known-good"; version: string }
  | { kind: "failed"; reason: string };

export interface ArcVoiceboxManifestTargetArgs {
  paths: ArcVoicePaths;
  createdByArcVersion: string;
  platform: string;
  arch: string;
}

export async function promoteArcVoiceboxKnownGood(
  args: ArcVoiceboxManifestTargetArgs,
): Promise<PromoteArcVoiceboxKnownGoodResult> {
  let outcome: PromoteArcVoiceboxKnownGoodResult | null = null;
  await mutateVoiceRuntimeManifest({
    manifestPath: args.paths.manifestPath,
    createdByArcVersion: args.createdByArcVersion,
    platform: args.platform,
    arch: args.arch,
    mutate: (manifest) => {
      if (manifest.activeVersion === null) {
        outcome = {
          kind: "failed",
          reason: "no active voice runtime version to promote",
        };
        return manifest;
      }
      if (manifest.knownGoodVersion === manifest.activeVersion) {
        outcome = {
          kind: "already-known-good",
          version: manifest.activeVersion,
        };
        return manifest;
      }
      outcome = { kind: "promoted", version: manifest.activeVersion };
      return { ...manifest, knownGoodVersion: manifest.activeVersion };
    },
  });
  return outcome ?? { kind: "failed", reason: "promotion produced no result" };
}

export type RollbackArcVoiceboxResult =
  | { kind: "rolled-back"; from: string; to: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "failed"; reason: string };

export interface RollbackArcVoiceboxVersionArgs {
  release: ArcVoiceboxRelease;
  paths: ArcVoicePaths;
  createdByArcVersion: string;
  platform: string;
  arch: string;
  now?: () => number;
}

export async function rollbackArcVoiceboxVersion(
  args: RollbackArcVoiceboxVersionArgs,
): Promise<RollbackArcVoiceboxResult> {
  const read = await readVoiceRuntimeManifest({
    manifestPath: args.paths.manifestPath,
    createdByArcVersion: args.createdByArcVersion,
    platform: args.platform,
    arch: args.arch,
  });
  const manifest: VoiceRuntimeManifest =
    read.kind === "ok"
      ? read.manifest
      : createEmptyVoiceRuntimeManifest({
          createdByArcVersion: args.createdByArcVersion,
          platform: args.platform,
          arch: args.arch,
        });
  const target = manifest.knownGoodVersion;
  const from = manifest.activeVersion;
  if (target === null || from === null) {
    return {
      kind: "unavailable",
      reason: "no known-good voice runtime version is recorded",
    };
  }
  if (target === from) {
    return {
      kind: "unavailable",
      reason: `active voice runtime ${from} is already the known-good version`,
    };
  }

  const previousExecutable = `${args.paths.previousRoot}/${args.release.componentFileName}`;
  const previousPresent = await isRunnableFile(
    previousExecutable,
    args.platform.startsWith("win32"),
  );
  if (!previousPresent) {
    return {
      kind: "unavailable",
      reason: `known-good voice runtime ${target} is no longer on disk at ${previousExecutable}`,
    };
  }
  const expectedDigest = manifest.digestsByVersion[target];
  if (expectedDigest === undefined) {
    return {
      kind: "unavailable",
      reason: `no digest is recorded for known-good voice runtime ${target}`,
    };
  }
  const previousDigest = await sha256File(previousExecutable);
  if (previousDigest !== expectedDigest) {
    return {
      kind: "failed",
      reason: `known-good voice runtime digest is ${previousDigest}, expected ${expectedDigest}`,
    };
  }

  try {
    await mkdir(args.paths.stagingRoot, { recursive: true });
    await rm(args.paths.rolledBackStagingPath(from), {
      recursive: true,
      force: true,
    });
    await rename(args.paths.activeRoot, args.paths.rolledBackStagingPath(from));
    await rename(args.paths.previousRoot, args.paths.activeRoot);
  } catch (error) {
    return {
      kind: "failed",
      reason: `could not roll back voice runtime: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  await mutateVoiceRuntimeManifest({
    manifestPath: args.paths.manifestPath,
    createdByArcVersion: args.createdByArcVersion,
    platform: args.platform,
    arch: args.arch,
    mutate: (current) => ({
      ...current,
      activeVersion: target,
      previousVersion: null,
      knownGoodVersion: target,
      installPath: args.paths.executablePath,
      digest: previousDigest,
      installedAt: (args.now ?? Date.now)(),
      healthState: "unknown",
    }),
  });

  return { kind: "rolled-back", from, to: target };
}

export async function setArcVoiceboxHealthState(
  args: ArcVoiceboxManifestTargetArgs & {
    healthState: VoiceRuntimeManifest["healthState"];
  },
): Promise<void> {
  await mutateVoiceRuntimeManifest({
    manifestPath: args.paths.manifestPath,
    createdByArcVersion: args.createdByArcVersion,
    platform: args.platform,
    arch: args.arch,
    mutate: (manifest) => ({ ...manifest, healthState: args.healthState }),
  });
}
