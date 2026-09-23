import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { stageArcRuntimeCompanionFromSeed } from "./acquire.js";
import { checkArcRuntimeComponents } from "./components.js";
import { sha256File } from "./digest.js";
import {
  mutateArcRuntimeManifest,
  type ArcRuntimeManifest,
} from "./manifest.js";
import { arcRuntimeExecutableName, type ArcRuntimePaths } from "./paths.js";
import { probeArcRuntimeVersion } from "./probe.js";
import {
  ARC_RUNTIME_RELEASES,
  validateArcRuntimeRelease,
  type ArcRuntimeRelease,
} from "./releases.js";
import type { ArcRuntimeId } from "./types.js";

export type ArcRuntimeBootstrapAction =
  | "installed"
  | "already-active"
  | "repaired"
  | "seed-missing"
  | "kept-existing"
  | "kept-broken"
  | "failed";

export interface ArcRuntimeBootstrapResult {
  runtimeId: ArcRuntimeId;
  action: ArcRuntimeBootstrapAction;
  detail: string;
}

export interface PrepareArcManagedRuntimesArgs {
  createdByArcVersion: string;
  onDiagnostic?: (message: string) => void;
  platform: string;
  releases?: readonly ArcRuntimeRelease[];
  runtimePaths: ArcRuntimePaths;
  seedRoot: string;
}

async function isRunnableExecutable(
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

function diagnose(
  args: PrepareArcManagedRuntimesArgs,
  message: string,
): void {
  args.onDiagnostic?.(`[arc-runtime] ${message}`);
}

interface BootstrapDecision {
  result: ArcRuntimeBootstrapResult;
  manifest: ArcRuntimeManifest;
}

async function installFromSeed(args: {
  manifest: ArcRuntimeManifest;
  release: ArcRuntimeRelease;
  repair: boolean;
  runtimePaths: ArcRuntimePaths;
  seedPath: string;
}): Promise<BootstrapDecision> {
  const { release, runtimePaths, seedPath, manifest, repair } = args;
  const existing = manifest.runtimes[release.runtimeId];
  const isWindows = manifest.platform.startsWith("win32");

  const seedDigest = await sha256File(seedPath).catch(() => null);
  if (seedDigest !== release.executableSha256) {
    return {
      result: {
        runtimeId: release.runtimeId,
        action: "failed",
        detail: `bundled seed digest mismatch: expected ${release.executableSha256}, got ${seedDigest ?? "unreadable"}`,
      },
      manifest,
    };
  }
  const seedProbe = await probeArcRuntimeVersion({ executablePath: seedPath });
  if (
    seedProbe.kind === "failed" ||
    seedProbe.version !== release.expectedExecutableVersion
  ) {
    return {
      result: {
        runtimeId: release.runtimeId,
        action: "failed",
        detail:
          seedProbe.kind === "failed"
            ? `seed version probe failed: ${seedProbe.reason}`
            : `seed reports ${seedProbe.version}, expected ${release.expectedExecutableVersion}`,
      },
      manifest,
    };
  }

  const versionRoot = runtimePaths.versionRoot(
    release.runtimeId,
    release.version,
  );
  await mkdir(runtimePaths.stagingRoot, { recursive: true });
  const stagingDir = join(
    runtimePaths.stagingRoot,
    `${release.runtimeId}-${release.version}-${process.pid}`,
  );
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  try {
    const stagedExecutable = join(
      stagingDir,
      arcRuntimeExecutableName(release.runtimeId),
    );
    await copyFile(seedPath, stagedExecutable);
    await chmod(stagedExecutable, isWindows ? 0o644 : 0o755);

    const stagedDigest = await sha256File(stagedExecutable);
    if (stagedDigest !== release.executableSha256) {
      return {
        result: {
          runtimeId: release.runtimeId,
          action: "failed",
          detail: "copied executable digest mismatch; refusing to activate",
        },
        manifest,
      };
    }
    const components: Record<string, string> = {};
    for (const companion of release.companions ?? []) {
      const companionSeedPath = join(
        dirname(seedPath),
        companion.fileName,
      );
      if (
        !(await isRunnableExecutable(companionSeedPath, isWindows))
      ) {
        return {
          result: {
            runtimeId: release.runtimeId,
            action: "failed",
            detail: `bundled ${companion.fileName} seed not available at ${companionSeedPath}`,
          },
          manifest,
        };
      }
      const stagedCompanion = await stageArcRuntimeCompanionFromSeed({
        companion,
        seedPath: companionSeedPath,
        stagingDir,
        isWindows,
      });
      if (stagedCompanion.kind === "rejected") {
        return {
          result: {
            runtimeId: release.runtimeId,
            action: "failed",
            detail: stagedCompanion.reason,
          },
          manifest,
        };
      }
      components[companion.fileName] = stagedCompanion.digest;
    }
    const stagedProbe = await probeArcRuntimeVersion({
      executablePath: stagedExecutable,
    });
    if (
      stagedProbe.kind === "failed" ||
      stagedProbe.version !== release.expectedExecutableVersion
    ) {
      return {
        result: {
          runtimeId: release.runtimeId,
          action: "failed",
          detail: "copied executable failed version verification",
        },
        manifest,
      };
    }

    await mkdir(dirname(versionRoot), { recursive: true });
    await rm(versionRoot, { recursive: true, force: true });
    await rename(stagingDir, versionRoot);

    return {
      result: {
        runtimeId: release.runtimeId,
        action: repair ? "repaired" : "installed",
        detail: `${release.runtimeId} ${release.version} ${
          repair ? "repaired from" : "installed from"
        } bundled seed (digest ${stagedDigest})`,
      },
      manifest: {
        ...manifest,
        runtimes: {
          ...manifest.runtimes,
          [release.runtimeId]: {
            activeVersion: release.version,
            previousVersion: repair
              ? existing.previousVersion
              : existing.activeVersion,
            knownGoodVersion: release.version,
            source: "arc-bundled",
            digest: stagedDigest,
            componentsByVersion: {
              ...existing.componentsByVersion,
              [release.version]: components,
            },
            installedAt: Date.now(),
          },
        },
      },
    };
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

async function decideBootstrap(
  args: PrepareArcManagedRuntimesArgs,
  release: ArcRuntimeRelease,
  seedPath: string,
  manifest: ArcRuntimeManifest,
): Promise<BootstrapDecision> {
  const isWindows = args.platform.startsWith("win32");
  const entry = manifest.runtimes[release.runtimeId];

  if (entry.activeVersion === release.version) {
    const executablePath = args.runtimePaths.executablePath(
      release.runtimeId,
      release.version,
    );
    const recordedComponents =
      entry.componentsByVersion[release.version] ?? {};
    const componentChecks = await checkArcRuntimeComponents({
      expectations: (release.companions ?? []).map((companion) => ({
        fileName: companion.fileName,
        expectedDigest:
          recordedComponents[companion.fileName] ??
          companion.executableSha256,
      })),
      componentPath: (fileName) =>
        args.runtimePaths.componentPath(
          release.runtimeId,
          release.version,
          fileName,
        ),
      isWindows,
      verifyDigest: false,
    });
    const brokenComponent = componentChecks.find((check) => !check.ok);
    if (await isRunnableExecutable(executablePath, isWindows)) {
      if (brokenComponent !== undefined) {
        diagnose(
          args,
          `${release.runtimeId} ${release.version} is active but ${brokenComponent.detail}; repairing from bundled seed`,
        );
        return installFromSeed({
          manifest,
          release,
          repair: true,
          runtimePaths: args.runtimePaths,
          seedPath,
        });
      }
      if (entry.digest === null) {
        const digest = await sha256File(executablePath).catch(() => null);
        if (digest !== null) {
          return {
            result: {
              runtimeId: release.runtimeId,
              action: "already-active",
              detail: `${release.runtimeId} ${release.version} already active; reusing verified copy`,
            },
            manifest: {
              ...manifest,
              runtimes: {
                ...manifest.runtimes,
                [release.runtimeId]: { ...entry, digest },
              },
            },
          };
        }
      }
      return {
        result: {
          runtimeId: release.runtimeId,
          action: "already-active",
          detail: `${release.runtimeId} ${release.version} already active; reusing verified copy`,
        },
        manifest,
      };
    }
    diagnose(
      args,
      `${release.runtimeId} ${release.version} active in manifest but ${executablePath} is missing or broken; repairing from bundled seed`,
    );
    const decision = await installFromSeed({
      manifest,
      release,
      repair: true,
      runtimePaths: args.runtimePaths,
      seedPath,
    });
    if (decision.result.action === "repaired") {
      return decision;
    }
    return {
      result: {
        runtimeId: release.runtimeId,
        action: "failed",
        detail: `repair failed: ${decision.result.detail}`,
      },
      manifest,
    };
  }

  if (entry.activeVersion !== null) {
    const executablePath = args.runtimePaths.executablePath(
      release.runtimeId,
      entry.activeVersion,
    );
    // A version other than the pin cannot be judged against this pin's
    // digests, so only presence and executability are checked here; the
    // prepare/repair path proves provenance against the right pin.
    const componentChecks = await checkArcRuntimeComponents({
      expectations: (release.companions ?? []).map((companion) => ({
        fileName: companion.fileName,
        expectedDigest: null,
      })),
      componentPath: (fileName) =>
        args.runtimePaths.componentPath(
          release.runtimeId,
          entry.activeVersion ?? release.version,
          fileName,
        ),
      isWindows,
      verifyDigest: false,
    });
    const brokenComponent = componentChecks.find((check) => !check.ok);
    if (
      brokenComponent === undefined &&
      (await isRunnableExecutable(executablePath, isWindows))
    ) {
      return {
        result: {
          runtimeId: release.runtimeId,
          action: "kept-existing",
          detail: `${release.runtimeId} ${entry.activeVersion} is active and valid; bundled seed ${release.version} will not force a downgrade`,
        },
        manifest,
      };
    }
    return {
      result: {
        runtimeId: release.runtimeId,
        action: "kept-broken",
        detail: `${release.runtimeId} ${entry.activeVersion} is active but ${
          brokenComponent?.detail ?? "its executable is broken"
        }; recovery is deferred to the runtime repair/update flow`,
      },
      manifest,
    };
  }

  return installFromSeed({
    manifest,
    release,
    repair: false,
    runtimePaths: args.runtimePaths,
    seedPath,
  });
}

async function bootstrapRelease(
  args: PrepareArcManagedRuntimesArgs,
  release: ArcRuntimeRelease,
  seedPath: string,
): Promise<ArcRuntimeBootstrapResult> {
  const validation = validateArcRuntimeRelease(release);
  if (validation.kind === "invalid") {
    return {
      runtimeId: release.runtimeId,
      action: "failed",
      detail: `invalid pinned release metadata: ${validation.problem}`,
    };
  }

  let outcome: ArcRuntimeBootstrapResult | null = null;
  try {
    await mutateArcRuntimeManifest({
      createdByArcVersion: args.createdByArcVersion,
      manifestPath: args.runtimePaths.manifestPath,
      platform: args.platform,
      mutate: async (manifest) => {
        const decision = await decideBootstrap(args, release, seedPath, manifest);
        outcome = decision.result;
        return decision.manifest;
      },
    });
  } catch (error) {
    return {
      runtimeId: release.runtimeId,
      action: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  return outcome ?? {
    runtimeId: release.runtimeId,
    action: "failed",
    detail: "bootstrap did not produce a result",
  };
}

export async function prepareArcManagedRuntimes(
  args: PrepareArcManagedRuntimesArgs,
): Promise<ArcRuntimeBootstrapResult[]> {
  const results: ArcRuntimeBootstrapResult[] = [];
  const releases = args.releases ?? ARC_RUNTIME_RELEASES;
  for (const release of releases) {
    const seedPath = join(
      args.seedRoot,
      release.runtimeId,
      release.version,
      arcRuntimeExecutableName(release.runtimeId),
    );
    const seedExists = await isRunnableExecutable(
      seedPath,
      args.platform.startsWith("win32"),
    );
    if (!seedExists) {
      diagnose(
        args,
        `bundled ${release.runtimeId} seed not available at ${seedPath}; skipping managed runtime bootstrap`,
      );
      results.push({
        runtimeId: release.runtimeId,
        action: "seed-missing",
        detail: `no bundled seed at ${seedPath}`,
      });
      continue;
    }

    try {
      results.push(await bootstrapRelease(args, release, seedPath));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      diagnose(args, `${release.runtimeId} bootstrap failed: ${detail}`);
      results.push({ runtimeId: release.runtimeId, action: "failed", detail });
    }
  }
  return results;
}
