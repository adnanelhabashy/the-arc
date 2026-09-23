import { valid } from "semver";
import { resolveArcPlatformIdentity } from "./platform.js";

export type ArcVoiceboxRuntimeId = "voicebox";

export interface ArcVoiceboxRelease {
  runtimeId: ArcVoiceboxRuntimeId;
  version: string;
  platform: string;
  assetName: string;
  componentFileName: string;
  componentBundlePath: string;
  componentSha256: string;
  versionArgs: readonly string[];
  expectedVersionOutput: string;
  license: string;
}

export const ARC_VOICEBOX_RELEASE: ArcVoiceboxRelease = {
  runtimeId: "voicebox",
  version: "0.5.0",
  platform: "darwin-arm64",
  assetName: "Voicebox.app",
  componentFileName: "voicebox-server",
  componentBundlePath: "Contents/MacOS/voicebox-server",
  componentSha256:
    "c8e7fd28b0177ad2c0bd9feb8de5f5415f73fbf3588afedd0f03a0621263967a",
  versionArgs: ["--version"],
  expectedVersionOutput: "voicebox-server 0.5.0",
  license: "MIT",
};

export type ArcVoiceboxReleaseValidation =
  | { kind: "ok" }
  | { kind: "invalid"; problem: string };

const SHA256_HEX = /^[0-9a-f]{64}$/;
const PLATFORM_IDENTITY = /^[a-z0-9]+-[a-z0-9_]+$/;

export function validateArcVoiceboxRelease(
  release: ArcVoiceboxRelease,
): ArcVoiceboxReleaseValidation {
  if (release.runtimeId !== "voicebox") {
    return {
      kind: "invalid",
      problem: `unexpected runtime id ${release.runtimeId}`,
    };
  }
  if (valid(release.version) === null) {
    return {
      kind: "invalid",
      problem: `version ${release.version} is not a semantic version`,
    };
  }
  if (!PLATFORM_IDENTITY.test(release.platform)) {
    return {
      kind: "invalid",
      problem: `platform ${release.platform} is not a platform-architecture identity`,
    };
  }
  if (!SHA256_HEX.test(release.componentSha256)) {
    return {
      kind: "invalid",
      problem: "componentSha256 is not a lowercase hex sha256 digest",
    };
  }
  if (release.componentFileName.length === 0) {
    return { kind: "invalid", problem: "componentFileName is empty" };
  }
  if (release.componentBundlePath.length === 0) {
    return { kind: "invalid", problem: "componentBundlePath is empty" };
  }
  if (release.assetName.length === 0) {
    return { kind: "invalid", problem: "assetName is empty" };
  }
  if (release.versionArgs.length === 0) {
    return { kind: "invalid", problem: "versionArgs is empty" };
  }
  if (release.expectedVersionOutput.trim().length === 0) {
    return { kind: "invalid", problem: "expectedVersionOutput is empty" };
  }
  if (release.license.length === 0) {
    return { kind: "invalid", problem: "license is empty" };
  }
  return { kind: "ok" };
}

export function voiceboxComponentPathInBundle(args: {
  bundlePath: string;
  release: ArcVoiceboxRelease;
}): string {
  return `${args.bundlePath.replace(/\/+$/, "")}/${args.release.componentBundlePath}`;
}

export type ArcVoiceboxReleaseAvailability =
  | { kind: "available" }
  | { kind: "unsupported-platform"; current: string; pinned: string };

export function voiceboxReleaseAvailability(
  release: ArcVoiceboxRelease,
  args: { platform: NodeJS.Platform; arch: string },
): ArcVoiceboxReleaseAvailability {
  const current = resolveArcPlatformIdentity(args);
  return release.platform === current
    ? { kind: "available" }
    : { kind: "unsupported-platform", current, pinned: release.platform };
}
