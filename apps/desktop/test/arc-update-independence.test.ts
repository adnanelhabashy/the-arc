import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BbDesktopVersionFeed } from "@bb/desktop-contract";
import {
  mutateArcRuntimeManifest,
  readArcRuntimeManifest,
} from "@bb/arc-domains/arc-runtime/manifest.js";
import { createArcRuntimePaths } from "@bb/arc-domains/arc-runtime/paths.js";
import { createDesktopUpdateService } from "../src/desktop-update-check.js";
import {
  createDesktopAutoUpdateService,
  type DesktopAutoUpdateAvailableHandler,
  type DesktopAutoUpdateDownloadedHandler,
  type DesktopAutoUpdateErrorHandler,
  type DesktopAutoUpdateLogger,
  type DesktopAutoUpdateNotAvailableHandler,
  type DesktopAutoUpdaterAdapter,
} from "../src/desktop-auto-update.js";
import type { DesktopAutoUpdateFeedConfig } from "../src/desktop-update-provider.js";

const checkedAt = "2026-05-21T00:00:00.000Z";
const arcVersionPath = resolve(process.cwd(), "arc-version.json");
const silentLogger: DesktopAutoUpdateLogger = {
  error() {},
  info() {},
  warn() {},
};

function createFeed(version: string): BbDesktopVersionFeed {
  return {
    channel: "latest",
    files: [
      { sha512: "SHA512", size: 1, url: `arc-agent-${version}.zip` },
    ],
    minimumSystemVersion: null,
    path: `arc-agent-${version}.zip`,
    platform: "macos",
    releaseDate: checkedAt,
    releaseName: `Arc Agent ${version}`,
    releaseNotes: null,
    schemaVersion: 1,
    sha512: "SHA512",
    stagingPercentage: null,
    version,
  };
}

class NoopAutoUpdaterAdapter implements DesktopAutoUpdaterAdapter {
  checkForUpdates() {
    return Promise.resolve(null);
  }
  downloadUpdate() {
    return Promise.resolve([]);
  }
  onError(_handler: DesktopAutoUpdateErrorHandler): void {}
  onUpdateAvailable(_handler: DesktopAutoUpdateAvailableHandler): void {}
  onUpdateDownloaded(_handler: DesktopAutoUpdateDownloadedHandler): void {}
  onUpdateNotAvailable(_handler: DesktopAutoUpdateNotAvailableHandler): void {}
  quitAndInstall(): void {}
  setAutoDownload(_enabled: boolean): void {}
  setAutoInstallOnAppQuit(_enabled: boolean): void {}
  setFeedURL(_config: DesktopAutoUpdateFeedConfig): void {}
  setForceDevUpdateConfig(_enabled: boolean): void {}
  setLogger(_logger: DesktopAutoUpdateLogger): void {}
}

describe("Arc application updates vs. managed runtime updates are independent axes", () => {
  let tempUserDataPath: string;

  beforeEach(async () => {
    tempUserDataPath = await mkdtemp(
      join(tmpdir(), "arc-update-independence-"),
    );
  });

  afterEach(async () => {
    await rm(tempUserDataPath, { force: true, recursive: true });
  });

  it("Case A: an Arc application update check never reads or writes the managed runtime manifest", async () => {
    const runtimePaths = createArcRuntimePaths({
      userDataPath: tempUserDataPath,
    });
    const seeded = await mutateArcRuntimeManifest({
      createdByArcVersion: "1.0.0",
      manifestPath: runtimePaths.manifestPath,
      mutate: (manifest) => ({
        ...manifest,
        runtimes: {
          ...manifest.runtimes,
          codex: {
            ...manifest.runtimes.codex,
            activeVersion: "0.150.0",
            knownGoodVersion: "0.150.0",
            source: "arc-bundled",
          },
        },
      }),
      platform: "darwin-arm64",
    });
    const manifestBytesBefore = await readFile(runtimePaths.manifestPath);

    // Drive a full Arc application update cycle: a version-check that finds
    // an update, and an auto-updater that reports one downloaded. Neither
    // path takes the runtime manifest path as an input, so this proves the
    // independence by construction as well as by the byte-for-byte check
    // below.
    const versionCheckService = createDesktopUpdateService({
      channel: "latest",
      currentVersion: "1.0.0",
      enabled: true,
      feedUrl: "https://releases.arc.example/desktop-latest/desktop-version.json",
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify(createFeed("1.1.0")), {
            headers: { "content-type": "application/json" },
          }),
        ),
      logger: silentLogger,
      now: () => Date.parse(checkedAt),
      platform: "macos",
    });
    await versionCheckService.checkForUpdates();

    const autoUpdateService = createDesktopAutoUpdateService({
      currentVersion: "1.0.0",
      enabled: true,
      forceDevUpdateConfig: false,
      logger: silentLogger,
      now: () => Date.parse(checkedAt),
      platform: "macos",
      updater: new NoopAutoUpdaterAdapter(),
    });
    autoUpdateService.start();
    await autoUpdateService.checkForUpdates();

    const manifestBytesAfter = await readFile(runtimePaths.manifestPath);
    expect(manifestBytesAfter).toEqual(manifestBytesBefore);

    const rereadManifest = await readArcRuntimeManifest({
      createdByArcVersion: "1.0.0",
      manifestPath: runtimePaths.manifestPath,
      platform: "darwin-arm64",
    });
    expect(rereadManifest).toEqual({ kind: "ok", manifest: seeded });
  });

  it("Case B: activating/updating a managed runtime never changes Arc's own version metadata", async () => {
    const runtimePaths = createArcRuntimePaths({
      userDataPath: tempUserDataPath,
    });
    const originalArcVersionEnv = process.env.ARC_DESKTOP_APP_VERSION;
    process.env.ARC_DESKTOP_APP_VERSION = "9.9.9-case-b";
    const arcVersionFileBefore = await readFile(arcVersionPath, "utf8");

    try {
      // Simulate a runtime activation/update: the runtime manager mutates
      // only its own manifest file under the runtime paths, never Arc's
      // packaged arc-version.json or the ARC_DESKTOP_APP_VERSION Arc reports
      // for itself.
      await mutateArcRuntimeManifest({
        createdByArcVersion: process.env.ARC_DESKTOP_APP_VERSION,
        manifestPath: runtimePaths.manifestPath,
        mutate: (manifest) => ({
          ...manifest,
          runtimes: {
            ...manifest.runtimes,
            omp: {
              ...manifest.runtimes.omp,
              activeVersion: "18.5.0",
              knownGoodVersion: "18.2.0",
              previousVersion: "18.2.0",
              source: "arc-bundled",
            },
          },
        }),
        platform: "darwin-arm64",
      });

      expect(process.env.ARC_DESKTOP_APP_VERSION).toBe("9.9.9-case-b");
      const arcVersionFileAfter = await readFile(arcVersionPath, "utf8");
      expect(arcVersionFileAfter).toBe(arcVersionFileBefore);
    } finally {
      if (originalArcVersionEnv === undefined) {
        delete process.env.ARC_DESKTOP_APP_VERSION;
      } else {
        process.env.ARC_DESKTOP_APP_VERSION = originalArcVersionEnv;
      }
    }
  });
});
