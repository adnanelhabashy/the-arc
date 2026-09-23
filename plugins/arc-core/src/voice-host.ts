import { Buffer } from "node:buffer";
import { join } from "node:path";
import {
  ARC_VOICEBOX_RELEASE,
  ARC_VOICE_LOOPBACK_HOST,
  ARC_VOICE_LOOPBACK_PORT,
  ArcVoiceRuntimeManager,
  ArcVoiceRuntimeService,
  buildArcVoiceBaseUrl,
  createArcVoiceClient,
  createArcVoiceHealthCheck,
  createArcVoicePaths,
  createFetchArcVoiceHttpClient,
  createNodeArcVoiceProcessSpawner,
  resolveArcVoiceBackend,
  stageArcVoiceboxComponentFromFile,
  type ArcVoiceCallResult,
  type ArcVoiceTranscribeArgs,
  type ArcVoiceTranscribeOutput,
  type ArcVoiceboxStager,
} from "bb-arc-voice-host";
import {
  experimental_aiServicesHostContract,
  type ExperimentalAiInferenceCompleteOutput,
  type ExperimentalAiVoiceTranscribeOutput,
} from "@get-bb/plugin-sdk/ai-services";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";

export const ARC_VOICE_SERVICE_ID = "arc-voice";
export const ARC_VOICE_DEFAULT_MODEL = "default";

const TRANSCRIPT_MAX_CHARACTERS = 20_000;
const AUDIO_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const AUDIO_MIME_TYPE_PATTERN = /^audio\/[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/u;

export interface ArcVoiceHostConfig {
  runtimeRoot: string;
  seedRoot: string;
  appVersion: string;
  platform: NodeJS.Platform;
  arch: string;
}

export interface ArcVoiceTranscriptionService {
  transcribe(
    args: ArcVoiceTranscribeArgs,
  ): Promise<ArcVoiceCallResult<ArcVoiceTranscribeOutput>>;
  stop(): Promise<unknown>;
}

function requiredEnvValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | null {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

export function resolveArcVoiceHostConfig(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ArcVoiceHostConfig | null {
  const runtimeRoot = requiredEnvValue(env, "ARC_VOICE_RUNTIME_ROOT");
  const seedRoot = requiredEnvValue(env, "ARC_VOICE_SEED_ROOT");
  const appVersion = requiredEnvValue(env, "ARC_VOICE_APP_VERSION");
  if (runtimeRoot === null || seedRoot === null || appVersion === null) {
    return null;
  }
  return { runtimeRoot, seedRoot, appVersion, platform, arch };
}

export function createArcVoiceRuntimeService(
  config: ArcVoiceHostConfig,
): ArcVoiceRuntimeService {
  const paths = createArcVoicePaths({ userDataPath: config.runtimeRoot });
  const baseUrl = buildArcVoiceBaseUrl({
    host: ARC_VOICE_LOOPBACK_HOST,
    port: ARC_VOICE_LOOPBACK_PORT,
  });
  const http = createFetchArcVoiceHttpClient();
  const client = createArcVoiceClient({ http, baseUrl });
  const serviceRef: { current: ArcVoiceRuntimeService | null } = {
    current: null,
  };
  const manager = new ArcVoiceRuntimeManager({
    spawner: createNodeArcVoiceProcessSpawner(),
    client,
    healthCheck: createArcVoiceHealthCheck({ client: http, baseUrl }),
    onRuntimeExit: (event) => {
      void serviceRef.current?.recordRuntimeExit(event).catch(() => undefined);
    },
  });
  const stage: ArcVoiceboxStager = ({ release, stagingDir }) =>
    stageArcVoiceboxComponentFromFile({
      release,
      componentPath: join(
        config.seedRoot,
        release.runtimeId,
        release.version,
        release.componentFileName,
      ),
      stagingDir,
    });
  const service = new ArcVoiceRuntimeService({
    paths,
    release: ARC_VOICEBOX_RELEASE,
    manager,
    stage,
    backend: resolveArcVoiceBackend({
      platform: config.platform,
      arch: config.arch,
    }),
    port: ARC_VOICE_LOOPBACK_PORT,
    createdByArcVersion: config.appVersion,
    platform: config.platform,
    arch: config.arch,
  });
  serviceRef.current = service;
  return service;
}

function decodeAudioBase64(value: string): Uint8Array | null {
  const normalized = value.replace(/\s+/gu, "");
  if (normalized.length === 0) {
    return null;
  }
  const buffer = Buffer.from(normalized, "base64");
  if (buffer.byteLength === 0 || buffer.toString("base64") !== normalized) {
    return null;
  }
  return new Uint8Array(buffer);
}

function validTranscript(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > TRANSCRIPT_MAX_CHARACTERS) {
    return null;
  }
  return trimmed;
}

export interface CreateArcVoiceHostEntryArgs {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  createService?: (config: ArcVoiceHostConfig) => ArcVoiceTranscriptionService;
}

export function createArcVoiceHostEntry(
  args: CreateArcVoiceHostEntryArgs = {},
) {
  const env = args.env ?? process.env;
  const platform = args.platform ?? process.platform;
  const arch = args.arch ?? process.arch;
  const createService = args.createService ?? createArcVoiceRuntimeService;
  let service: ArcVoiceTranscriptionService | null = null;

  const requireService = (): ArcVoiceTranscriptionService => {
    if (service !== null) {
      return service;
    }
    const config = resolveArcVoiceHostConfig(env, platform, arch);
    if (config === null) {
      throw new Error(
        "Arc Voice is unavailable: this host worker was not started by the Arc app",
      );
    }
    service = createService(config);
    return service;
  };

  return experimental_defineHostEntry({
    contract: experimental_aiServicesHostContract,
    handlers: {
      "ai.inference.complete": async (
        input,
      ): Promise<ExperimentalAiInferenceCompleteOutput> => ({
        ok: false,
        code: "request_failed",
        message: `Arc Voice serves no inference model "${input.model}".`,
      }),
      "ai.voice.transcribe": async (
        input,
        context,
      ): Promise<ExperimentalAiVoiceTranscribeOutput> => {
        if (input.serviceId !== ARC_VOICE_SERVICE_ID) {
          return {
            ok: false,
            code: "request_failed",
            message: `This plugin serves no AI service "${input.serviceId}".`,
          };
        }
        if (input.model !== ARC_VOICE_DEFAULT_MODEL) {
          return {
            ok: false,
            code: "request_failed",
            message: `Arc Voice serves only the "${ARC_VOICE_DEFAULT_MODEL}" model, received "${input.model}".`,
          };
        }
        if (!AUDIO_MIME_TYPE_PATTERN.test(input.mimeType)) {
          return {
            ok: false,
            code: "request_failed",
            message: `Arc Voice cannot transcribe audio of type "${input.mimeType}".`,
          };
        }
        if (!AUDIO_FILENAME_PATTERN.test(input.filename)) {
          return {
            ok: false,
            code: "request_failed",
            message: "Arc Voice received an unusable audio file name.",
          };
        }
        const audio = decodeAudioBase64(input.audioBase64);
        if (audio === null) {
          return {
            ok: false,
            code: "request_failed",
            message: "Arc Voice received audio that is not valid base64.",
          };
        }

        let runtime: ArcVoiceTranscriptionService;
        try {
          runtime = requireService();
        } catch (error) {
          return {
            ok: false,
            code: "service_unavailable",
            message:
              error instanceof Error
                ? error.message
                : "Arc Voice is unavailable on this host",
          };
        }

        const result = await runtime.transcribe({
          audio,
          fileName: input.filename,
          mimeType: input.mimeType,
          signal: context.signal,
        });
        if (result.kind === "error") {
          return {
            ok: false,
            code: context.signal.aborted ? "timeout" : "request_failed",
            message: result.message,
          };
        }
        const text = validTranscript(result.value.text);
        if (text === null) {
          return {
            ok: false,
            code: "invalid_response",
            message: "Arc Voice returned no usable transcript.",
          };
        }
        return { ok: true, model: input.model, text };
      },
    },
    async dispose() {
      const current = service;
      service = null;
      await current?.stop().catch(() => undefined);
    },
  });
}

export default createArcVoiceHostEntry();
