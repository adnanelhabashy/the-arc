import {
  ARC_VOICE_LOOPBACK_HOST,
  assertArcVoicePort,
  assertLoopbackHost,
} from "./binding.js";
import type {
  ArcVoiceCallResult,
  ArcVoiceClient,
  ArcVoiceProfile,
  ArcVoiceSpeakArgs,
  ArcVoiceSpeakOutput,
  ArcVoiceTranscribeArgs,
  ArcVoiceTranscribeOutput,
} from "./client.js";
import {
  defaultArcVoiceSleep,
  waitForArcVoiceReady,
  type ArcVoiceHealthResult,
  type ArcVoiceReadinessResult,
} from "./health.js";
import type { ArcVoiceProcess, ArcVoiceProcessSpawner } from "./process.js";
import type { ArcVoiceBackend, ArcVoiceRuntimeStatus } from "./types.js";

export const VOICEBOX_MODELS_DIR_ENV = "VOICEBOX_MODELS_DIR";
export const VOICEBOX_BACKEND_VARIANT_ENV = "VOICEBOX_BACKEND_VARIANT";

const DEFAULT_GRACEFUL_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_FORCE_STOP_TIMEOUT_MS = 2_000;
const DEFAULT_RESTART_READY_TIMEOUT_MS = 30_000;

const VOICEBOX_BACKEND_VARIANTS: Readonly<
  Partial<Record<ArcVoiceBackend, string>>
> = {
  cuda: "cuda",
  rocm: "rocm",
};

export function resolveVoiceboxBackendVariant(
  backend: ArcVoiceBackend,
): string | undefined {
  return VOICEBOX_BACKEND_VARIANTS[backend];
}

export interface ArcVoiceLaunchConfig {
  command: string;
  port: number;
  backend: ArcVoiceBackend;
  modelsDir: string;
  dataDir?: string;
  host?: string;
  cwd?: string;
  parentPid?: number;
  parentWatchdog?: boolean;
  extraArgs?: readonly string[];
  extraEnv?: NodeJS.ProcessEnv;
}

export type ArcVoiceLaunchResult =
  | { kind: "launched"; detail: string; pid?: number }
  | { kind: "failed"; detail: string };

export type ArcVoiceStartResult =
  | { kind: "ready"; detail: string }
  | { kind: "timeout"; detail: string }
  | { kind: "failed"; detail: string };

export type ArcVoiceStopResult =
  | { kind: "stopped"; detail: string }
  | { kind: "killed"; detail: string }
  | { kind: "not-running"; detail: string };

export function buildVoiceboxLaunchArgs(
  config: ArcVoiceLaunchConfig,
): string[] {
  const host = assertLoopbackHost(config.host ?? ARC_VOICE_LOOPBACK_HOST);
  return [
    "--host",
    host,
    "--port",
    String(assertArcVoicePort(config.port)),
    ...(config.dataDir === undefined ? [] : ["--data-dir", config.dataDir]),
    ...(config.parentPid === undefined
      ? []
      : ["--parent-pid", String(config.parentPid)]),
    ...(config.extraArgs ?? []),
  ];
}

export function buildVoiceboxEnvironment(
  config: ArcVoiceLaunchConfig,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const variant = resolveVoiceboxBackendVariant(config.backend);
  return {
    ...base,
    [VOICEBOX_MODELS_DIR_ENV]: config.modelsDir,
    ...(variant === undefined
      ? {}
      : { [VOICEBOX_BACKEND_VARIANT_ENV]: variant }),
    ...(config.extraEnv ?? {}),
  };
}

export interface ArcVoiceOrphanGuardTarget {
  pid: number;
  kill: (signal: NodeJS.Signals) => boolean;
  isAlive?: () => boolean;
}

export interface ArcVoiceOrphanGuard {
  track(target: ArcVoiceOrphanGuardTarget): number;
  trackedPid(): number | undefined;
  killTracked(signal?: NodeJS.Signals): boolean;
  release(token: number): void;
  dispose(): void;
}

export interface CreateArcVoiceOrphanGuardArgs {
  signal?: NodeJS.Signals;
  subscribeExit?: (listener: () => void) => () => void;
}

export function createArcVoiceOrphanGuard(
  args: CreateArcVoiceOrphanGuardArgs = {},
): ArcVoiceOrphanGuard {
  const signal = args.signal ?? "SIGKILL";
  const subscribeExit =
    args.subscribeExit ??
    ((listener: () => void): (() => void) => {
      process.on("exit", listener);
      return () => {
        process.off("exit", listener);
      };
    });

  let token = 0;
  let tracked: ({ token: number } & ArcVoiceOrphanGuardTarget) | undefined;
  let unsubscribe: (() => void) | null = null;

  const killIfLive = (
    entry: ArcVoiceOrphanGuardTarget,
    killSignal: NodeJS.Signals,
  ): boolean => {
    if (entry.isAlive !== undefined && !entry.isAlive()) {
      return false;
    }
    return entry.kill(killSignal);
  };

  return {
    track(target) {
      token += 1;
      tracked = { token, ...target };
      if (unsubscribe === null) {
        unsubscribe = subscribeExit(() => {
          const entry = tracked;
          if (entry === undefined) {
            return;
          }
          killIfLive(entry, signal);
        });
      }
      return token;
    },
    trackedPid: () => tracked?.pid,
    killTracked(killSignal) {
      const entry = tracked;
      if (entry === undefined) {
        return false;
      }
      return killIfLive(entry, killSignal ?? signal);
    },
    release(releaseToken) {
      if (tracked !== undefined && tracked.token === releaseToken) {
        tracked = undefined;
      }
    },
    dispose() {
      if (unsubscribe !== null) {
        unsubscribe();
        unsubscribe = null;
      }
      tracked = undefined;
    },
  };
}

export type ArcVoiceTimeoutScheduler = (
  timeoutMs: number,
  onTimeout: () => void,
) => () => void;

export const scheduleArcVoiceTimeout: ArcVoiceTimeoutScheduler = (
  timeoutMs,
  onTimeout,
) => {
  const handle = setTimeout(onTimeout, timeoutMs);
  return () => {
    clearTimeout(handle);
  };
};

export interface ArcVoiceRestartPolicy {
  maxAttempts: number;
  delayMs: number;
  readyTimeoutMs?: number;
}

export interface ArcVoiceRuntimeExitEvent {
  pid: number | undefined;
  detail: string;
  restarting: boolean;
}

export interface ArcVoiceRuntimeManagerArgs {
  spawner: ArcVoiceProcessSpawner;
  client: ArcVoiceClient;
  healthCheck: () => Promise<ArcVoiceHealthResult>;
  guard?: ArcVoiceOrphanGuard;
  restartPolicy?: ArcVoiceRestartPolicy;
  onRuntimeExit?: (event: ArcVoiceRuntimeExitEvent) => void;
  sleep?: (ms: number) => Promise<void>;
  scheduleTimeout?: ArcVoiceTimeoutScheduler;
  gracefulStopTimeoutMs?: number;
  forceStopTimeoutMs?: number;
}

export class ArcVoiceRuntimeManager {
  readonly #spawner: ArcVoiceProcessSpawner;
  readonly #client: ArcVoiceClient;
  readonly #healthCheck: () => Promise<ArcVoiceHealthResult>;
  readonly #guard: ArcVoiceOrphanGuard;
  readonly #restartPolicy: ArcVoiceRestartPolicy | undefined;
  readonly #onRuntimeExit:
    | ((event: ArcVoiceRuntimeExitEvent) => void)
    | undefined;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #scheduleTimeout: ArcVoiceTimeoutScheduler;
  readonly #gracefulStopTimeoutMs: number;
  readonly #forceStopTimeoutMs: number;

  #process: ArcVoiceProcess | undefined;
  #guardToken: number | undefined;
  #state: ArcVoiceRuntimeStatus["state"] = "stopped";
  #lastError: string | undefined;
  #lastLaunchConfig: ArcVoiceLaunchConfig | undefined;
  #generation = 0;
  #recovering = false;

  constructor(args: ArcVoiceRuntimeManagerArgs) {
    this.#spawner = args.spawner;
    this.#client = args.client;
    this.#healthCheck = args.healthCheck;
    this.#guard = args.guard ?? createArcVoiceOrphanGuard();
    this.#restartPolicy = args.restartPolicy;
    this.#onRuntimeExit = args.onRuntimeExit;
    this.#sleep = args.sleep ?? defaultArcVoiceSleep;
    this.#scheduleTimeout = args.scheduleTimeout ?? scheduleArcVoiceTimeout;
    this.#gracefulStopTimeoutMs =
      args.gracefulStopTimeoutMs ?? DEFAULT_GRACEFUL_STOP_TIMEOUT_MS;
    this.#forceStopTimeoutMs =
      args.forceStopTimeoutMs ?? DEFAULT_FORCE_STOP_TIMEOUT_MS;
  }

  status(): ArcVoiceRuntimeStatus {
    const status: ArcVoiceRuntimeStatus =
      this.#process === undefined
        ? { state: this.#state }
        : { state: this.#state, pid: this.#process.pid };
    return this.#lastError === undefined
      ? status
      : { ...status, lastError: this.#lastError };
  }

  async launch(config: ArcVoiceLaunchConfig): Promise<ArcVoiceLaunchResult> {
    if (this.#process !== undefined) {
      return { kind: "failed", detail: "voice runtime is already running" };
    }

    this.#generation += 1;
    this.#lastLaunchConfig = config;
    this.#lastError = undefined;
    return this.#spawnProcess(config);
  }

  waitForReady(args: {
    timeoutMs: number;
    intervalMs?: number;
  }): Promise<ArcVoiceReadinessResult> {
    return waitForArcVoiceReady({
      check: this.#healthCheck,
      timeoutMs: args.timeoutMs,
      ...(args.intervalMs === undefined ? {} : { intervalMs: args.intervalMs }),
      sleep: this.#sleep,
    });
  }

  async start(
    config: ArcVoiceLaunchConfig,
    options: { timeoutMs: number; intervalMs?: number },
  ): Promise<ArcVoiceStartResult> {
    const launched = await this.launch(config);
    if (launched.kind === "failed") {
      return { kind: "failed", detail: launched.detail };
    }

    const ready = await this.waitForReady(options);
    if (ready.kind === "ready") {
      this.#state = "ready";
      return { kind: "ready", detail: ready.detail };
    }

    this.#lastError = ready.detail;
    await this.stop();
    this.#state = "failed";
    this.#lastError = ready.detail;
    return { kind: "timeout", detail: ready.detail };
  }

  async stop(): Promise<ArcVoiceStopResult> {
    this.#generation += 1;
    this.#lastLaunchConfig = undefined;

    const process_ = this.#process;
    if (process_ === undefined) {
      this.#disposeGuard();
      return { kind: "not-running", detail: "voice runtime is not running" };
    }

    this.#process = undefined;
    this.#state = "stopped";
    this.#lastError = undefined;

    const graceful = this.#awaitClose(process_, this.#gracefulStopTimeoutMs);
    process_.kill("SIGTERM");
    if (await graceful) {
      const residual = process_.killResidualTree();
      this.#disposeGuard();
      return {
        kind: "stopped",
        detail: residual
          ? "voice runtime stopped after SIGTERM; surviving child processes were force-killed"
          : "voice runtime stopped after SIGTERM",
      };
    }

    const forced = this.#awaitClose(process_, this.#forceStopTimeoutMs);
    process_.kill("SIGKILL");
    const exited = await forced;
    process_.killResidualTree();
    this.#disposeGuard();
    return {
      kind: "killed",
      detail: exited
        ? "voice runtime required SIGKILL"
        : "voice runtime did not report exit after SIGKILL",
    };
  }

  async recheckHealth(): Promise<ArcVoiceRuntimeStatus> {
    const process_ = this.#process;
    if (process_ === undefined) {
      return this.status();
    }

    let result: ArcVoiceHealthResult;
    try {
      result = await this.#healthCheck();
    } catch (error) {
      result = {
        kind: "unhealthy",
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    if (result.kind === "healthy") {
      this.#state = "ready";
      this.#lastError = undefined;
      return this.status();
    }

    this.#state = "failed";
    this.#lastError = result.detail;
    await this.#terminate(process_);
    if (this.#process === undefined) {
      this.#state = "failed";
      this.#lastError = result.detail;
    }
    return this.status();
  }

  listProfiles(): Promise<ArcVoiceCallResult<readonly ArcVoiceProfile[]>> {
    if (this.#process === undefined || this.#state !== "ready") {
      return Promise.resolve(this.#notReady());
    }
    return this.#client.listProfiles();
  }

  transcribe(
    args: ArcVoiceTranscribeArgs,
  ): Promise<ArcVoiceCallResult<ArcVoiceTranscribeOutput>> {
    if (this.#process === undefined || this.#state !== "ready") {
      return Promise.resolve(this.#notReady());
    }
    return this.#client.transcribe(args);
  }

  speak(
    args: ArcVoiceSpeakArgs,
  ): Promise<ArcVoiceCallResult<ArcVoiceSpeakOutput>> {
    if (this.#process === undefined || this.#state !== "ready") {
      return Promise.resolve(this.#notReady());
    }
    return this.#client.speak(args);
  }

  #notReady<T>(): ArcVoiceCallResult<T> {
    return {
      kind: "error",
      message: `voice runtime is ${this.#state}: refusing to call the voice API`,
    };
  }

  #releaseGuard(): void {
    if (this.#guardToken !== undefined) {
      this.#guard.release(this.#guardToken);
      this.#guardToken = undefined;
    }
  }

  #disposeGuard(): void {
    this.#guard.dispose();
    this.#guardToken = undefined;
  }

  #spawnProcess(config: ArcVoiceLaunchConfig): ArcVoiceLaunchResult {
    const parentPid =
      config.parentWatchdog === false
        ? undefined
        : (config.parentPid ?? process.pid);
    const args = buildVoiceboxLaunchArgs({ ...config, parentPid });
    const env = buildVoiceboxEnvironment(config);
    this.#state = "starting";

    let process_: ArcVoiceProcess;
    try {
      process_ = this.#spawner.spawn({
        command: config.command,
        args,
        env,
        ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
      });
    } catch (error) {
      this.#state = "failed";
      this.#lastError = `voice runtime failed to spawn: ${error instanceof Error ? error.message : String(error)}`;
      return { kind: "failed", detail: this.#lastError };
    }

    this.#process = process_;
    if (process_.pid !== undefined) {
      this.#guardToken = this.#guard.track({
        pid: process_.pid,
        isAlive: () => !process_.hasExited(),
        kill: (signal) => process_.kill(signal),
      });
    }
    process_.onError((error) => {
      this.#handleExit(
        process_,
        `voice runtime reported an error: ${error.message}`,
      );
    });
    process_.onClose((code, signal) => {
      this.#handleExit(
        process_,
        `voice runtime exited unexpectedly (code ${code === null ? "null" : code}, signal ${signal === null ? "null" : signal})`,
      );
    });

    return {
      kind: "launched",
      detail: `voice runtime launched with ${args.join(" ")}`,
      ...(process_.pid === undefined ? {} : { pid: process_.pid }),
    };
  }

  #handleExit(process_: ArcVoiceProcess, detail: string): void {
    if (this.#process !== process_) {
      return;
    }
    this.#process = undefined;
    this.#releaseGuard();
    this.#state = "failed";
    this.#lastError = detail;
    const pid = process_.pid;
    const restarting =
      this.#restartPolicy !== undefined && this.#lastLaunchConfig !== undefined;
    this.#onRuntimeExit?.({ pid, detail, restarting });
    void this.#recover(this.#generation);
  }

  async #recover(exitGeneration: number): Promise<void> {
    const policy = this.#restartPolicy;
    const config = this.#lastLaunchConfig;
    if (policy === undefined || config === undefined || this.#recovering) {
      return;
    }
    this.#recovering = true;
    try {
      for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
        await this.#sleep(policy.delayMs);
        if (exitGeneration !== this.#generation) {
          return;
        }

        const launched = this.#spawnProcess(config);
        if (launched.kind === "failed") {
          this.#lastError = launched.detail;
          continue;
        }

        const ready = await waitForArcVoiceReady({
          check: this.#healthCheck,
          timeoutMs: policy.readyTimeoutMs ?? DEFAULT_RESTART_READY_TIMEOUT_MS,
          sleep: this.#sleep,
        });
        if (exitGeneration !== this.#generation) {
          return;
        }
        if (ready.kind === "ready") {
          this.#state = "ready";
          this.#lastError = undefined;
          return;
        }

        this.#lastError = ready.detail;
        const restarted = this.#process;
        if (restarted !== undefined) {
          await this.#terminate(restarted);
        }
        if (this.#process === undefined || this.#process === restarted) {
          this.#state = "failed";
          this.#lastError = ready.detail;
        }
      }
    } finally {
      this.#recovering = false;
    }
  }

  async #terminate(process_: ArcVoiceProcess): Promise<void> {
    if (process_.hasExited()) {
      process_.killResidualTree();
      return;
    }
    const graceful = this.#awaitClose(process_, this.#gracefulStopTimeoutMs);
    process_.kill("SIGTERM");
    if (await graceful) {
      process_.killResidualTree();
      return;
    }
    if (process_.hasExited()) {
      process_.killResidualTree();
      return;
    }
    const forced = this.#awaitClose(process_, this.#forceStopTimeoutMs);
    process_.kill("SIGKILL");
    await forced;
    process_.killResidualTree();
  }

  #awaitClose(process_: ArcVoiceProcess, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let cancelTimeout: (() => void) | null = null;
      const finish = (value: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        cancelTimeout?.();
        cancelTimeout = null;
        resolve(value);
      };
      process_.onClose(() => {
        finish(true);
      });
      cancelTimeout = this.#scheduleTimeout(timeoutMs, () => {
        finish(false);
      });
    });
  }
}
