import { mkdir } from "node:fs/promises";
import type { ArcVoiceboxStageResult } from "./acquire.js";
import {
  activateArcVoiceboxVersion,
  inspectArcVoiceboxInstall,
  promoteArcVoiceboxKnownGood,
  rollbackArcVoiceboxVersion,
  setArcVoiceboxHealthState,
  type RollbackArcVoiceboxResult,
} from "./activation.js";
import { cleanAbandonedArcVoiceStaging } from "./cleanup.js";
import type {
  ArcVoiceCallResult,
  ArcVoiceTranscribeArgs,
  ArcVoiceTranscribeOutput,
} from "./client.js";
import {
  readVoiceRuntimeManifest,
  type ArcVoiceboxHealthState,
  type VoiceRuntimeManifestSource,
} from "./manifest.js";
import type { ArcVoicePaths } from "./paths.js";
import type { ArcVoiceboxRelease } from "./release.js";
import { voiceboxReleaseAvailability } from "./release.js";
import type {
  ArcVoiceLaunchConfig,
  ArcVoiceRuntimeExitEvent,
  ArcVoiceRuntimeManager,
  ArcVoiceStartResult,
  ArcVoiceStopResult,
} from "./runtime-manager.js";
import type { ArcVoiceBackend, ArcVoiceRuntimeState } from "./types.js";

export type ArcVoiceboxStager = (args: {
  release: ArcVoiceboxRelease;
  stagingDir: string;
}) => Promise<ArcVoiceboxStageResult>;

export interface ArcVoiceRuntimeReport {
  state: ArcVoiceRuntimeState;
  version: string | null;
  knownGoodVersion: string | null;
  rollbackAvailable: boolean;
  installPath: string | null;
  healthState: ArcVoiceboxHealthState;
  running: boolean;
  pid?: number;
  lastError?: string;
}

export type ArcVoicePrepareResult =
  | { kind: "ready"; version: string; detail: string }
  | { kind: "unsupported-platform"; detail: string }
  | { kind: "failed"; detail: string };

export type ArcVoiceRepairResult =
  | { kind: "reinstalled"; version: string; detail: string }
  | { kind: "healthy"; version: string; detail: string }
  | { kind: "installed"; version: string; detail: string }
  | { kind: "failed"; detail: string };

export type ArcVoiceUpdateResult =
  | { kind: "updated"; version: string; detail: string }
  | { kind: "up-to-date"; version: string }
  | { kind: "rolled-back"; from: string; to: string; detail: string }
  | { kind: "failed"; detail: string };

export interface ArcVoiceRuntimeServiceArgs {
  paths: ArcVoicePaths;
  release: ArcVoiceboxRelease;
  manager: ArcVoiceRuntimeManager;
  stage: ArcVoiceboxStager;
  backend: ArcVoiceBackend;
  port: number;
  createdByArcVersion: string;
  source?: VoiceRuntimeManifestSource;
  platform?: NodeJS.Platform;
  arch?: string;
  now?: () => number;
  startupCheckTimeoutMs?: number;
  startupCheckIntervalMs?: number;
}

const DEFAULT_STARTUP_CHECK_TIMEOUT_MS = 30_000;

export const CANCELLED_TRANSCRIPTION_MESSAGE =
  "voice transcription was cancelled";

export async function ensureArcVoiceDirectories(
  paths: ArcVoicePaths,
): Promise<void> {
  await mkdir(paths.modelsRoot, { recursive: true });
  await mkdir(paths.dataDir, { recursive: true });
  await mkdir(paths.tempRoot, { recursive: true });
}

export class ArcVoiceRuntimeService {
  readonly #paths: ArcVoicePaths;
  readonly #release: ArcVoiceboxRelease;
  readonly #manager: ArcVoiceRuntimeManager;
  readonly #stage: ArcVoiceboxStager;
  readonly #backend: ArcVoiceBackend;
  readonly #port: number;
  readonly #createdByArcVersion: string;
  readonly #source: VoiceRuntimeManifestSource;
  readonly #platform: NodeJS.Platform;
  readonly #arch: string;
  readonly #now: () => number;
  readonly #startupCheckTimeoutMs: number;
  readonly #startupCheckIntervalMs: number | undefined;

  #transient: "updating" | "repairing" | null = null;

  constructor(args: ArcVoiceRuntimeServiceArgs) {
    this.#paths = args.paths;
    this.#release = args.release;
    this.#manager = args.manager;
    this.#stage = args.stage;
    this.#backend = args.backend;
    this.#port = args.port;
    this.#createdByArcVersion = args.createdByArcVersion;
    this.#source = args.source ?? "arc-bundled";
    this.#platform = args.platform ?? process.platform;
    this.#arch = args.arch ?? process.arch;
    this.#now = args.now ?? Date.now;
    this.#startupCheckTimeoutMs =
      args.startupCheckTimeoutMs ?? DEFAULT_STARTUP_CHECK_TIMEOUT_MS;
    this.#startupCheckIntervalMs = args.startupCheckIntervalMs;
  }

  #installArgs(): {
    release: ArcVoiceboxRelease;
    paths: ArcVoicePaths;
    createdByArcVersion: string;
    platform: string;
    arch: string;
  } {
    return {
      release: this.#release,
      paths: this.#paths,
      createdByArcVersion: this.#createdByArcVersion,
      platform: `${this.#platform}-${this.#arch}`,
      arch: this.#arch,
    };
  }

  #launchConfig(): ArcVoiceLaunchConfig {
    return {
      command: this.#paths.executablePath,
      port: this.#port,
      backend: this.#backend,
      modelsDir: this.#paths.modelsRoot,
      dataDir: this.#paths.dataDir,
      cwd: this.#paths.activeRoot,
    };
  }

  async status(): Promise<ArcVoiceRuntimeReport> {
    const read = await readVoiceRuntimeManifest({
      manifestPath: this.#paths.manifestPath,
      createdByArcVersion: this.#createdByArcVersion,
      platform: `${this.#platform}-${this.#arch}`,
      arch: this.#arch,
    });
    const runtime = this.#manager.status();
    const activeVersion =
      read.kind === "ok" ? read.manifest.activeVersion : null;
    const install = await inspectArcVoiceboxInstall(this.#installArgs());
    const installed = install.kind === "installed";

    const state: ArcVoiceRuntimeState =
      this.#transient !== null
        ? this.#transient
        : runtime.state === "starting" || runtime.state === "ready"
          ? runtime.state
          : runtime.state === "failed"
            ? "failed"
            : installed
              ? "stopped"
              : "not-installed";

    const report: ArcVoiceRuntimeReport = {
      state,
      version: installed ? install.version : activeVersion,
      knownGoodVersion:
        read.kind === "ok" ? read.manifest.knownGoodVersion : null,
      rollbackAvailable:
        read.kind === "ok" &&
        read.manifest.knownGoodVersion !== null &&
        read.manifest.knownGoodVersion !== read.manifest.activeVersion,
      installPath: installed ? install.executablePath : null,
      healthState: read.kind === "ok" ? read.manifest.healthState : "unknown",
      running: runtime.state === "ready" || runtime.state === "starting",
    };
    return {
      ...report,
      ...(runtime.pid === undefined ? {} : { pid: runtime.pid }),
      ...(runtime.lastError === undefined
        ? {}
        : { lastError: runtime.lastError }),
      ...(runtime.lastError === undefined && install.kind === "drift"
        ? { lastError: install.reason }
        : {}),
    };
  }

  async prepare(): Promise<ArcVoicePrepareResult> {
    await cleanAbandonedArcVoiceStaging(this.#paths);
    const install = await inspectArcVoiceboxInstall(this.#installArgs());
    if (install.kind === "installed") {
      return {
        kind: "ready",
        version: install.version,
        detail: `voice runtime ${install.version} is installed at ${install.executablePath}`,
      };
    }

    return this.#installFromStager();
  }

  async #installFromStager(): Promise<ArcVoicePrepareResult> {
    const availability = voiceboxReleaseAvailability(this.#release, {
      platform: this.#platform,
      arch: this.#arch,
    });
    if (availability.kind === "unsupported-platform") {
      return {
        kind: "unsupported-platform",
        detail: `Voicebox ${this.#release.version} is pinned for ${availability.pinned}; this machine is ${availability.current}`,
      };
    }

    const stagingDir = this.#paths.stagingVersionRoot(this.#release.version);
    let staged: ArcVoiceboxStageResult;
    try {
      staged = await this.#stage({ release: this.#release, stagingDir });
    } catch (error) {
      return {
        kind: "failed",
        detail: `voice runtime staging failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (staged.kind === "rejected") {
      return { kind: "failed", detail: staged.reason };
    }

    const activated = await activateArcVoiceboxVersion({
      ...this.#installArgs(),
      version: staged.version,
      digest: staged.digest,
      stagedExecutablePath: staged.executablePath,
      source: this.#source,
      now: this.#now,
    });
    await cleanAbandonedArcVoiceStaging(this.#paths);
    if (activated.kind === "failed") {
      return { kind: "failed", detail: activated.reason };
    }
    return {
      kind: "ready",
      version: activated.version,
      detail: `voice runtime ${activated.version} activated at ${this.#paths.executablePath}`,
    };
  }

  async start(): Promise<ArcVoiceStartResult> {
    const prepared = await this.prepare();
    if (prepared.kind !== "ready") {
      return { kind: "failed", detail: prepared.detail };
    }

    await ensureArcVoiceDirectories(this.#paths);
    const started = await this.#manager.start(this.#launchConfig(), {
      timeoutMs: this.#startupCheckTimeoutMs,
      ...(this.#startupCheckIntervalMs === undefined
        ? {}
        : { intervalMs: this.#startupCheckIntervalMs }),
    });

    if (started.kind === "ready") {
      await promoteArcVoiceboxKnownGood({
        paths: this.#paths,
        createdByArcVersion: this.#createdByArcVersion,
        platform: `${this.#platform}-${this.#arch}`,
        arch: this.#arch,
      });
      await setArcVoiceboxHealthState({
        ...this.#installArgs(),
        healthState: "healthy",
      });
      return started;
    }

    await setArcVoiceboxHealthState({
      ...this.#installArgs(),
      healthState: "unhealthy",
    });
    return started;
  }

  async stop(): Promise<ArcVoiceStopResult> {
    const result = await this.#manager.stop();
    await cleanAbandonedArcVoiceStaging(this.#paths);
    return result;
  }

  async transcribe(
    args: ArcVoiceTranscribeArgs,
  ): Promise<ArcVoiceCallResult<ArcVoiceTranscribeOutput>> {
    const isAborted = (): boolean => args.signal?.aborted === true;
    if (isAborted()) {
      return { kind: "error", message: CANCELLED_TRANSCRIPTION_MESSAGE };
    }

    if (this.#manager.status().state !== "ready") {
      const started = await this.start();
      if (started.kind !== "ready") {
        return {
          kind: "error",
          message: `voice runtime is unavailable: ${started.detail}`,
        };
      }
    }

    if (isAborted()) {
      return { kind: "error", message: CANCELLED_TRANSCRIPTION_MESSAGE };
    }
    return this.#manager.transcribe(args);
  }

  async recordRuntimeExit(
    event: ArcVoiceRuntimeExitEvent,
  ): Promise<ArcVoiceboxHealthState> {
    const healthState: ArcVoiceboxHealthState = event.restarting
      ? "unknown"
      : "unhealthy";
    await setArcVoiceboxHealthState({
      ...this.#installArgs(),
      healthState,
    });
    return healthState;
  }

  async repair(): Promise<ArcVoiceRepairResult> {
    this.#transient = "repairing";
    try {
      const install = await inspectArcVoiceboxInstall(this.#installArgs());
      if (install.kind !== "installed") {
        const reinstalled = await this.#installFromStager();
        return reinstalled.kind === "ready"
          ? {
              kind: "reinstalled",
              version: reinstalled.version,
              detail: `${install.kind}: ${install.reason}`,
            }
          : { kind: "failed", detail: reinstalled.detail };
      }

      if (this.#manager.status().state !== "ready") {
        return {
          kind: "installed",
          version: install.version,
          detail: `voice runtime ${install.version} is installed and verified; it is not running`,
        };
      }

      const probed = await this.#manager.recheckHealth();
      if (probed.state === "ready") {
        await promoteArcVoiceboxKnownGood({
          paths: this.#paths,
          createdByArcVersion: this.#createdByArcVersion,
          platform: `${this.#platform}-${this.#arch}`,
          arch: this.#arch,
        });
        await setArcVoiceboxHealthState({
          ...this.#installArgs(),
          healthState: "healthy",
        });
        return {
          kind: "healthy",
          version: install.version,
          detail: `voice runtime ${install.version} answered its health probe`,
        };
      }

      await setArcVoiceboxHealthState({
        ...this.#installArgs(),
        healthState: "unhealthy",
      });
      return {
        kind: "failed",
        detail: probed.lastError ?? "voice runtime is not healthy",
      };
    } finally {
      this.#transient = null;
    }
  }

  async update(): Promise<ArcVoiceUpdateResult> {
    this.#transient = "updating";
    try {
      const install = await inspectArcVoiceboxInstall(this.#installArgs());
      if (install.kind === "installed") {
        return { kind: "up-to-date", version: install.version };
      }

      const installed = await this.#installFromStager();
      if (installed.kind !== "ready") {
        return { kind: "failed", detail: installed.detail };
      }

      await ensureArcVoiceDirectories(this.#paths);
      const started = await this.#manager.start(this.#launchConfig(), {
        timeoutMs: this.#startupCheckTimeoutMs,
        ...(this.#startupCheckIntervalMs === undefined
          ? {}
          : { intervalMs: this.#startupCheckIntervalMs }),
      });
      if (started.kind === "ready") {
        await promoteArcVoiceboxKnownGood({
          paths: this.#paths,
          createdByArcVersion: this.#createdByArcVersion,
          platform: `${this.#platform}-${this.#arch}`,
          arch: this.#arch,
        });
        await setArcVoiceboxHealthState({
          ...this.#installArgs(),
          healthState: "healthy",
        });
        return {
          kind: "updated",
          version: installed.version,
          detail: started.detail,
        };
      }

      await setArcVoiceboxHealthState({
        ...this.#installArgs(),
        healthState: "unhealthy",
      });
      await this.#manager.stop();
      const rolledBack = await this.rollback();
      return rolledBack.kind === "rolled-back"
        ? {
            kind: "rolled-back",
            from: rolledBack.from,
            to: rolledBack.to,
            detail: started.detail,
          }
        : {
            kind: "failed",
            detail: `${started.detail}; rollback ${rolledBack.kind}: ${rolledBack.reason}`,
          };
    } finally {
      this.#transient = null;
    }
  }

  async rollback(): Promise<RollbackArcVoiceboxResult> {
    const runtime = this.#manager.status();
    if (runtime.state === "ready" || runtime.state === "starting") {
      return {
        kind: "failed",
        reason: "refusing to roll back while the voice runtime is running",
      };
    }
    return rollbackArcVoiceboxVersion({
      ...this.#installArgs(),
      now: this.#now,
    });
  }
}
