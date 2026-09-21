import {
  createBbDesktopVersionFeedFileName,
  type BbDesktopVersionFeedPlatform,
} from "@bb/desktop-contract";

type DesktopReleaseChannel = "latest" | "nightly";

interface DesktopReleaseInfo {
  applicationName: "Arc Agent" | "Arc Agent Nightly";
  channel: DesktopReleaseChannel;
  iconFileName: "icon.png" | "icon-nightly.png";
  releaseTag: "desktop-latest" | "desktop-nightly";
  updateReleaseBaseUrl: string | null;
}

// Arc owns its update source, never BB's. Until an Arc-controlled release
// feed is baked in at build time (apps/desktop/scripts/build.mjs defines this
// exact expression, mirroring BB_DESKTOP_RELEASE_CHANNEL below), there is no
// base URL at all: no fallback to BB's github.com/get-bb/bb releases, so a
// missing Arc feed fails closed instead of silently discovering BB's channel.
const ARC_DESKTOP_UPDATE_FEED_BASE_URL =
  process.env.ARC_DESKTOP_UPDATE_FEED_BASE_URL;

function resolveArcUpdateFeedOrigin(
  rawValue: string | undefined,
): string | null {
  const raw = rawValue?.trim();
  return raw === undefined || raw.length === 0 ? null : raw;
}

export function createDesktopReleaseInfo(
  channel: DesktopReleaseChannel,
  feedOriginRaw: string | undefined = ARC_DESKTOP_UPDATE_FEED_BASE_URL,
): DesktopReleaseInfo {
  const nightly = channel === "nightly";
  const releaseTag = nightly ? "desktop-nightly" : "desktop-latest";
  const feedOrigin = resolveArcUpdateFeedOrigin(feedOriginRaw);

  return {
    applicationName: nightly ? "Arc Agent Nightly" : "Arc Agent",
    channel,
    iconFileName: nightly ? "icon-nightly.png" : "icon.png",
    releaseTag,
    updateReleaseBaseUrl: feedOrigin === null ? null : `${feedOrigin}${releaseTag}/`,
  };
}

function resolveBuiltDesktopReleaseChannel(
  rawChannel: string | undefined,
): DesktopReleaseChannel {
  if (rawChannel === undefined || rawChannel.length === 0) {
    return "latest";
  }
  if (rawChannel === "latest" || rawChannel === "nightly") {
    return rawChannel;
  }

  throw new Error(
    `Built desktop release channel must be latest or nightly, got ${String(rawChannel)}.`,
  );
}

export const DESKTOP_RELEASE_CHANNEL = resolveBuiltDesktopReleaseChannel(
  process.env.BB_DESKTOP_RELEASE_CHANNEL,
);
export const DESKTOP_RELEASE_INFO = createDesktopReleaseInfo(
  DESKTOP_RELEASE_CHANNEL,
);
const DESKTOP_UPDATE_RELEASE_BASE_URL =
  DESKTOP_RELEASE_INFO.updateReleaseBaseUrl;

export function createDesktopUpdateFeedUrl(
  platform: BbDesktopVersionFeedPlatform,
): string | null {
  return DESKTOP_UPDATE_RELEASE_BASE_URL === null
    ? null
    : `${DESKTOP_UPDATE_RELEASE_BASE_URL}${createBbDesktopVersionFeedFileName(platform)}`;
}

export interface DesktopAutoUpdateFeedConfig {
  channel: DesktopReleaseChannel;
  provider: "generic";
  url: string;
}

// Never null-checked at the setFeedURL call site: `resolveDesktopUpdateSupport`
// is the single fail-closed gate keeping `enabled` false wherever no Arc feed
// is configured, so this url is only ever read once a real Arc feed exists.
export const DESKTOP_AUTO_UPDATE_FEED_CONFIG: DesktopAutoUpdateFeedConfig = {
  channel: DESKTOP_RELEASE_CHANNEL,
  provider: "generic",
  url: DESKTOP_UPDATE_RELEASE_BASE_URL ?? "",
};

interface DesktopUpdateSupport {
  autoUpdate: boolean;
  versionCheck: boolean;
}

interface ResolveDesktopUpdateSupportArgs {
  canReplaceAppImage: (appImagePath: string) => boolean;
  env: NodeJS.ProcessEnv;
  // Whether an Arc-controlled update feed is configured at all. False means
  // no Arc release backend exists yet, so Arc must not discover or install
  // updates from anywhere, including BB's channel: fail closed, not a
  // fallback.
  feedConfigured: boolean;
  platform: BbDesktopVersionFeedPlatform;
}

export function resolveDesktopUpdateSupport(
  args: ResolveDesktopUpdateSupportArgs,
): DesktopUpdateSupport {
  if (!args.feedConfigured) {
    return { autoUpdate: false, versionCheck: false };
  }

  if (args.platform === "macos") {
    return { autoUpdate: true, versionCheck: true };
  }

  const appImagePath = args.env.APPIMAGE?.trim() ?? "";
  if (appImagePath.length === 0) {
    return { autoUpdate: false, versionCheck: true };
  }

  return {
    autoUpdate: args.canReplaceAppImage(appImagePath),
    versionCheck: true,
  };
}
