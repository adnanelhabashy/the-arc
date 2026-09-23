import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { sha256File } from "./digest.js";
import { resolveArcPlatformIdentity } from "./platform.js";
import {
  stageArcVoiceboxComponentFromBundle,
  stageArcVoiceboxComponentFromFile,
  type ArcVoiceboxProbe,
  type ArcVoiceboxStageResult,
} from "./acquire.js";
import {
  validateArcVoiceboxRelease,
  type ArcVoiceboxRelease,
} from "./release.js";

export interface StageArcVoiceboxSeedArgs {
  release: ArcVoiceboxRelease;
  artifactPath: string;
  stagedResourcesRoot: string;
  probe?: ArcVoiceboxProbe;
  platform?: NodeJS.Platform;
  arch?: string;
}

export type ArcVoiceboxSeedResult =
  | { kind: "staged"; seedPath: string; digest: string; version: string }
  | { kind: "complete" }
  | { kind: "skipped"; reason: string };

export function arcVoiceboxSeedVersionDir(args: {
  release: ArcVoiceboxRelease;
  stagedResourcesRoot: string;
}): string {
  return join(
    args.stagedResourcesRoot,
    args.release.runtimeId,
    args.release.version,
  );
}

export function arcVoiceboxSeedFileDigests(
  release: ArcVoiceboxRelease,
): readonly { readonly fileName: string; readonly sha256: string }[] {
  return [
    { fileName: release.componentFileName, sha256: release.componentSha256 },
  ];
}

export type ArcVoiceboxSeedPlan =
  | { readonly kind: "complete" }
  | { readonly kind: "rebuild"; readonly missing: readonly string[] };

export function planArcVoiceboxSeedBuild(args: {
  release: ArcVoiceboxRelease;
  seedDigests: Readonly<Record<string, string | null>>;
}): ArcVoiceboxSeedPlan {
  const missing = arcVoiceboxSeedFileDigests(args.release)
    .filter(
      (expected) => args.seedDigests[expected.fileName] !== expected.sha256,
    )
    .map((expected) => expected.fileName);
  return missing.length === 0
    ? { kind: "complete" }
    : { kind: "rebuild", missing };
}

async function stageFromArtifact(args: {
  release: ArcVoiceboxRelease;
  artifactPath: string;
  stagingDir: string;
  probe?: ArcVoiceboxProbe;
}): Promise<ArcVoiceboxStageResult> {
  const artifactStat = await stat(args.artifactPath).catch(() => null);
  if (artifactStat === null) {
    return {
      kind: "rejected",
      reason: `artifact ${args.artifactPath} does not exist`,
    };
  }
  const probeArgs = args.probe === undefined ? {} : { probe: args.probe };
  return artifactStat.isDirectory() && args.artifactPath.endsWith(".app")
    ? stageArcVoiceboxComponentFromBundle({
        release: args.release,
        bundlePath: args.artifactPath,
        stagingDir: args.stagingDir,
        ...probeArgs,
      })
    : stageArcVoiceboxComponentFromFile({
        release: args.release,
        componentPath: args.artifactPath,
        stagingDir: args.stagingDir,
        ...probeArgs,
      });
}

export async function stageArcVoiceboxSeed(
  args: StageArcVoiceboxSeedArgs,
): Promise<ArcVoiceboxSeedResult> {
  const { release } = args;
  const validation = validateArcVoiceboxRelease(release);
  if (validation.kind === "invalid") {
    throw new Error(`invalid voice release metadata: ${validation.problem}`);
  }

  const currentPlatform = resolveArcPlatformIdentity({
    platform: args.platform ?? process.platform,
    arch: args.arch ?? process.arch,
  });
  if (release.platform !== currentPlatform) {
    return {
      kind: "skipped",
      reason: `pinned for ${release.platform}, building on ${currentPlatform}`,
    };
  }

  const versionDir = arcVoiceboxSeedVersionDir({
    release,
    stagedResourcesRoot: args.stagedResourcesRoot,
  });
  const seedDigests: Record<string, string | null> = {};
  for (const expected of arcVoiceboxSeedFileDigests(release)) {
    seedDigests[expected.fileName] = await sha256File(
      join(versionDir, expected.fileName),
    ).catch(() => null);
  }
  if (planArcVoiceboxSeedBuild({ release, seedDigests }).kind === "complete") {
    return { kind: "complete" };
  }

  await mkdir(args.stagedResourcesRoot, { recursive: true });
  const stagingRoot = await mkdtemp(
    join(args.stagedResourcesRoot, "voice-staging-"),
  );
  try {
    const staged = await stageFromArtifact({
      release,
      artifactPath: args.artifactPath,
      stagingDir: join(stagingRoot, release.version),
      ...(args.probe === undefined ? {} : { probe: args.probe }),
    });
    if (staged.kind === "rejected") {
      throw new Error(staged.reason);
    }

    await mkdir(versionDir, { recursive: true });
    const seedPath = join(versionDir, release.componentFileName);
    const temporaryPath = `${seedPath}.tmp-${process.pid}`;
    await rm(temporaryPath, { force: true });
    await copyFile(staged.executablePath, temporaryPath);
    await chmod(temporaryPath, 0o755);
    await rename(temporaryPath, seedPath);

    return {
      kind: "staged",
      seedPath,
      digest: staged.digest,
      version: staged.version,
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
