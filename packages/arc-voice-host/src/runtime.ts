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
  ArcVoiceModelEntry,
  ArcVoicePresetVoice,
  ArcVoiceProfileCreateArgs,
  ArcVoiceProfileDetail,
  ArcVoiceProfileSampleAddArgs,
  ArcVoiceProfileUpdateArgs,
  ArcVoiceSpeakArgs,
  ArcVoiceSpeakOutput,
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

export interface ArcVoiceTtsStatus {
  engine: string;
  size: string;
  downloaded: boolean;
  loaded: boolean;
  downloading: boolean;
  downloadPercent: number | null;
}

export interface ArcVoiceSpeechStatus {
  runtimeState: "stopped" | "starting" | "ready";
  version: string | null;
  speechModelLoaded: boolean;
  voiceModel: ArcVoiceTtsStatus | null;
}

export interface ArcVoiceEngineCapabilities {
  engine: string;
  requiresClonedProfile: boolean;
  presets: readonly ArcVoicePresetVoice[] | null;
  models: readonly ArcVoiceModelState[];
}

export interface ArcVoiceModelState {
  name: string;
  displayName: string;
  downloaded: boolean;
  downloading: boolean;
  loaded: boolean;
  downloadPercent: number | null;
}

export interface ArcVoiceCapabilities {
  runtimeState: "stopped" | "starting" | "ready";
  version: string | null;
  engines: readonly ArcVoiceEngineCapabilities[];
  speechModels: readonly ArcVoiceModelState[];
}

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

export const TIMED_OUT_TRANSCRIPTION_MESSAGE =
  "voice transcription exceeded its time budget";

function cancelledTranscription(): ArcVoiceCallResult<never> {
  return {
    kind: "error",
    code: "aborted",
    message: CANCELLED_TRANSCRIPTION_MESSAGE,
  };
}

function timedOutTranscription(): ArcVoiceCallResult<never> {
  return {
    kind: "error",
    code: "timeout",
    message: TIMED_OUT_TRANSCRIPTION_MESSAGE,
  };
}

export const CANCELLED_SPEAK_MESSAGE = "voice synthesis was cancelled";

export const TIMED_OUT_SPEAK_MESSAGE =
  "voice synthesis exceeded its time budget";

const CAPABILITY_ENGINES: readonly {
  engine: string;
  requiresClonedProfile: boolean;
  models: readonly string[];
}[] = [
  { engine: "kokoro", requiresClonedProfile: false, models: ["kokoro"] },
  {
    engine: "qwen",
    requiresClonedProfile: true,
    models: ["qwen-tts-0.6B", "qwen-tts-1.7B"],
  },
  {
    engine: "qwen_custom_voice",
    requiresClonedProfile: false,
    models: ["qwen-custom-voice-0.6B", "qwen-custom-voice-1.7B"],
  },
];

function cancelledSpeak(): ArcVoiceCallResult<never> {
  return {
    kind: "error",
    code: "aborted",
    message: CANCELLED_SPEAK_MESSAGE,
  };
}

function timedOutSpeak(): ArcVoiceCallResult<never> {
  return {
    kind: "error",
    code: "timeout",
    message: TIMED_OUT_SPEAK_MESSAGE,
  };
}

function settleWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  onAbort: () => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAborted = (): void => {
      signal.removeEventListener("abort", onAborted);
      resolve(onAbort());
    };
    signal.addEventListener("abort", onAborted, { once: true });
    if (signal.aborted) {
      onAborted();
      return;
    }
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAborted);
        if (signal.aborted) {
          resolve(onAbort());
          return;
        }
        reject(error);
      },
    );
  });
}

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
    if (args.signal?.aborted === true) {
      return cancelledTranscription();
    }

    const deadline =
      args.timeoutMs === undefined
        ? undefined
        : AbortSignal.timeout(args.timeoutMs);
    const signal =
      deadline === undefined
        ? args.signal
        : AbortSignal.any([
            ...(args.signal === undefined ? [] : [args.signal]),
            deadline,
          ]);
    const operation = this.#transcribeWithinBudget(args, signal);
    if (signal === undefined || signal === args.signal) {
      return operation;
    }
    return settleWithAbort(operation, signal, () =>
      deadline?.aborted === true
        ? timedOutTranscription()
        : cancelledTranscription(),
    );
  }

  async #transcribeWithinBudget(
    args: ArcVoiceTranscribeArgs,
    signal: AbortSignal | undefined,
  ): Promise<ArcVoiceCallResult<ArcVoiceTranscribeOutput>> {
    if (this.#manager.status().state !== "ready") {
      const started = await this.start();
      if (started.kind !== "ready") {
        return {
          kind: "error",
          code: "unavailable",
          message: `voice runtime is unavailable: ${started.detail}`,
        };
      }
    }

    if (signal?.aborted === true) {
      return cancelledTranscription();
    }
    return this.#manager.transcribe(
      signal === undefined ? args : { ...args, signal },
    );
  }

  async speechStatus(): Promise<ArcVoiceCallResult<ArcVoiceSpeechStatus>> {
    const managerState = this.#manager.status().state;
    const runtimeState: ArcVoiceSpeechStatus["runtimeState"] =
      managerState === "starting"
        ? "starting"
        : managerState === "ready"
          ? "ready"
          : "stopped";
    const version = (await this.status()).version;

    if (runtimeState !== "ready") {
      return {
        kind: "ok",
        value: {
          runtimeState,
          version,
          speechModelLoaded: false,
          voiceModel: null,
        },
      };
    }

    const models = await this.#manager.modelStatus();
    if (models.kind === "error") {
      return {
        kind: "ok",
        value: {
          runtimeState,
          version,
          speechModelLoaded: false,
          voiceModel: null,
        },
      };
    }

    const voice = models.value.voice;
    let downloadPercent: number | null = null;
    if (voice !== null && voice.downloading) {
      const progress = await this.#manager.voiceModelProgress(voice.modelName);
      downloadPercent = progress.kind === "ok" ? progress.value : null;
    }

    return {
      kind: "ok",
      value: {
        runtimeState,
        version,
        speechModelLoaded: models.value.speech.loaded,
        voiceModel:
          voice === null
            ? null
            : {
                engine: voice.engine,
                size: voice.size,
                downloaded: voice.downloaded,
                loaded: voice.loaded,
                downloading: voice.downloading,
                downloadPercent,
              },
      },
    };
  }

  async speak(
    args: ArcVoiceSpeakArgs,
  ): Promise<ArcVoiceCallResult<ArcVoiceSpeakOutput>> {
    if (args.signal?.aborted === true) {
      return cancelledSpeak();
    }

    const deadline =
      args.timeoutMs === undefined
        ? undefined
        : AbortSignal.timeout(args.timeoutMs);
    const signal =
      deadline === undefined
        ? args.signal
        : AbortSignal.any([
            ...(args.signal === undefined ? [] : [args.signal]),
            deadline,
          ]);
    this.#inFlightSpeaks += 1;
    const operation = this.#speakWithinBudget(args, signal).finally(() => {
      this.#inFlightSpeaks -= 1;
      if (this.#inFlightSpeaks === 0) {
        const listeners = this.#speakSettledListeners;
        this.#speakSettledListeners = [];
        for (const listener of listeners) {
          listener();
        }
      }
    });
    if (signal === undefined || signal === args.signal) {
      return operation;
    }
    return settleWithAbort(operation, signal, () =>
      deadline?.aborted === true ? timedOutSpeak() : cancelledSpeak(),
    );
  }

  async #speakWithinBudget(
    args: ArcVoiceSpeakArgs,
    signal: AbortSignal | undefined,
  ): Promise<ArcVoiceCallResult<ArcVoiceSpeakOutput>> {
    if (this.#manager.status().state !== "ready") {
      const started = await this.start();
      if (started.kind !== "ready") {
        return {
          kind: "error",
          code: "unavailable",
          message: `voice runtime is unavailable: ${started.detail}`,
        };
      }
    }

    if (signal?.aborted === true) {
      return cancelledSpeak();
    }
    return this.#manager.speak(signal === undefined ? args : { ...args, signal });
  }

  async #ensureStarted(
    signal?: AbortSignal,
  ): Promise<ArcVoiceCallResult<never> | null> {
    const isAborted = (): boolean => signal?.aborted === true;
    if (isAborted()) {
      return {
        kind: "error",
        code: "aborted",
        message: "voice operation was cancelled",
      };
    }
    if (this.#manager.status().state !== "ready") {
      const started = await this.start();
      if (started.kind !== "ready") {
        return {
          kind: "error",
          code: "unavailable",
          message: `voice runtime is unavailable: ${started.detail}`,
        };
      }
    }
    if (isAborted()) {
      return {
        kind: "error",
        code: "aborted",
        message: "voice operation was cancelled",
      };
    }
    return null;
  }

  async listProfileDetails(options?: {
    signal?: AbortSignal;
  }): Promise<ArcVoiceCallResult<readonly ArcVoiceProfileDetail[]>> {
    const failed = await this.#ensureStarted(options?.signal);
    if (failed !== null) {
      return failed;
    }
    return this.#manager.listProfileDetails(options);
  }

  async createProfile(
    args: ArcVoiceProfileCreateArgs,
  ): Promise<ArcVoiceCallResult<ArcVoiceProfileDetail>> {
    const failed = await this.#ensureStarted(args.signal);
    if (failed !== null) {
      return failed;
    }
    return this.#manager.createProfile(args);
  }

  async updateProfile(
    profileId: string,
    args: ArcVoiceProfileUpdateArgs,
  ): Promise<ArcVoiceCallResult<ArcVoiceProfileDetail>> {
    const failed = await this.#ensureStarted(args.signal);
    if (failed !== null) {
      return failed;
    }
    return this.#manager.updateProfile(profileId, args);
  }

  async deleteProfile(
    profileId: string,
  ): Promise<ArcVoiceCallResult<void>> {
    const failed = await this.#ensureStarted();
    if (failed !== null) {
      return failed;
    }
    return this.#manager.deleteProfile(profileId);
  }

  async addProfileSample(
    args: ArcVoiceProfileSampleAddArgs,
  ): Promise<ArcVoiceCallResult<string>> {
    const failed = await this.#ensureStarted(args.signal);
    if (failed !== null) {
      return failed;
    }
    return this.#manager.addProfileSample(args);
  }

  async removeProfileSample(
    sampleId: string,
  ): Promise<ArcVoiceCallResult<void>> {
    const failed = await this.#ensureStarted();
    if (failed !== null) {
      return failed;
    }
    return this.#manager.removeProfileSample(sampleId);
  }

  async capabilities(
    options?: { signal?: AbortSignal },
  ): Promise<ArcVoiceCallResult<ArcVoiceCapabilities>> {
    const failed = await this.#ensureStarted(options?.signal);
    if (failed !== null) {
      return failed;
    }

    const report = await this.status();
    const runtimeState: ArcVoiceCapabilities["runtimeState"] =
      this.#manager.status().state === "ready"
        ? "ready"
        : this.#manager.status().state === "starting"
          ? "starting"
          : "stopped";

    const models = await this.#manager.listModels();
    if (models.kind === "error") {
      return models;
    }
    const byName = new Map(models.value.map((entry) => [entry.name, entry]));

    const withProgress = async (
      entry: ArcVoiceModelEntry,
    ): Promise<ArcVoiceModelState> => {
      let downloadPercent: number | null = null;
      if (entry.downloading) {
        const progress = await this.#manager.voiceModelProgress(entry.name);
        downloadPercent = progress.kind === "ok" ? progress.value : null;
      }
      return {
        name: entry.name,
        displayName: entry.displayName,
        downloaded: entry.downloaded,
        downloading: entry.downloading,
        loaded: entry.loaded,
        downloadPercent,
      };
    };

    const engines: ArcVoiceEngineCapabilities[] = [];
    for (const spec of CAPABILITY_ENGINES) {
      const presets = await this.#manager.listPresets(spec.engine);
      const modelStates: ArcVoiceModelState[] = [];
      for (const modelName of spec.models) {
        const entry = byName.get(modelName);
        if (entry !== undefined) {
          modelStates.push(await withProgress(entry));
        }
      }
      engines.push({
        engine: spec.engine,
        requiresClonedProfile: spec.requiresClonedProfile,
        presets:
          spec.requiresClonedProfile && presets.kind !== "ok"
            ? null
            : presets.kind === "ok"
              ? presets.value
              : [],
        models: modelStates,
      });
    }

    const speechModels: ArcVoiceModelState[] = [];
    for (const entry of models.value) {
      if (entry.name.startsWith("whisper-")) {
        speechModels.push(await withProgress(entry));
      }
    }

    return {
      kind: "ok",
      value: { runtimeState, version: report.version, engines, speechModels },
    };
  }

  async downloadModel(
    modelName: string,
    signal?: AbortSignal,
  ): Promise<ArcVoiceCallResult<void>> {
    const failed = await this.#ensureStarted(signal);
    if (failed !== null) {
      return failed;
    }
    return this.#manager.downloadModel(modelName, signal);
  }

  async cancelModelDownload(
    modelName: string,
  ): Promise<ArcVoiceCallResult<void>> {
    const failed = await this.#ensureStarted();
    if (failed !== null) {
      return failed;
    }
    return this.#manager.cancelModelDownload(modelName);
  }

  async prepareForSpeech(options?: {
    signal?: AbortSignal;
  }): Promise<ArcVoiceCallResult<{ runtimeState: "ready" | "starting" }>> {
    const failed = await this.#ensureStarted(options?.signal);
    if (failed !== null) {
      return failed;
    }
    return {
      kind: "ok",
      value: {
        runtimeState:
          this.#manager.status().state === "ready" ? "ready" : "starting",
      },
    };
  }

  async release(options?: {
    signal?: AbortSignal;
  }): Promise<ArcVoiceCallResult<{ runtimeState: "stopped" | "not-running" }>> {
    if (this.#manager.status().state === "stopped") {
      return { kind: "ok", value: { runtimeState: "not-running" } };
    }
    // Best-effort model unload first (frees RAM/VRAM before the process exits);
    // failures are ignored because stopping the process releases everything anyway.
    await this.#manager.unloadModels({ signal: options?.signal });
    await this.#manager.stop();
    return { kind: "ok", value: { runtimeState: "stopped" } };
  }

  async unloadModels(options?: {
    signal?: AbortSignal;
  }): Promise<ArcVoiceCallResult<void>> {
    if (this.#manager.status().state !== "ready") {
      return { kind: "ok", value: undefined };
    }
    // Never unload underneath an active synthesis: a speak that started just as
    // the previous one finished would otherwise lose its models mid-request.
    // Wait briefly; if the speak is still running, skip this unload entirely.
    if (this.#inFlightSpeaks > 0) {
      const drained = await this.#waitForSpeaksToSettle(2_000, options?.signal);
      if (!drained || this.#inFlightSpeaks > 0) {
        return { kind: "ok", value: undefined };
      }
    }
    return this.#manager.unloadModels({ signal: options?.signal });
  }

  #inFlightSpeaks = 0;
  #speakSettledListeners: (() => void)[] = [];

  #waitForSpeaksToSettle(
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    if (this.#inFlightSpeaks === 0) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const finish = (settled: boolean): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const index = this.#speakSettledListeners.indexOf(listener);
        if (index >= 0) {
          this.#speakSettledListeners.splice(index, 1);
        }
        resolve(settled);
      };
      const listener = (): void => finish(true);
      const onAbort = (): void => finish(false);
      const timer = setTimeout(() => finish(false), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#speakSettledListeners.push(listener);
    });
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
