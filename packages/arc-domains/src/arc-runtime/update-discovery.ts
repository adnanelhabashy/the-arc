import { readdir } from "node:fs/promises";
import {
  ARC_RUNTIME_COMPATIBILITY_POLICY,
  evaluateArcRuntimeCompatibility,
  type ArcRuntimeCompatibilityPolicy,
} from "./compatibility.js";
import type { ArcRuntimeManifest } from "./manifest.js";
import type { ArcRuntimePaths } from "./paths.js";
import {
  validateArcRuntimeRelease,
  type ArcRuntimeRelease,
} from "./releases.js";
import type { ArcRuntimeCompatibility, ArcRuntimeId } from "./types.js";

export interface ArcRuntimeUpdateDiscovery {
  runtimeId: ArcRuntimeId;
  installedVersions: string[];
  activeVersion: string | null;
  knownGoodVersion: string | null;
  latestTrusted: ArcRuntimeRelease | null;
  latestTrustedCompatibility: ArcRuntimeCompatibility | null;
  latestTrustedCompatibilityReason: string | null;
  updateAvailable: boolean;
  rollbackAvailable: boolean;
  discoveryError: string | null;
}

// One implementation per runtime, each validated through the same trusted
// origin/asset-shape gate every other release goes through
// (validateArcRuntimeRelease) before it is trusted for anything — a
// compromised or unexpected API response cannot smuggle in an untrusted
// download source just because it came back from a "latest" lookup.
export type FetchLatestArcRuntimeRelease = (
  runtimeId: ArcRuntimeId,
) => Promise<ArcRuntimeRelease | null>;

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  digest?: string;
}

interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubReleaseAsset[];
}

async function fetchGitHubLatestRelease(
  owner: string,
  repo: string,
): Promise<GitHubRelease | null> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
    { headers: { Accept: "application/vnd.github+json" } },
  );
  if (!response.ok) return null;
  return (await response.json()) as GitHubRelease;
}

function digestFromAsset(asset: GitHubReleaseAsset | undefined): string | null {
  if (asset?.digest === undefined) return null;
  const match = /^sha256:([0-9a-f]{64})$/.exec(asset.digest);
  return match?.[1] ?? null;
}

async function discoverCodexLatestRelease(): Promise<ArcRuntimeRelease | null> {
  const release = await fetchGitHubLatestRelease("openai", "codex");
  if (release === null || release.draft || release.prerelease) return null;
  const version = release.tag_name.replace(/^rust-v/, "");
  const assetName = "codex-aarch64-apple-darwin.tar.gz";
  const asset = release.assets.find((entry) => entry.name === assetName);
  const digest = digestFromAsset(asset);
  if (asset === undefined || digest === null) return null;
  return {
    runtimeId: "codex",
    artifactKind: "archive",
    version,
    platform: "darwin-arm64",
    releaseTag: release.tag_name,
    assetName,
    downloadUrl: asset.browser_download_url,
    sha256: digest,
    executableSha256: digest,
    expectedExecutableVersion: version,
    license: "Apache-2.0",
  };
}

async function discoverOmpLatestRelease(): Promise<ArcRuntimeRelease | null> {
  const release = await fetchGitHubLatestRelease("can1357", "oh-my-pi");
  if (release === null || release.draft || release.prerelease) return null;
  const version = release.tag_name.replace(/^v/, "");
  const assetName = "omp-darwin-arm64";
  const asset = release.assets.find((entry) => entry.name === assetName);
  const digest = digestFromAsset(asset);
  if (asset === undefined || digest === null) return null;
  return {
    runtimeId: "omp",
    artifactKind: "executable",
    version,
    platform: "darwin-arm64",
    releaseTag: release.tag_name,
    assetName,
    downloadUrl: asset.browser_download_url,
    sha256: digest,
    executableSha256: digest,
    expectedExecutableVersion: version,
    license: "MIT",
  };
}

// Mirrors exactly what Anthropic's own official installer does to discover
// the current stable version (claude.ai/install.sh: a plain-text version at
// `.../latest`, then that version's manifest.json for the per-platform
// checksum) — no new endpoint invented, and macOS code-signature
// verification (ADR-030) remains the cryptographic gate regardless of where
// the checksum came from.
async function discoverClaudeLatestRelease(): Promise<ArcRuntimeRelease | null> {
  const base = "https://downloads.claude.ai/claude-code-releases";
  const versionResponse = await fetch(`${base}/latest`);
  if (!versionResponse.ok) return null;
  const version = (await versionResponse.text()).trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;

  const manifestResponse = await fetch(`${base}/${version}/manifest.json`);
  if (!manifestResponse.ok) return null;
  const manifest = (await manifestResponse.json()) as {
    platforms?: Record<string, { checksum?: string }>;
  };
  const checksum = manifest.platforms?.["darwin-arm64"]?.checksum;
  if (checksum === undefined || !/^[0-9a-f]{64}$/.test(checksum)) return null;

  return {
    runtimeId: "claude-code",
    artifactKind: "direct-official",
    version,
    platform: "darwin-arm64",
    releaseTag: `v${version}`,
    assetName: "claude",
    downloadUrl: `${base}/${version}/darwin-arm64/claude`,
    sha256: checksum,
    executableSha256: checksum,
    expectedExecutableVersion: version,
    license: "Anthropic Commercial Terms",
  };
}

export const defaultFetchLatestArcRuntimeRelease: FetchLatestArcRuntimeRelease =
  async (runtimeId) => {
    if (runtimeId === "codex") return discoverCodexLatestRelease();
    if (runtimeId === "omp") return discoverOmpLatestRelease();
    return discoverClaudeLatestRelease();
  };

async function listInstalledVersions(
  runtimePaths: ArcRuntimePaths,
  runtimeId: ArcRuntimeId,
): Promise<string[]> {
  try {
    const entries = await readdir(runtimePaths.runtimeRoot(runtimeId), {
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export interface DiscoverArcRuntimeUpdateArgs {
  runtimeId: ArcRuntimeId;
  manifest: ArcRuntimeManifest;
  runtimePaths: ArcRuntimePaths;
  compatibilityPolicy?: ArcRuntimeCompatibilityPolicy;
  fetchLatestRelease?: FetchLatestArcRuntimeRelease;
}

// Side-effect-free (plan 2.4): never downloads, stages, or writes the
// manifest. Safe to call as often as a status/refresh poll needs to.
export async function discoverArcRuntimeUpdate(
  args: DiscoverArcRuntimeUpdateArgs,
): Promise<ArcRuntimeUpdateDiscovery> {
  const { runtimeId, manifest, runtimePaths } = args;
  const fetchLatestRelease =
    args.fetchLatestRelease ?? defaultFetchLatestArcRuntimeRelease;
  const compatibilityPolicy =
    args.compatibilityPolicy ?? ARC_RUNTIME_COMPATIBILITY_POLICY;
  const entry = manifest.runtimes[runtimeId];

  const [installedVersions, latestResult] = await Promise.all([
    listInstalledVersions(runtimePaths, runtimeId),
    fetchLatestRelease(runtimeId)
      .then((release) => ({ release, error: null as string | null }))
      .catch((error: unknown) => ({
        release: null,
        error: error instanceof Error ? error.message : String(error),
      })),
  ]);

  let latestTrusted: ArcRuntimeRelease | null = null;
  let discoveryError = latestResult.error;
  if (latestResult.release !== null) {
    const validation = validateArcRuntimeRelease(latestResult.release);
    if (validation.kind === "ok") {
      latestTrusted = latestResult.release;
    } else {
      discoveryError = `discovered release failed trust validation: ${validation.problem}`;
    }
  }

  const latestEvaluation =
    latestTrusted === null
      ? null
      : evaluateArcRuntimeCompatibility({
          runtimeId,
          version: latestTrusted.version,
          policy: compatibilityPolicy,
        });

  const updateAvailable =
    latestTrusted !== null &&
    latestTrusted.version !== entry.activeVersion &&
    latestEvaluation?.compatibility !== "blocked";

  const rollbackAvailable =
    entry.knownGoodVersion !== null &&
    entry.knownGoodVersion !== entry.activeVersion;

  return {
    runtimeId,
    installedVersions,
    activeVersion: entry.activeVersion,
    knownGoodVersion: entry.knownGoodVersion,
    latestTrusted,
    latestTrustedCompatibility: latestEvaluation?.compatibility ?? null,
    latestTrustedCompatibilityReason: latestEvaluation?.reason ?? null,
    updateAvailable,
    rollbackAvailable,
    discoveryError,
  };
}
