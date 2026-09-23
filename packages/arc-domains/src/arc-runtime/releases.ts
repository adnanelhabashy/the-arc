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
  /**
   * First-party helpers the runtime cannot function without, published as
   * separate assets in the *same* release as the primary binary. They are
   * version-locked by construction — one release tag, one version — so they
   * are never discovered or versioned independently.
   */
  companions?: readonly ArcRuntimeCompanion[];
}

/**
 * A required companion executable of a runtime, staged as a sibling of the
 * runtime's own executable inside the version directory.
 *
 * The file name is a hard contract, not a preference: Codex discovers its
 * code-mode host as `<directory of the running codex>/codex-code-mode-host`
 * (`codex-rs/install-context/src/lib.rs`), with no PATH lookup and no
 * environment variable. Arc's managed layout resolves to
 * `InstallMethod::Other`, so the sibling path is the only one that works.
 */
export interface ArcRuntimeCompanion {
  /** File name inside the version directory; also the discovery contract. */
  fileName: string;
  /** Entry name inside the archive, when the published archive names it differently. */
  archiveEntryName: string;
  artifactKind: Extract<ArcRuntimeArtifactKind, "archive" | "executable">;
  assetName: string;
  downloadUrl: string;
  /** Digest of the published asset, as reported by the release host. */
  sha256: string;
  /** Digest of the executable after extraction or copy. */
  executableSha256: string;
  /**
   * Whether the companion answers `--version`. The code-mode host does not
   * (it has no such flag), so its identity rests on the release tag plus both
   * digests rather than on a self-reported version string.
   */
  reportsVersion: boolean;
  /**
   * Arguments that prove the companion starts, for the health probe's
   * liveness check. Omitted for a companion with no meaningful offline signal,
   * in which case presence, executability and digest are the whole proof.
   */
  livenessArgs?: readonly string[];
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
  companions: [
    {
      fileName: "codex-code-mode-host",
      archiveEntryName: "codex-code-mode-host-aarch64-apple-darwin",
      artifactKind: "archive",
      assetName: "codex-code-mode-host-aarch64-apple-darwin.tar.gz",
      downloadUrl:
        "https://github.com/openai/codex/releases/download/rust-v0.155.1/codex-code-mode-host-aarch64-apple-darwin.tar.gz",
      sha256:
        "e8957108eebd70963b0906857ceb7f7a2b477d1972a7147041c625d4071b508a",
      executableSha256:
        "59a702a68f1ef79fceaca644db46b8385ceefbb66035e78b8ade7cdcc21fda55",
      reportsVersion: false,
      // Verified against the real 0.155.1 helper: with stdin held open it
      // stays up serving stdio; with stdin closed it exits 0 immediately.
      livenessArgs: ["--listen", "stdio"],
    },
  ],
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
  for (const companion of release.companions ?? []) {
    const problem = validateArcRuntimeCompanion(release, companion);
    if (problem !== null) {
      return { kind: "invalid", problem };
    }
  }
  return { kind: "ok" };
}

function validateArcRuntimeCompanion(
  release: ArcRuntimeRelease,
  companion: ArcRuntimeCompanion,
): string | null {
  if (!/^[\w.+@-]+$/.test(companion.fileName)) {
    return `companion file name "${companion.fileName}" is not a plain file name`;
  }
  if (!/^[\w.+@-]+$/.test(companion.archiveEntryName)) {
    return `companion archive entry "${companion.archiveEntryName}" is not a plain file name`;
  }
  if (companion.artifactKind === "executable") {
    if (companion.sha256 !== companion.executableSha256) {
      return `companion ${companion.fileName} is staged directly, so sha256 and executableSha256 must be identical`;
    }
    if (companion.archiveEntryName !== companion.fileName) {
      return `companion ${companion.fileName} is staged directly, so its archive entry name is unused and must match its file name`;
    }
  }
  if (companion.artifactKind === "archive" && !companion.assetName.endsWith(".tar.gz")) {
    return `companion ${companion.fileName} is an archive, so its asset must use the ".tar.gz" extension`;
  }
  for (const [label, value] of [
    ["sha256", companion.sha256],
    ["executableSha256", companion.executableSha256],
  ] as const) {
    if (!isHexDigest(value)) {
      return `companion ${companion.fileName} ${label} is not a sha256 digest`;
    }
  }
  if (
    companion.downloadUrl.includes("latest") ||
    companion.assetName.includes("latest")
  ) {
    return `companion ${companion.fileName} must never use a latest alias`;
  }
  let parsed: URL;
  try {
    parsed = new URL(companion.downloadUrl);
  } catch {
    return `companion ${companion.fileName} downloadUrl is not a valid URL`;
  }
  const trustedOrigin = TRUSTED_RELEASE_ORIGINS[release.runtimeId];
  if (trustedOrigin === undefined) {
    return `no trusted download origin is recorded for runtime "${release.runtimeId}"`;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.host !== trustedOrigin.host ||
    !parsed.pathname.startsWith(trustedOrigin.pathPrefix)
  ) {
    return `companion ${companion.fileName} downloadUrl must be a ${trustedOrigin.host} release asset under ${trustedOrigin.pathPrefix}`;
  }
  if (!parsed.pathname.endsWith(`/${companion.assetName}`)) {
    return `companion ${companion.fileName} downloadUrl must end with its exact pinned asset name`;
  }
  if (!parsed.pathname.includes(`/${release.releaseTag}/`)) {
    return `companion ${companion.fileName} must be published under the same release tag (${release.releaseTag}) as the runtime it belongs to`;
  }
  return null;
}
