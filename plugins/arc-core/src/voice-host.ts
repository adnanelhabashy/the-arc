import { Buffer } from "node:buffer";
import { join } from "node:path";
import {
  ARC_VOICEBOX_RELEASE,
  ARC_VOICE_LOOPBACK_HOST,
  ARC_VOICE_LOOPBACK_PORT,
  ARC_VOICE_TTS_ENGINE_DEFAULT,
  ARC_VOICE_TTS_VOICE_DEFAULT,
  ArcVoiceRuntimeManager,
  ArcVoiceRuntimeService,
  buildArcVoiceBaseUrl,
  createArcVoiceClient,
  createArcVoiceHealthCheck,
  createArcVoicePaths,
  createFetchArcVoiceHttpClient,
  createNodeArcVoiceProcessSpawner,
  createPosixArcVoiceOwnershipProbe,
  resolveArcVoiceBackend,
  stageArcVoiceboxComponentFromFile,
  type ArcVoiceCallResult,
  type ArcVoiceCapabilities,
  type ArcVoiceProfileCreateArgs,
  type ArcVoiceProfileDetail,
  type ArcVoiceProfileSampleAddArgs,
  type ArcVoiceProfileUpdateArgs,
  type ArcVoiceSpeakArgs,
  type ArcVoiceSpeakOutput,
  type ArcVoiceSpeechStatus,
  type ArcVoiceTranscribeArgs,
  type ArcVoiceTranscribeOutput,
  type ArcVoiceboxStager,
} from "bb-arc-voice-host";
import {
  experimental_aiServicesHostContract,
  type ExperimentalAiInferenceCompleteOutput,
  type ExperimentalAiVoiceCapabilitiesOutput,
  type ExperimentalAiVoiceModelMutationOutput,
  type ExperimentalAiVoicePrepareOutput,
  type ExperimentalAiVoiceReleaseOutput,
  type ExperimentalAiVoiceProfileMutationOutput,
  type ExperimentalAiVoiceProfileSampleOutput,
  type ExperimentalAiVoiceProfilesOutput,
  type ExperimentalAiVoiceRepairOutput,
  type ExperimentalAiVoiceSpeakOutput,
  type ExperimentalAiVoiceStatusOutput,
  type ExperimentalAiVoiceTranscribeOutput,
  type ExperimentalVoiceProfile,
} from "@get-bb/plugin-sdk/ai-services";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";

export const ARC_VOICE_SERVICE_ID = "arc-voice";
export const ARC_VOICE_DEFAULT_MODEL = "default";

const WHISPER_MODEL_SIZES = ["base", "small", "medium", "large", "turbo"] as const;

const TRANSCRIPTION_LANGUAGE_PATTERN =
  /^[a-z]{2}(-[A-Za-z0-9]{2,8}){0,3}$/u;

const TRANSCRIPT_MAX_CHARACTERS = 20_000;
const AUDIO_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const AUDIO_MIME_TYPE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}(?:;[ -:<-~]{0,63})*$/u;
const AUDIO_FIELD_MAX_CHARACTERS = 128;
const AUDIO_MAX_BYTES = 25 * 1024 * 1024;
const SPEAK_AUDIO_MAX_BYTES = 24 * 1024 * 1024;
const AUDIO_MAX_BASE64_CHARACTERS = Math.ceil(AUDIO_MAX_BYTES / 3) * 4;
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46] as const;
const WAVE_MAGIC = [0x57, 0x41, 0x56, 0x45] as const;
const WAVE_HEADER_BYTES = 12;

export interface ArcVoiceHostConfig {
  runtimeRoot: string;
  seedRoot: string;
  appVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  ttsEngine: string;
  ttsVoice: string;
}

export interface ArcVoiceTranscriptionService {
  transcribe(
    args: ArcVoiceTranscribeArgs,
  ): Promise<ArcVoiceCallResult<ArcVoiceTranscribeOutput>>;
  speechStatus(): Promise<ArcVoiceCallResult<ArcVoiceSpeechStatus>>;
  speak(
    args: ArcVoiceSpeakArgs,
  ): Promise<ArcVoiceCallResult<ArcVoiceSpeakOutput>>;
  listProfileDetails(options?: {
    signal?: AbortSignal;
  }): Promise<ArcVoiceCallResult<readonly ArcVoiceProfileDetail[]>>;
  createProfile(
    args: ArcVoiceProfileCreateArgs,
  ): Promise<ArcVoiceCallResult<ArcVoiceProfileDetail>>;
  updateProfile(
    profileId: string,
    args: ArcVoiceProfileUpdateArgs,
  ): Promise<ArcVoiceCallResult<ArcVoiceProfileDetail>>;
  deleteProfile(profileId: string): Promise<ArcVoiceCallResult<void>>;
  addProfileSample(
    args: ArcVoiceProfileSampleAddArgs,
  ): Promise<ArcVoiceCallResult<string>>;
  removeProfileSample(sampleId: string): Promise<ArcVoiceCallResult<void>>;
  capabilities(options?: {
    signal?: AbortSignal;
  }): Promise<ArcVoiceCallResult<ArcVoiceCapabilities>>;
  downloadModel(
    modelName: string,
    signal?: AbortSignal,
  ): Promise<ArcVoiceCallResult<void>>;
  cancelModelDownload(modelName: string): Promise<ArcVoiceCallResult<void>>;
  prepareForSpeech(options?: {
    signal?: AbortSignal;
  }): Promise<
    ArcVoiceCallResult<{ runtimeState: "ready" | "starting" }>
  >;
  release(options?: {
    signal?: AbortSignal;
  }): Promise<
    ArcVoiceCallResult<{ runtimeState: "stopped" | "not-running" }>
  >;
  unloadModels(options?: {
    signal?: AbortSignal;
  }): Promise<ArcVoiceCallResult<void>>;
  repair(): Promise<
    | { kind: "reinstalled"; version: string; detail: string }
    | { kind: "healthy"; version: string; detail: string }
    | { kind: "installed"; version: string; detail: string }
    | { kind: "failed"; detail: string }
    | { kind: "unsupported-platform"; detail: string }
  >;
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
  const ttsEngine = env.ARC_VOICE_TTS_ENGINE?.trim();
  const ttsVoice = env.ARC_VOICE_TTS_VOICE?.trim();
  return {
    runtimeRoot,
    seedRoot,
    appVersion,
    platform,
    arch,
    ttsEngine:
      ttsEngine === undefined || ttsEngine.length === 0
        ? ARC_VOICE_TTS_ENGINE_DEFAULT
        : ttsEngine,
    ttsVoice:
      ttsVoice === undefined || ttsVoice.length === 0
        ? ARC_VOICE_TTS_VOICE_DEFAULT
        : ttsVoice,
  };
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
  const client = createArcVoiceClient({
    http,
    baseUrl,
    ttsEngine: config.ttsEngine,
    ttsVoice: config.ttsVoice,
  });
  const serviceRef: { current: ArcVoiceRuntimeService | null } = {
    current: null,
  };
  const manager = new ArcVoiceRuntimeManager({
    spawner: createNodeArcVoiceProcessSpawner(),
    client,
    healthCheck: createArcVoiceHealthCheck({ client: http, baseUrl }),
    ownershipProbe: createPosixArcVoiceOwnershipProbe({
      platform: config.platform,
    }),
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

function isRiffWaveAudio(bytes: Uint8Array): boolean {
  if (bytes.byteLength < WAVE_HEADER_BYTES) {
    return false;
  }
  return (
    RIFF_MAGIC.every((byte, index) => bytes[index] === byte) &&
    WAVE_MAGIC.every((byte, index) => bytes[8 + index] === byte)
  );
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

  const requireServiceOrError = ():
    | { ok: false; code: "service_unavailable"; message: string }
    | null => {
    try {
      requireService();
      return null;
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
  };

  const mapRuntimeError = (
    result: { kind: "error"; code: string; message: string },
    signal?: AbortSignal,
  ): { ok: false; code: "timeout" | "service_unavailable" | "request_failed"; message: string } => ({
    ok: false,
    code:
      result.code === "timeout" || signal?.aborted === true
        ? "timeout"
        : result.code === "unavailable"
          ? "service_unavailable"
          : "request_failed",
    message: result.message,
  });

  const toExperimentalProfile = (
    profile: ArcVoiceProfileDetail,
  ): ExperimentalVoiceProfile => ({
    id: profile.id,
    name: profile.name,
    description: profile.description,
    language: profile.language,
    voiceType: profile.voiceType,
    presetEngine: profile.presetEngine,
    presetVoiceId: profile.presetVoiceId,
    sampleCount: profile.sampleCount,
  });

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
        const requestedModel = input.model.startsWith("whisper-")
          ? input.model.slice("whisper-".length)
          : input.model;
        if (
          requestedModel !== ARC_VOICE_DEFAULT_MODEL &&
          !(WHISPER_MODEL_SIZES as readonly string[]).includes(requestedModel)
        ) {
          return {
            ok: false,
            code: "request_failed",
            message: `Arc Voice serves only Whisper models (${WHISPER_MODEL_SIZES.join(", ")}), received "${input.model}".`,
          };
        }
        if (
          input.language !== null &&
          (input.language.length > 35 ||
            !TRANSCRIPTION_LANGUAGE_PATTERN.test(input.language))
        ) {
          return {
            ok: false,
            code: "request_failed",
            message: "Arc Voice received an unusable transcription language.",
          };
        }
        if (
          input.mimeType.length > AUDIO_FIELD_MAX_CHARACTERS ||
          !AUDIO_MIME_TYPE_PATTERN.test(input.mimeType)
        ) {
          return {
            ok: false,
            code: "request_failed",
            message: "Arc Voice received an unusable audio content type.",
          };
        }
        if (
          input.filename.length > AUDIO_FIELD_MAX_CHARACTERS ||
          !AUDIO_FILENAME_PATTERN.test(input.filename)
        ) {
          return {
            ok: false,
            code: "request_failed",
            message: "Arc Voice received an unusable audio file name.",
          };
        }
        if (input.audioBase64.length > AUDIO_MAX_BASE64_CHARACTERS) {
          return {
            ok: false,
            code: "request_failed",
            message: `Arc Voice cannot transcribe audio larger than ${AUDIO_MAX_BYTES / (1024 * 1024)}MB.`,
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
        if (!isRiffWaveAudio(audio)) {
          return {
            ok: false,
            code: "request_failed",
            message: `Arc Voice requires decoded PCM WAV audio and received "${input.mimeType}" that Voicebox cannot decode.`,
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
          language: input.language ?? undefined,
          model:
            requestedModel === ARC_VOICE_DEFAULT_MODEL
              ? undefined
              : requestedModel,
          signal: context.signal,
          timeoutMs: input.timeoutMs,
        });
        if (result.kind === "error") {
          return {
            ok: false,
            code:
              result.code === "timeout" || context.signal.aborted
                ? "timeout"
                : result.code === "unavailable"
                  ? "service_unavailable"
                  : "request_failed",
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
      "ai.voice.status": async (
        input,
      ): Promise<ExperimentalAiVoiceStatusOutput> => {
        if (input.serviceId !== ARC_VOICE_SERVICE_ID) {
          return {
            ok: false,
            code: "request_failed",
            message: `This plugin serves no AI service "${input.serviceId}".`,
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

        const result = await runtime.speechStatus();
        if (result.kind === "error") {
          return {
            ok: false,
            code: "service_unavailable",
            message: result.message,
          };
        }
        return { ok: true, ...result.value };
      },
      "ai.voice.speak": async (
        input,
        context,
      ): Promise<ExperimentalAiVoiceSpeakOutput> => {
        if (input.serviceId !== ARC_VOICE_SERVICE_ID) {
          return {
            ok: false,
            code: "request_failed",
            message: `This plugin serves no AI service "${input.serviceId}".`,
          };
        }
        const text = input.text.trim();
        if (text.length === 0) {
          return {
            ok: false,
            code: "request_failed",
            message: "Arc Voice received nothing to speak.",
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

        const result = await runtime.speak({
          text,
          language: input.language ?? undefined,
          profile: input.profile ?? undefined,
          engine: input.engine ?? undefined,
          voiceId: input.voiceId ?? undefined,
          signal: context.signal,
          timeoutMs: input.timeoutMs,
        });
        if (result.kind === "error") {
          return {
            ok: false,
            code:
              result.code === "timeout" || context.signal.aborted
                ? "timeout"
                : result.code === "unavailable"
                  ? "service_unavailable"
                  : "request_failed",
            message: result.message,
          };
        }
        if (result.value.audio.byteLength > SPEAK_AUDIO_MAX_BYTES) {
          return {
            ok: false,
            code: "request_failed",
            message: "Arc Voice produced more audio than Arc can play back.",
          };
        }
        return {
          ok: true,
          audioBase64: Buffer.from(result.value.audio).toString("base64"),
          contentType: result.value.contentType,
          durationMs: result.value.durationMs,
        };
      },
      "ai.voice.capabilities": async (
        input,
        context,
      ): Promise<ExperimentalAiVoiceCapabilitiesOutput> => {
        if (input.serviceId !== ARC_VOICE_SERVICE_ID) {
          return {
            ok: false,
            code: "request_failed",
            message: `This plugin serves no AI service "${input.serviceId}".`,
          };
        }
        const unavailable = requireServiceOrError();
        if (unavailable !== null) {
          return unavailable;
        }
        const result = await requireService().capabilities({
          signal: context.signal,
        });
        if (result.kind === "error") {
          return mapRuntimeError(result, context.signal);
        }
        return {
          ok: true,
          runtimeState: result.value.runtimeState,
          version: result.value.version,
          engines: result.value.engines.map((engine) => ({
            engine: engine.engine,
            requiresClonedProfile: engine.requiresClonedProfile,
            presets:
              engine.presets === null
                ? null
                : engine.presets.map((preset) => ({
                    voiceId: preset.voiceId,
                    name: preset.name,
                    gender: preset.gender,
                    language: preset.language,
                  })),
            models: engine.models.map((model) => ({
              name: model.name,
              displayName: model.displayName,
              downloaded: model.downloaded,
              downloading: model.downloading,
              loaded: model.loaded,
              downloadPercent: model.downloadPercent,
            })),
          })),
          speechModels: result.value.speechModels.map((model) => ({
            name: model.name,
            displayName: model.displayName,
            downloaded: model.downloaded,
            downloading: model.downloading,
            loaded: model.loaded,
            downloadPercent: model.downloadPercent,
          })),
        };
      },
      "ai.voice.profiles": async (
        input,
        context,
      ): Promise<ExperimentalAiVoiceProfilesOutput> => {
        if (input.serviceId !== ARC_VOICE_SERVICE_ID) {
          return {
            ok: false,
            code: "request_failed",
            message: `This plugin serves no AI service "${input.serviceId}".`,
          };
        }
        const unavailable = requireServiceOrError();
        if (unavailable !== null) {
          return unavailable;
        }
        const result = await requireService().listProfileDetails({
          signal: context.signal,
        });
        if (result.kind === "error") {
          return mapRuntimeError(result, context.signal);
        }
        return {
          ok: true,
          profiles: result.value.map((profile) =>
            toExperimentalProfile(profile),
          ),
        };
      },
      "ai.voice.profileCreate": async (
        input,
        context,
      ): Promise<ExperimentalAiVoiceProfileMutationOutput> => {
        if (input.serviceId !== ARC_VOICE_SERVICE_ID) {
          return {
            ok: false,
            code: "request_failed",
            message: `This plugin serves no AI service "${input.serviceId}".`,
          };
        }
        const unavailable = requireServiceOrError();
        if (unavailable !== null) {
          return unavailable;
        }
        const createArgs: ArcVoiceProfileCreateArgs = {
          name: input.name,
          language: input.language,
          voiceType: input.voiceType,
          ...(input.description === null ? {} : { description: input.description }),
          ...(input.presetEngine === null
            ? {}
            : { presetEngine: input.presetEngine }),
          ...(input.presetVoiceId === null
            ? {}
            : { presetVoiceId: input.presetVoiceId }),
          signal: context.signal,
        };
        const result = await requireService().createProfile(createArgs);
        if (result.kind === "error") {
          return mapRuntimeError(result, context.signal);
        }
        return { ok: true, profile: toExperimentalProfile(result.value) };
      },
      "ai.voice.profileUpdate": async (
        input,
        context,
      ): Promise<ExperimentalAiVoiceProfileMutationOutput> => {
        if (input.serviceId !== ARC_VOICE_SERVICE_ID) {
          return {
            ok: false,
            code: "request_failed",
            message: `This plugin serves no AI service "${input.serviceId}".`,
          };
        }
        const unavailable = requireServiceOrError();
        if (unavailable !== null) {
          return unavailable;
        }
        const updateArgs: ArcVoiceProfileUpdateArgs = {
          ...(input.name === null ? {} : { name: input.name }),
          ...(input.description === null
            ? {}
            : { description: input.description }),
          signal: context.signal,
        };
        const result = await requireService().updateProfile(
          input.profileId,
          updateArgs,
        );
        if (result.kind === "error") {
          return mapRuntimeError(result, context.signal);
        }
        return { ok: true, profile: toExperimentalProfile(result.value) };
      },
      "ai.voice.profileDelete": async (
        input,
        context,
      ): Promise<ExperimentalAiVoiceProfileMutationOutput> => {
        if (input.serviceId !== ARC_VOICE_SERVICE_ID) {
          return {
            ok: false,
            code: "request_failed",
            message: `This plugin serves no AI service "${input.serviceId}".`,
          };
        }
        const unavailable = requireServiceOrError();
        if (unavailable !== null) {
          return unavailable;
        }
        const result = await requireService().deleteProfile(input.profileId);
        if (result.kind === "error") {
          return mapRuntimeError(result, context.signal);
        }
        return {
          ok: true,
          profile: {
            id: input.profileId,
            name: input.profileId,
            description: null,
            language: "en",
            voiceType: "cloned",
            presetEngine: null,
            presetVoiceId: null,
            sampleCount: 0,
          },
        };
      },
      "ai.voice.profileSampleAdd": async (
        input,
        context,
      ): Promise<ExperimentalAiVoiceProfileSampleOutput> => {
        if (input.serviceId !== ARC_VOICE_SERVICE_ID) {
          return {
            ok: false,
            code: "request_failed",
            message: `This plugin serves no AI service "${input.serviceId}".`,
          };
        }
        if (
          input.mimeType.length > AUDIO_FIELD_MAX_CHARACTERS ||
          !AUDIO_MIME_TYPE_PATTERN.test(input.mimeType)
        ) {
          return {
            ok: false,
            code: "request_failed",
            message: "Arc Voice received an unusable audio content type.",
          };
        }
        if (
          input.filename.length > AUDIO_FIELD_MAX_CHARACTERS ||
          !AUDIO_FILENAME_PATTERN.test(input.filename)
        ) {
          return {
            ok: false,
            code: "request_failed",
            message: "Arc Voice received an unusable audio file name.",
          };
        }
        if (input.referenceText.trim().length === 0) {
          return {
            ok: false,
            code: "request_failed",
            message: "Arc Voice requires the text spoken in the sample.",
          };
        }
        if (input.audioBase64.length > AUDIO_MAX_BASE64_CHARACTERS) {
          return {
            ok: false,
            code: "request_failed",
            message: `Arc Voice cannot accept a sample larger than ${AUDIO_MAX_BYTES / (1024 * 1024)}MB.`,
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
        if (!isRiffWaveAudio(audio)) {
          return {
            ok: false,
            code: "request_failed",
            message: `Arc Voice requires decoded PCM WAV audio and received "${input.mimeType}" that Voicebox cannot decode.`,
          };
        }
        const unavailable = requireServiceOrError();
        if (unavailable !== null) {
          return unavailable;
        }
        const result = await requireService().addProfileSample({
          profileId: input.profileId,
          audio,
          fileName: input.filename,
          mimeType: input.mimeType,
          referenceText: input.referenceText,
          signal: context.signal,
        });
        if (result.kind === "error") {
          return mapRuntimeError(result, context.signal);
        }
        return { ok: true, sampleId: result.value };
      },
      "ai.voice.profileSampleRemove": async (
        input,
        context,
      ): Promise<ExperimentalAiVoiceProfileSampleOutput> => {
        if (input.serviceId !== ARC_VOICE_SERVICE_ID) {
          return {
            ok: false,
            code: "request_failed",
            message: `This plugin serves no AI service "${input.serviceId}".`,
          };
        }
        const unavailable = requireServiceOrError();
        if (unavailable !== null) {
          return unavailable;
        }
        const result = await requireService().removeProfileSample(
          input.sampleId,
        );
        if (result.kind === "error") {
          return mapRuntimeError(result, context.signal);
        }
        return { ok: true, sampleId: input.sampleId };
      },
      "ai.voice.modelDownload": async (
        input,
        context,
      ): Promise<ExperimentalAiVoiceRepairOutput> => {
        if (input.serviceId !== ARC_VOICE_SERVICE_ID) {
          return {
            ok: false,
            code: "request_failed",
            message: `This plugin serves no AI service "${input.serviceId}".`,
          };
        }
        const unavailable = requireServiceOrError();
        if (unavailable !== null) {
          return unavailable;
        }
        const result = await requireService().downloadModel(
          input.model,
          context.signal,
        );
        if (result.kind === "error") {
          return mapRuntimeError(result, context.signal);
        }
        return { ok: true };
      },
      "ai.voice.modelDownloadCancel": async (
        input,
        context,
      ): Promise<ExperimentalAiVoiceRepairOutput> => {
        if (input.serviceId !== ARC_VOICE_SERVICE_ID) {
          return {
            ok: false,
            code: "request_failed",
            message: `This plugin serves no AI service "${input.serviceId}".`,
          };
        }
        const unavailable = requireServiceOrError();
        if (unavailable !== null) {
          return unavailable;
        }
        const result = await requireService().cancelModelDownload(input.model);
        if (result.kind === "error") {
          return mapRuntimeError(result, context.signal);
        }
        return { ok: true };
      },
      "ai.voice.repair": async (
        input,
      ): Promise<ExperimentalAiVoiceRepairOutput> => {
        if (input.serviceId !== ARC_VOICE_SERVICE_ID) {
          return {
            ok: false,
            code: "request_failed",
            message: `This plugin serves no AI service "${input.serviceId}".`,
          };
        }
        const unavailable = requireServiceOrError();
        if (unavailable !== null) {
          return unavailable;
        }
        const result = await requireService().repair();
        if (
          result.kind === "failed" ||
          result.kind === "unsupported-platform"
        ) {
          return {
            ok: false,
            code: "service_unavailable",
            message: result.detail,
          };
        }
        return { ok: true };
      },
      "ai.voice.prepare": async (
        input,
        context,
      ): Promise<ExperimentalAiVoicePrepareOutput> => {
        if (input.serviceId !== ARC_VOICE_SERVICE_ID) {
          return {
            ok: false,
            code: "request_failed",
            message: `This plugin serves no AI service "${input.serviceId}".`,
          };
        }
        const unavailable = requireServiceOrError();
        if (unavailable !== null) {
          return unavailable;
        }
        const result = await requireService().prepareForSpeech({
          signal: context.signal,
        });
        if (result.kind === "error") {
          return mapRuntimeError(result, context.signal);
        }
        return { ok: true, runtimeState: result.value.runtimeState };
      },
      "ai.voice.release": async (
        input,
        context,
      ): Promise<ExperimentalAiVoiceReleaseOutput> => {
        if (input.serviceId !== ARC_VOICE_SERVICE_ID) {
          return {
            ok: false,
            code: "request_failed",
            message: `This plugin serves no AI service "${input.serviceId}".`,
          };
        }
        const unavailable = requireServiceOrError();
        if (unavailable !== null) {
          return unavailable;
        }
        const result = await requireService().release({
          signal: context.signal,
        });
        if (result.kind === "error") {
          return mapRuntimeError(result, context.signal);
        }
        return { ok: true, runtimeState: result.value.runtimeState };
      },
      "ai.voice.unloadModels": async (
        input,
        context,
      ): Promise<ExperimentalAiVoiceModelMutationOutput> => {
        if (input.serviceId !== ARC_VOICE_SERVICE_ID) {
          return {
            ok: false,
            code: "request_failed",
            message: `This plugin serves no AI service "${input.serviceId}".`,
          };
        }
        const unavailable = requireServiceOrError();
        if (unavailable !== null) {
          return unavailable;
        }
        const result = await requireService().unloadModels({
          signal: context.signal,
        });
        if (result.kind === "error") {
          return mapRuntimeError(result, context.signal);
        }
        return { ok: true };
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
