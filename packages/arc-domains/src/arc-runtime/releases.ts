import { valid } from "semver";
import type { ArcRuntimeId } from "./types.js";

export type ArcRuntimeArtifactKind =
  | "archive"
  | "executable"
  | "direct-official";

export interface ArcRuntimeRelease {
  runtimeId: ArcRuntimeId;
  artifactKind: ArcRuntimeArtifactKind;
  version: string;
  platform: string;
  releaseTag: string;
  assetName: string;
  downloadUrl: string;
  sha256: string;
  executableSha256: string;
  expectedExecutableVersion: string;
  license: string;
}

interface TrustedReleaseOrigin {
  host: string;
  pathPrefix: string;
}

const TRUSTED_RELEASE_ORIGINS: Partial<Record<ArcRuntimeId, TrustedReleaseOrigin>> =
  {
    codex: {
      host: "github.com",
      pathPrefix: "/openai/codex/releases/download/",
    },
    omp: {
      host: "github.com",
      pathPrefix: "/can1357/oh-my-pi/releases/download/",
    },
    "claude-code": {
      host: "downloads.claude.ai",
      pathPrefix: "/claude-code-releases/",
    },
  };

export const ARC_CODEX_RELEASE: ArcRuntimeRelease = {
  runtimeId: "codex",
  artifactKind: "archive",
  version: "0.155.1",
  platform: "darwin-arm64",
  releaseTag: "rust-v0.155.1",
  assetName: "codex-aarch64-apple-darwin.tar.gz",
  downloadUrl:
    "https://github.com/openai/codex/releases/download/rust-v0.155.1/codex-aarch64-apple-darwin.tar.gz",
  sha256:
    "5e5a51470dce2423f9d96bd191d0bbc4cc0e2848a6833df5178eaf47a07a3768",
  executableSha256:
    "8eaf1ad12fe6bf89b1710330f58900014322c7c5af677e43be116d8ac5fc0a9e",
  expectedExecutableVersion: "0.155.1",
  license: "Apache-2.0",
};

export const ARC_OMP_RELEASE: ArcRuntimeRelease = {
  runtimeId: "omp",
  artifactKind: "executable",
  version: "18.2.6",
  platform: "darwin-arm64",
  releaseTag: "v18.2.6",
  assetName: "omp-darwin-arm64",
  downloadUrl:
    "https://github.com/can1357/oh-my-pi/releases/download/v18.2.6/omp-darwin-arm64",
  sha256:
    "d498da40d577e1ffa681ca8632c2ea40a9f722a08b880412011d37dffee9513a",
  executableSha256:
    "d498da40d577e1ffa681ca8632c2ea40a9f722a08b880412011d37dffee9513a",
  expectedExecutableVersion: "18.2.6",
  license: "MIT",
};

export const ARC_RUNTIME_RELEASES: readonly ArcRuntimeRelease[] = [
  ARC_CODEX_RELEASE,
  ARC_OMP_RELEASE,
];

// Claude Code is proprietary (© Anthropic PBC, Commercial Terms) and is never
// bundled or redistributed inside Arc. Arc's setup downloads this exact pinned
// build directly from Anthropic's official release endpoint on the user's
// machine. The pinned checksum was extracted from the GPG-signed release
// manifest (key fingerprint 31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE,
// manifest.json.sig verified during Arc release engineering) — see
// adnan/arc-productization/IMPLEMENTATION_LOG.md Phase 5.
export const ARC_CLAUDE_CODE_RELEASE: ArcRuntimeRelease = {
  runtimeId: "claude-code",
  artifactKind: "direct-official",
  version: "2.1.276",
  platform: "darwin-arm64",
  releaseTag: "v2.1.276",
  assetName: "claude",
  downloadUrl:
    "https://downloads.claude.ai/claude-code-releases/2.1.276/darwin-arm64/claude",
  sha256:
    "9de364db11a410d53cbbb0f6b1f18c66c90053efc9a63370072856d10db66329",
  executableSha256:
    "9de364db11a410d53cbbb0f6b1f18c66c90053efc9a63370072856d10db66329",
  expectedExecutableVersion: "2.1.276",
  license: "Anthropic Commercial Terms",
};

export type ArcRuntimeReleaseValidation =
  | { kind: "ok" }
  | { kind: "invalid"; problem: string };

function isHexDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

export function validateArcRuntimeRelease(
  release: ArcRuntimeRelease,
): ArcRuntimeReleaseValidation {
  if (valid(release.version) === null) {
    return {
      kind: "invalid",
      problem: `release version "${release.version}" is not valid semver`,
    };
  }
  if (valid(release.expectedExecutableVersion) === null) {
    return {
      kind: "invalid",
      problem: `expected executable version "${release.expectedExecutableVersion}" is not valid semver`,
    };
  }
  if (release.releaseTag.includes("latest")) {
    return {
      kind: "invalid",
      problem: `release tag "${release.releaseTag}" must not reference a moving target`,
    };
  }
  if (!isHexDigest(release.sha256)) {
    return {
      kind: "invalid",
      problem: "sha256 must be a lowercase 64-character hex digest",
    };
  }
  if (!isHexDigest(release.executableSha256)) {
    return {
      kind: "invalid",
      problem: "executableSha256 must be a lowercase 64-character hex digest",
    };
  }
  if (
    release.artifactKind !== "archive" &&
    release.artifactKind !== "executable" &&
    release.artifactKind !== "direct-official"
  ) {
    return {
      kind: "invalid",
      problem: `artifactKind "${String(release.artifactKind)}" is not supported`,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(release.downloadUrl);
  } catch {
    return { kind: "invalid", problem: "downloadUrl is not a valid URL" };
  }
  if (parsed.protocol !== "https:") {
    return {
      kind: "invalid",
      problem: `downloadUrl must use https, got ${parsed.protocol}`,
    };
  }
  const trustedOrigin = TRUSTED_RELEASE_ORIGINS[release.runtimeId];
  if (trustedOrigin === undefined) {
    return {
      kind: "invalid",
      problem: `no trusted download origin is recorded for runtime "${release.runtimeId}"`,
    };
  }
  if (
    parsed.host !== trustedOrigin.host ||
    !parsed.pathname.startsWith(trustedOrigin.pathPrefix)
  ) {
    return {
      kind: "invalid",
      problem: `downloadUrl must be a ${trustedOrigin.host} release asset under ${trustedOrigin.pathPrefix}`,
    };
  }
  if (
    release.artifactKind !== "direct-official" &&
    !parsed.pathname.endsWith(`/${release.assetName}`)
  ) {
    return {
      kind: "invalid",
      problem: "downloadUrl must end with the exact pinned asset name",
    };
  }
  if (
    release.artifactKind === "direct-official" &&
    !parsed.pathname.endsWith(`/${release.version}/${release.platform}/${release.assetName}`)
  ) {
    return {
      kind: "invalid",
      problem:
        "direct-official downloadUrl must end with the exact pinned /<version>/<platform>/<binary> path",
    };
  }
  if (
    release.downloadUrl.includes("latest") ||
    release.assetName.includes("latest")
  ) {
    return {
      kind: "invalid",
      problem: "release identity must never use a latest alias",
    };
  }
  if (
    release.artifactKind === "archive" &&
    !release.assetName.endsWith(".tar.gz")
  ) {
    return {
      kind: "invalid",
      problem: 'archive artifacts must use the ".tar.gz" extension',
    };
  }
  if (
    release.artifactKind === "executable" &&
    release.sha256 !== release.executableSha256
  ) {
    return {
      kind: "invalid",
      problem:
        "executable artifacts are staged directly, so sha256 and executableSha256 must be identical",
    };
  }
  return { kind: "ok" };
}
