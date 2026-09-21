import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDesktopReleaseInfo,
  createDesktopUpdateFeedUrl,
  resolveDesktopUpdateSupport,
} from "../src/desktop-update-provider.js";

const desktopPackageRoot = process.cwd();

describe("build-time feed url wiring", () => {
  it("bakes the same literal expression the build script defines, so a CI-configured feed actually reaches the packaged app", async () => {
    const buildScript = await readFile(
      resolve(desktopPackageRoot, "scripts/build.mjs"),
      "utf8",
    );
    const providerSource = await readFile(
      resolve(desktopPackageRoot, "src/desktop-update-provider.ts"),
      "utf8",
    );
    const literalExpression = "process.env.ARC_DESKTOP_UPDATE_FEED_BASE_URL";

    expect(buildScript).toContain(`"${literalExpression}"`);
    expect(providerSource.replace(/\s+/gu, " ")).toContain(literalExpression);
  });
});

describe("desktop release info", () => {
  it("has no update feed at all when Arc has not configured one, never falling back to BB", () => {
    expect(
      createDesktopReleaseInfo("latest", undefined).updateReleaseBaseUrl,
    ).toBe(null);
    expect(
      createDesktopReleaseInfo("nightly", undefined).updateReleaseBaseUrl,
    ).toBe(null);
    expect(createDesktopReleaseInfo("latest", "   ").updateReleaseBaseUrl).toBe(
      null,
    );
  });

  it("builds a per-channel feed url once Arc's own release origin is configured", () => {
    const origin = "https://releases.arc.example/";

    expect(
      createDesktopReleaseInfo("latest", origin).updateReleaseBaseUrl,
    ).toBe("https://releases.arc.example/desktop-latest/");
    expect(
      createDesktopReleaseInfo("nightly", origin).updateReleaseBaseUrl,
    ).toBe("https://releases.arc.example/desktop-nightly/");
  });
});

describe("desktop update feed url", () => {
  it("gives no feed url when Arc has not configured its own release origin", () => {
    expect(createDesktopUpdateFeedUrl("macos")).toBe(null);
    expect(createDesktopUpdateFeedUrl("linux")).toBe(null);
  });
});

const APP_IMAGE_PATH = "/home/user/Apps/bb-0.37.0-x86_64.AppImage";
const alwaysReplaceable = () => true;
const neverReplaceable = () => false;

describe("desktop update support", () => {
  it("fails closed on every platform when no Arc feed is configured", () => {
    expect(
      resolveDesktopUpdateSupport({
        canReplaceAppImage: alwaysReplaceable,
        env: { APPIMAGE: APP_IMAGE_PATH },
        feedConfigured: false,
        platform: "macos",
      }),
    ).toEqual({ autoUpdate: false, versionCheck: false });
    expect(
      resolveDesktopUpdateSupport({
        canReplaceAppImage: alwaysReplaceable,
        env: { APPIMAGE: APP_IMAGE_PATH },
        feedConfigured: false,
        platform: "linux",
      }),
    ).toEqual({ autoUpdate: false, versionCheck: false });
  });

  it("enables both update paths on macOS once a feed is configured", () => {
    expect(
      resolveDesktopUpdateSupport({
        canReplaceAppImage: neverReplaceable,
        env: {},
        feedConfigured: true,
        platform: "macos",
      }),
    ).toEqual({ autoUpdate: true, versionCheck: true });
  });

  it("installs updates on Linux only inside an AppImage, once a feed is configured", () => {
    expect(
      resolveDesktopUpdateSupport({
        canReplaceAppImage: alwaysReplaceable,
        env: { APPIMAGE: APP_IMAGE_PATH },
        feedConfigured: true,
        platform: "linux",
      }),
    ).toEqual({ autoUpdate: true, versionCheck: true });
    expect(
      resolveDesktopUpdateSupport({
        canReplaceAppImage: alwaysReplaceable,
        env: {},
        feedConfigured: true,
        platform: "linux",
      }),
    ).toEqual({ autoUpdate: false, versionCheck: true });
    expect(
      resolveDesktopUpdateSupport({
        canReplaceAppImage: alwaysReplaceable,
        env: { APPIMAGE: "  " },
        feedConfigured: true,
        platform: "linux",
      }),
    ).toEqual({ autoUpdate: false, versionCheck: true });
  });

  it("refuses to install into an AppImage it cannot replace", () => {
    const checked: Array<string> = [];

    expect(
      resolveDesktopUpdateSupport({
        canReplaceAppImage: (path) => {
          checked.push(path);
          return false;
        },
        env: { APPIMAGE: APP_IMAGE_PATH },
        feedConfigured: true,
        platform: "linux",
      }),
    ).toEqual({ autoUpdate: false, versionCheck: true });
    expect(checked).toEqual([APP_IMAGE_PATH]);
  });

  it("does not consult the filesystem on macOS", () => {
    let consulted = false;

    resolveDesktopUpdateSupport({
      canReplaceAppImage: () => {
        consulted = true;
        return true;
      },
      env: { APPIMAGE: APP_IMAGE_PATH },
      feedConfigured: true,
      platform: "macos",
    });

    expect(consulted).toBe(false);
  });
});
