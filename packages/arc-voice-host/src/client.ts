import { z } from "zod";
import { assertLoopbackUrl } from "./binding.js";
import { defaultArcVoiceSleep, type ArcVoiceHealthResult } from "./health.js";

export interface ArcVoiceHttpRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array<ArrayBuffer>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ArcVoiceHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array<ArrayBuffer>;
}

export interface ArcVoiceHttpClient {
  request(request: ArcVoiceHttpRequest): Promise<ArcVoiceHttpResponse>;
  streamText(
    request: ArcVoiceHttpRequest,
    onChunk: (chunk: string) => void,
  ): Promise<void>;
}

export interface ArcVoiceProfile {
  id: string;
  name: string;
}

export interface ArcVoiceProfileDetail {
  id: string;
  name: string;
  description: string | null;
  language: string;
  voiceType: string;
  presetEngine: string | null;
  presetVoiceId: string | null;
  sampleCount: number;
}

export type ArcVoiceProfileVoiceType = "cloned" | "preset" | "designed";

export interface ArcVoiceProfileCreateArgs {
  name: string;
  description?: string;
  language: string;
  voiceType: ArcVoiceProfileVoiceType;
  presetEngine?: string;
  presetVoiceId?: string;
  signal?: AbortSignal;
}

export interface ArcVoiceProfileUpdateArgs {
  name?: string;
  description?: string;
  signal?: AbortSignal;
}

export interface ArcVoiceProfileSampleAddArgs {
  profileId: string;
  audio: Uint8Array;
  fileName: string;
  mimeType: string;
  referenceText: string;
  signal?: AbortSignal;
}

export interface ArcVoicePresetVoice {
  voiceId: string;
  name: string;
  gender: string;
  language: string;
}

export interface ArcVoiceModelEntry {
  name: string;
  displayName: string;
  downloaded: boolean;
  downloading: boolean;
  loaded: boolean;
}

export type ArcVoiceCallFailureCode =
  | "aborted"
  | "timeout"
  | "transport"
  | "http"
  | "protocol"
  | "unavailable";

export type ArcVoiceCallResult<T> =
  | { kind: "ok"; value: T }
  | {
      kind: "error";
      code: ArcVoiceCallFailureCode;
      message: string;
      status?: number;
    };

export interface ArcVoiceTranscribeArgs {
  audio: Uint8Array;
  fileName?: string;
  mimeType?: string;
  language?: string;
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ArcVoiceTranscribeOutput {
  text: string;
  duration?: number;
}

export interface ArcVoiceSpeakArgs {
  text: string;
  profile?: string;
  language?: string;
  engine?: string;
  voiceId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ArcVoiceSpeakOutput {
  audio: Uint8Array;
  contentType: string;
  durationMs: number | null;
}

export interface ArcVoiceSpeechModelStatus {
  modelName: string | null;
  loaded: boolean;
}

export interface ArcVoiceTtsModelStatus {
  modelName: string;
  engine: string;
  size: string;
  downloaded: boolean;
  loaded: boolean;
  downloading: boolean;
}

export interface ArcVoiceModelStatus {
  speech: ArcVoiceSpeechModelStatus;
  voice: ArcVoiceTtsModelStatus | null;
}

export interface ArcVoiceLoadModelArgs {
  modelSize: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ArcVoiceClient {
  listProfiles(): Promise<ArcVoiceCallResult<readonly ArcVoiceProfile[]>>;
  listProfileDetails(
    options?: { signal?: AbortSignal },
  ): Promise<ArcVoiceCallResult<readonly ArcVoiceProfileDetail[]>>;
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
  listPresets(
    engine: string,
  ): Promise<ArcVoiceCallResult<readonly ArcVoicePresetVoice[]>>;
  listModels(): Promise<ArcVoiceCallResult<readonly ArcVoiceModelEntry[]>>;
  downloadModel(
    modelName: string,
    signal?: AbortSignal,
  ): Promise<ArcVoiceCallResult<void>>;
  cancelModelDownload(modelName: string): Promise<ArcVoiceCallResult<void>>;
  transcribe(
    args: ArcVoiceTranscribeArgs,
  ): Promise<ArcVoiceCallResult<ArcVoiceTranscribeOutput>>;
  speak(
    args: ArcVoiceSpeakArgs,
  ): Promise<ArcVoiceCallResult<ArcVoiceSpeakOutput>>;
  modelStatus(): Promise<ArcVoiceCallResult<ArcVoiceModelStatus>>;
  loadVoiceModel(
    args: ArcVoiceLoadModelArgs,
  ): Promise<ArcVoiceCallResult<void>>;
  unloadModels(options?: {
    signal?: AbortSignal;
  }): Promise<ArcVoiceCallResult<void>>;
  voiceModelProgress(
    modelName: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ArcVoiceCallResult<number | null>>;
}

export interface CreateArcVoiceClientArgs {
  http: ArcVoiceHttpClient;
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  boundaryFactory?: () => string;
  sleep?: (ms: number) => Promise<void>;
  speakPollIntervalMs?: number;
  speakTimeoutMs?: number;
  ttsEngine?: string;
  ttsVoice?: string;
  ttsProfileName?: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_SPEAK_POLL_INTERVAL_MS = 250;
const DEFAULT_SPEAK_TIMEOUT_MS = 180_000;

const ACTIVE_GENERATION_STATUSES: readonly string[] = [
  "queued",
  "loading_model",
  "generating",
];

export const VOICEBOX_TRANSCRIBE_PATH = "/transcribe";
export const VOICEBOX_SPEAK_PATH = "/speak";
export const VOICEBOX_HEALTH_PATH = "/health";
export const VOICEBOX_PROFILES_PATH = "/profiles";
export const VOICEBOX_MODELS_STATUS_PATH = "/models/status";
export const VOICEBOX_MODELS_LOAD_PATH = "/models/load";
export const VOICEBOX_MODELS_UNLOAD_PATH = "/models/unload";
export const voiceboxModelUnloadPath = (modelName: string): string =>
  `/models/${encodeURIComponent(modelName)}/unload`;
const VOICEBOX_MODEL_UNLOAD_PATH = voiceboxModelUnloadPath;

export const ARC_VOICE_TTS_ENGINE_DEFAULT = "kokoro";
export const ARC_VOICE_TTS_VOICE_DEFAULT = "af_heart";
export const ARC_VOICE_TTS_PROFILE_NAME = "Arc Voice";

export interface ArcVoiceTtsModelSpec {
  modelName: string;
  size: string;
}

export const ARC_VOICE_TTS_MODELS: Readonly<
  Record<string, ArcVoiceTtsModelSpec>
> = {
  kokoro: { modelName: "kokoro", size: "" },
  qwen_custom_voice: { modelName: "qwen-custom-voice-1.7B", size: "1.7B" },
  qwen: { modelName: "qwen-tts-0.6B", size: "0.6B" },
};

export function voiceboxGenerationStatusPath(generationId: string): string {
  return `/history/${encodeURIComponent(generationId)}`;
}

export function voiceboxAudioPath(generationId: string): string {
  return `/audio/${encodeURIComponent(generationId)}`;
}

export function voiceboxModelProgressPath(modelName: string): string {
  return `/models/progress/${encodeURIComponent(modelName)}`;
}

export function voiceboxGenerationCancelPath(generationId: string): string {
  return `/generate/${encodeURIComponent(generationId)}/cancel`;
}

export function voiceboxProfilePath(profileId: string): string {
  return `/profiles/${encodeURIComponent(profileId)}`;
}

export function voiceboxProfileSamplesPath(profileId: string): string {
  return `/profiles/${encodeURIComponent(profileId)}/samples`;
}

export function voiceboxProfileSampleByIdPath(sampleId: string): string {
  return `/profiles/samples/${encodeURIComponent(sampleId)}`;
}

export function voiceboxPresetsPath(engine: string): string {
  return `/profiles/presets/${encodeURIComponent(engine)}`;
}

export const VOICEBOX_MODELS_DOWNLOAD_PATH = "/models/download";
export const VOICEBOX_MODELS_DOWNLOAD_CANCEL_PATH = "/models/download/cancel";

const profileSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
});

const profileDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  language: z.string().optional(),
  voice_type: z.string().optional(),
  preset_engine: z.string().nullish(),
  preset_voice_id: z.string().nullish(),
  sample_count: z.number().optional(),
});

const profilesResponseSchema = z.union([
  z.array(profileSchema),
  z.object({ profiles: z.array(profileSchema) }),
]);

const profileDetailResponseSchema = z.union([
  z.array(profileDetailSchema),
  z.object({ profiles: z.array(profileDetailSchema) }),
]);

const profileSampleResponseSchema = z.object({
  id: z.string(),
});

const presetsResponseSchema = z.object({
  engine: z.string().optional(),
  voices: z.array(
    z.object({
      voice_id: z.string(),
      name: z.string().optional(),
      gender: z.string().optional(),
      language: z.string().optional(),
    }),
  ),
});

const modelStatusEntrySchema = z.object({
  model_name: z.string().optional(),
  display_name: z.string().optional(),
  downloaded: z.boolean().optional(),
  downloading: z.boolean().optional(),
  loaded: z.boolean().optional(),
});

const transcribeResponseSchema = z.object({
  text: z.string(),
  duration: z.number().optional(),
});

const generationSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  error: z.string().nullish(),
  duration: z.number().optional(),
});

const modelStatusResponseSchema = z.object({
  models: z.array(modelStatusEntrySchema).optional(),
});

const healthSchema = z.object({
  status: z.string(),
});

const decoder = new TextDecoder();

function decodeJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(body));
  } catch {
    return undefined;
  }
}

function normalizeProfiles(
  parsed: z.infer<typeof profilesResponseSchema>,
): readonly ArcVoiceProfile[] {
  const entries = Array.isArray(parsed) ? parsed : parsed.profiles;
  return entries.map((entry) => ({
    id: entry.id,
    name: entry.name ?? entry.id,
  }));
}

function normalizeProfileDetail(
  entry: z.infer<typeof profileDetailSchema>,
): ArcVoiceProfileDetail {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description ?? null,
    language: entry.language ?? "en",
    voiceType: entry.voice_type ?? "cloned",
    presetEngine: entry.preset_engine ?? null,
    presetVoiceId: entry.preset_voice_id ?? null,
    sampleCount: entry.sample_count ?? 0,
  };
}

function errorFromResponse(
  response: ArcVoiceHttpResponse,
  label: string,
): ArcVoiceCallResult<never> {
  const detail = decoder.decode(response.body).slice(0, 200).trim();
  return {
    kind: "error",
    code: "http",
    message: `${label} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    status: response.status,
  };
}

function errorFromException(
  error: unknown,
  label: string,
  code: ArcVoiceCallFailureCode = "transport",
): ArcVoiceCallResult<never> {
  return {
    kind: "error",
    code,
    message: `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
  };
}

function firstSseDataLine(buffer: string): string | null {
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline === -1) {
      return null;
    }
    const head = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (head.startsWith("data:")) {
      const payload = head.slice("data:".length).trim();
      return payload.length > 0 ? payload : null;
    }
  }
}

function parseProgressLine(payload: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const raw = (parsed as Record<string, unknown>).progress;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return null;
  }
  const normalized = raw > 1 ? raw / 100 : raw;
  return Math.min(1, Math.max(0, normalized));
}

export function buildArcVoiceMultipartBody(
  parts: readonly {
    name: string;
    value: string | Uint8Array;
    fileName?: string;
    contentType?: string;
  }[],
  boundary: string,
): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    const headers = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="${part.name}"${part.fileName === undefined ? "" : `; filename="${part.fileName}"`}`,
      ...(part.contentType === undefined
        ? []
        : [`Content-Type: ${part.contentType}`]),
      "",
      "",
    ].join("\r\n");
    chunks.push(encoder.encode(headers));
    chunks.push(
      typeof part.value === "string" ? encoder.encode(part.value) : part.value,
    );
    chunks.push(encoder.encode("\r\n"));
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));

  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function createArcVoiceClient(
  args: CreateArcVoiceClientArgs,
): ArcVoiceClient {
  const baseUrl = assertLoopbackUrl(args.baseUrl).replace(/\/$/, "");
  const timeoutMs = args.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const boundaryFactory = args.boundaryFactory ?? (() => crypto.randomUUID());
  const sleep = args.sleep ?? defaultArcVoiceSleep;
  const pollIntervalMs =
    args.speakPollIntervalMs ?? DEFAULT_SPEAK_POLL_INTERVAL_MS;
  const speakTimeoutMs = args.speakTimeoutMs ?? DEFAULT_SPEAK_TIMEOUT_MS;
  const ttsEngine = args.ttsEngine ?? ARC_VOICE_TTS_ENGINE_DEFAULT;
  const ttsVoice = args.ttsVoice ?? ARC_VOICE_TTS_VOICE_DEFAULT;
  const headers = (extra: Record<string, string>): Record<string, string> => ({
    ...(args.token === undefined
      ? {}
      : { authorization: `Bearer ${args.token}` }),
    ...extra,
  });

  const get = async (
    path: string,
    accept: string,
    signal?: AbortSignal,
  ): Promise<ArcVoiceHttpResponse | ArcVoiceCallResult<never>> => {
    try {
      return await args.http.request({
        method: "GET",
        url: `${baseUrl}${path}`,
        headers: headers({ accept }),
        timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      return errorFromException(
        error,
        "voice request",
        signal?.aborted === true ? "aborted" : "transport",
      );
    }
  };

  const readGeneration = async (
    path: string,
    signal?: AbortSignal,
  ): Promise<
    | {
        kind: "ok";
        value: {
          status: string;
          detail: string | undefined;
          duration: number | undefined;
        };
      }
    | ArcVoiceCallResult<never>
  > => {
    const response = await get(path, "application/json", signal);
    if ("kind" in response) {
      return response;
    }
    if (response.status < 200 || response.status >= 300) {
      return errorFromResponse(response, "voice generation status");
    }
    const parsed = generationSchema.safeParse(decodeJson(response.body));
    if (!parsed.success) {
      return {
        kind: "error",
        code: "protocol",
        message: "voice generation status returned an unexpected body",
      };
    }
    return {
      kind: "ok",
      value: {
        status: parsed.data.status ?? "completed",
        detail: parsed.data.error ?? undefined,
        duration: parsed.data.duration,
      },
    };
  };

  const ensureProfile = async (
    engine: string,
    presetVoiceId: string,
    signal?: AbortSignal,
  ): Promise<{ kind: "ok"; value: string } | ArcVoiceCallResult<never>> => {
    const listed = await get(VOICEBOX_PROFILES_PATH, "application/json", signal);
    if ("kind" in listed) {
      return listed;
    }
    if (listed.status < 200 || listed.status >= 300) {
      return errorFromResponse(listed, "voice profile listing");
    }
    const parsed = profileDetailResponseSchema.safeParse(decodeJson(listed.body));
    if (parsed.success) {
      const entries = Array.isArray(parsed.data)
        ? parsed.data
        : parsed.data.profiles;
      const existing = entries.find(
        (entry) =>
          (entry.voice_type ?? "cloned") === "preset" &&
          (entry.preset_engine ?? null) === engine &&
          (entry.preset_voice_id ?? null) === presetVoiceId,
      );
      if (existing !== undefined) {
        return { kind: "ok", value: existing.name };
      }
    }
    let created: ArcVoiceHttpResponse;
    try {
      created = await args.http.request({
        method: "POST",
        url: `${baseUrl}${VOICEBOX_PROFILES_PATH}`,
        headers: headers({
          accept: "application/json",
          "content-type": "application/json",
        }),
        body: new TextEncoder().encode(
          JSON.stringify({
            name: `Arc Voice · ${presetVoiceId}`,
            language: "en",
            voice_type: "preset",
            preset_engine: engine,
            preset_voice_id: presetVoiceId,
            default_engine: engine,
          }),
        ),
        timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      return errorFromException(
        error,
        "voice profile creation",
        signal?.aborted === true ? "aborted" : "transport",
      );
    }
    if (created.status < 200 || created.status >= 300) {
      return errorFromResponse(created, "voice profile creation");
    }
    return { kind: "ok", value: `Arc Voice · ${presetVoiceId}` };
  };

  const cancelGeneration = async (generationId: string): Promise<void> => {
    try {
      await args.http.request({
        method: "POST",
        url: `${baseUrl}${voiceboxGenerationCancelPath(generationId)}`,
        headers: headers({ accept: "application/json" }),
        timeoutMs,
      });
    } catch {
      return;
    }
  };

  const sendJson = async (
    method: "POST" | "PUT",
    path: string,
    payload: Record<string, unknown>,
    label: string,
    signal?: AbortSignal,
  ): Promise<ArcVoiceHttpResponse | ArcVoiceCallResult<never>> => {
    try {
      return await args.http.request({
        method,
        url: `${baseUrl}${path}`,
        headers: headers({
          accept: "application/json",
          "content-type": "application/json",
        }),
        body: new TextEncoder().encode(JSON.stringify(payload)),
        timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      return errorFromException(
        error,
        label,
        signal?.aborted === true ? "aborted" : "transport",
      );
    }
  };

  const sendDelete = async (
    path: string,
    label: string,
    signal?: AbortSignal,
  ): Promise<ArcVoiceHttpResponse | ArcVoiceCallResult<never>> => {
    try {
      return await args.http.request({
        method: "DELETE",
        url: `${baseUrl}${path}`,
        headers: headers({ accept: "application/json" }),
        timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      return errorFromException(
        error,
        label,
        signal?.aborted === true ? "aborted" : "transport",
      );
    }
  };

  return {
    async listProfiles() {
      const response = await get(VOICEBOX_PROFILES_PATH, "application/json");
      if ("kind" in response) {
        return response;
      }
      if (response.status < 200 || response.status >= 300) {
        return errorFromResponse(response, "voice profile listing");
      }
      const parsed = profilesResponseSchema.safeParse(
        decodeJson(response.body),
      );
      if (!parsed.success) {
        return {
          kind: "error",
          code: "protocol",
          message: "voice profile listing returned an unexpected body",
        };
      }
      return { kind: "ok", value: normalizeProfiles(parsed.data) };
    },

    async listProfileDetails(options) {
      const response = await get(
        VOICEBOX_PROFILES_PATH,
        "application/json",
        options?.signal,
      );
      if ("kind" in response) {
        return response;
      }
      if (response.status < 200 || response.status >= 300) {
        return errorFromResponse(response, "voice profile listing");
      }
      const parsed = profileDetailResponseSchema.safeParse(
        decodeJson(response.body),
      );
      if (!parsed.success) {
        return {
          kind: "error",
          code: "protocol",
          message: "voice profile listing returned an unexpected body",
        };
      }
      const entries = Array.isArray(parsed.data)
        ? parsed.data
        : parsed.data.profiles;
      return {
        kind: "ok",
        value: entries.map((entry) => normalizeProfileDetail(entry)),
      };
    },

    async createProfile(createArgs) {
      const payload: Record<string, unknown> = {
        name: createArgs.name,
        language: createArgs.language,
        voice_type: createArgs.voiceType,
      };
      if (createArgs.description !== undefined) {
        payload.description = createArgs.description;
      }
      if (createArgs.presetEngine !== undefined) {
        payload.preset_engine = createArgs.presetEngine;
      }
      if (createArgs.presetVoiceId !== undefined) {
        payload.preset_voice_id = createArgs.presetVoiceId;
      }
      const response = await sendJson(
        "POST",
        VOICEBOX_PROFILES_PATH,
        payload,
        "voice profile creation",
        createArgs.signal,
      );
      if ("kind" in response) {
        return response;
      }
      if (response.status < 200 || response.status >= 300) {
        return errorFromResponse(response, "voice profile creation");
      }
      const parsed = profileDetailSchema.safeParse(
        decodeJson(response.body),
      );
      if (!parsed.success) {
        return {
          kind: "error",
          code: "protocol",
          message: "voice profile creation returned an unexpected body",
        };
      }
      return { kind: "ok", value: normalizeProfileDetail(parsed.data) };
    },

    async updateProfile(profileId, updateArgs) {
      const payload: Record<string, unknown> = {};
      if (updateArgs.name !== undefined) {
        payload.name = updateArgs.name;
      }
      if (updateArgs.description !== undefined) {
        payload.description = updateArgs.description;
      }
      const response = await sendJson(
        "PUT",
        voiceboxProfilePath(profileId),
        payload,
        "voice profile update",
        updateArgs.signal,
      );
      if ("kind" in response) {
        return response;
      }
      if (response.status < 200 || response.status >= 300) {
        return errorFromResponse(response, "voice profile update");
      }
      const parsed = profileDetailSchema.safeParse(
        decodeJson(response.body),
      );
      if (!parsed.success) {
        return {
          kind: "error",
          code: "protocol",
          message: "voice profile update returned an unexpected body",
        };
      }
      return { kind: "ok", value: normalizeProfileDetail(parsed.data) };
    },

    async deleteProfile(profileId) {
      const response = await sendDelete(
        voiceboxProfilePath(profileId),
        "voice profile deletion",
      );
      if ("kind" in response) {
        return response;
      }
      if (response.status < 200 || response.status >= 300) {
        return errorFromResponse(response, "voice profile deletion");
      }
      return { kind: "ok", value: undefined };
    },

    async addProfileSample(sampleArgs) {
      const boundary = boundaryFactory();
      const body = buildArcVoiceMultipartBody(
        [
          {
            name: "file",
            value: sampleArgs.audio,
            fileName: sampleArgs.fileName,
            contentType: sampleArgs.mimeType,
          },
          { name: "reference_text", value: sampleArgs.referenceText },
        ],
        boundary,
      );
      let response: ArcVoiceHttpResponse;
      try {
        response = await args.http.request({
          method: "POST",
          url: `${baseUrl}${voiceboxProfileSamplesPath(sampleArgs.profileId)}`,
          headers: headers({
            accept: "application/json",
            "content-type": `multipart/form-data; boundary=${boundary}`,
          }),
          body,
          timeoutMs,
          ...(sampleArgs.signal === undefined ? {} : { signal: sampleArgs.signal }),
        });
      } catch (error) {
        return errorFromException(
          error,
          "voice profile sample upload",
          sampleArgs.signal?.aborted === true ? "aborted" : "transport",
        );
      }
      if (response.status < 200 || response.status >= 300) {
        return errorFromResponse(response, "voice profile sample upload");
      }
      const parsed = profileSampleResponseSchema.safeParse(
        decodeJson(response.body),
      );
      if (!parsed.success) {
        return {
          kind: "error",
          code: "protocol",
          message: "voice profile sample upload returned an unexpected body",
        };
      }
      return { kind: "ok", value: parsed.data.id };
    },

    async removeProfileSample(sampleId) {
      const response = await sendDelete(
        voiceboxProfileSampleByIdPath(sampleId),
        "voice profile sample removal",
      );
      if ("kind" in response) {
        return response;
      }
      if (response.status < 200 || response.status >= 300) {
        return errorFromResponse(response, "voice profile sample removal");
      }
      return { kind: "ok", value: undefined };
    },

    async listPresets(engine) {
      const response = await get(
        voiceboxPresetsPath(engine),
        "application/json",
      );
      if ("kind" in response) {
        return response;
      }
      if (response.status < 200 || response.status >= 300) {
        return errorFromResponse(response, "voice preset listing");
      }
      const parsed = presetsResponseSchema.safeParse(decodeJson(response.body));
      if (!parsed.success) {
        return {
          kind: "error",
          code: "protocol",
          message: "voice preset listing returned an unexpected body",
        };
      }
      return {
        kind: "ok",
        value: parsed.data.voices.map((voice) => ({
          voiceId: voice.voice_id,
          name: voice.name ?? voice.voice_id,
          gender: voice.gender ?? "",
          language: voice.language ?? "",
        })),
      };
    },

    async listModels() {
      const response = await get(VOICEBOX_MODELS_STATUS_PATH, "application/json");
      if ("kind" in response) {
        return response;
      }
      if (response.status < 200 || response.status >= 300) {
        return errorFromResponse(response, "voice model listing");
      }
      const parsed = modelStatusResponseSchema.safeParse(
        decodeJson(response.body),
      );
      if (!parsed.success) {
        return {
          kind: "error",
          code: "protocol",
          message: "voice model listing returned an unexpected body",
        };
      }
      return {
        kind: "ok",
        value: (parsed.data.models ?? [])
          .filter((entry) => entry.model_name !== undefined)
          .map((entry) => ({
            name: entry.model_name as string,
            displayName: entry.display_name ?? (entry.model_name as string),
            downloaded: entry.downloaded ?? false,
            downloading: entry.downloading ?? false,
            loaded: entry.loaded ?? false,
          })),
      };
    },

    async downloadModel(modelName, signal) {
      const response = await sendJson(
        "POST",
        VOICEBOX_MODELS_DOWNLOAD_PATH,
        { model_name: modelName },
        "voice model download",
        signal,
      );
      if ("kind" in response) {
        return response;
      }
      if (response.status < 200 || response.status >= 300) {
        return errorFromResponse(response, "voice model download");
      }
      return { kind: "ok", value: undefined };
    },

    async cancelModelDownload(modelName) {
      const response = await sendJson(
        "POST",
        VOICEBOX_MODELS_DOWNLOAD_CANCEL_PATH,
        { model_name: modelName },
        "voice model download cancel",
      );
      if ("kind" in response) {
        return response;
      }
      if (response.status < 200 || response.status >= 300) {
        return errorFromResponse(response, "voice model download cancel");
      }
      return { kind: "ok", value: undefined };
    },

    async transcribe(transcribeArgs) {
      const boundary = boundaryFactory();
      const parts: {
        name: string;
        value: string | Uint8Array;
        fileName?: string;
        contentType?: string;
      }[] = [
        {
          name: "file",
          value: transcribeArgs.audio,
          fileName: transcribeArgs.fileName ?? "audio.wav",
          contentType: transcribeArgs.mimeType ?? "audio/wav",
        },
      ];
      if (transcribeArgs.language !== undefined) {
        parts.push({ name: "language", value: transcribeArgs.language });
      }
      if (transcribeArgs.model !== undefined) {
        parts.push({ name: "model", value: transcribeArgs.model });
      }

      const operationTimeoutMs = transcribeArgs.timeoutMs ?? timeoutMs;
      const timeoutSignal = AbortSignal.timeout(operationTimeoutMs);
      const abortSignals =
        transcribeArgs.signal === undefined
          ? [timeoutSignal]
          : [timeoutSignal, transcribeArgs.signal];
      let response: ArcVoiceHttpResponse;
      try {
        response = await args.http.request({
          method: "POST",
          url: `${baseUrl}${VOICEBOX_TRANSCRIBE_PATH}`,
          headers: headers({
            accept: "application/json",
            "content-type": `multipart/form-data; boundary=${boundary}`,
          }),
          body: buildArcVoiceMultipartBody(parts, boundary),
          signal: AbortSignal.any(abortSignals),
        });
      } catch (error) {
        return errorFromException(
          error,
          "voice transcription",
          transcribeArgs.signal?.aborted === true
            ? "aborted"
            : timeoutSignal.aborted
              ? "timeout"
              : "transport",
        );
      }
      if (response.status < 200 || response.status >= 300) {
        return errorFromResponse(response, "voice transcription");
      }
      const parsed = transcribeResponseSchema.safeParse(
        decodeJson(response.body),
      );
      if (!parsed.success) {
        return {
          kind: "error",
          code: "protocol",
          message: "voice transcription returned an unexpected body",
        };
      }
      return {
        kind: "ok",
        value: {
          text: parsed.data.text,
          ...(parsed.data.duration === undefined
            ? {}
            : { duration: parsed.data.duration }),
        },
      };
    },

    async speak(speakArgs) {
      const signal = speakArgs.signal;
      const isAborted = (): boolean => signal?.aborted === true;
      if (isAborted()) {
        return {
          kind: "error",
          code: "aborted",
          message: "voice synthesis was cancelled",
        };
      }

      const engine = speakArgs.engine ?? ttsEngine;
      let profileName = speakArgs.profile;
      if (profileName === undefined) {
        const ensured = await ensureProfile(
          engine,
          speakArgs.voiceId ?? ttsVoice,
          signal,
        );
        if (ensured.kind === "error") {
          return ensured;
        }
        profileName = ensured.value;
      }

      const payload: Record<string, string> = {
        text: speakArgs.text,
        language: speakArgs.language ?? "en",
        engine,
        profile: profileName,
      };

      let response: ArcVoiceHttpResponse;
      try {
        response = await args.http.request({
          method: "POST",
          url: `${baseUrl}${VOICEBOX_SPEAK_PATH}`,
          headers: headers({
            accept: "application/json",
            "content-type": "application/json",
          }),
          body: new TextEncoder().encode(JSON.stringify(payload)),
          timeoutMs,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        return errorFromException(
          error,
          "voice synthesis",
          isAborted() ? "aborted" : "transport",
        );
      }
      if (response.status < 200 || response.status >= 300) {
        return errorFromResponse(response, "voice synthesis");
      }

      const started = generationSchema.safeParse(decodeJson(response.body));
      if (!started.success) {
        return {
          kind: "error",
          code: "protocol",
          message: "voice synthesis returned an unexpected body",
        };
      }

      let durationMs =
        started.data.duration === undefined
          ? null
          : Math.round(started.data.duration * 1000);
      const generationId = started.data.id;
      let status = started.data.status ?? "completed";
      let detail = started.data.error ?? undefined;
      let polls = 0;
      const maxPolls = Math.ceil(speakTimeoutMs / pollIntervalMs);

      while (ACTIVE_GENERATION_STATUSES.includes(status) && polls < maxPolls) {
        if (isAborted()) {
          void cancelGeneration(generationId);
          return {
            kind: "error",
            code: "aborted",
            message: "voice synthesis was cancelled",
          };
        }
        polls += 1;
        await sleep(pollIntervalMs);
        const polled = await readGeneration(
          voiceboxGenerationStatusPath(generationId),
          signal,
        );
        if (polled.kind === "error") {
          if (polled.code === "aborted") {
            void cancelGeneration(generationId);
          }
          return polled;
        }
        status = polled.value.status;
        detail = polled.value.detail;
        if (polled.value.duration !== undefined) {
          durationMs = Math.round(polled.value.duration * 1000);
        }
      }

      if (status !== "completed") {
        const unfinished = ACTIVE_GENERATION_STATUSES.includes(status);
        if (unfinished) {
          void cancelGeneration(generationId);
        }
        return {
          kind: "error",
          code: unfinished ? "timeout" : "protocol",
          message: unfinished
            ? `voice synthesis did not finish within ${speakTimeoutMs}ms`
            : `voice synthesis ${status}${detail === undefined ? "" : `: ${detail}`}`,
        };
      }

      const audio = await get(voiceboxAudioPath(generationId), "audio/*", signal);
      if ("kind" in audio) {
        return audio;
      }
      if (audio.status < 200 || audio.status >= 300) {
        return errorFromResponse(audio, "voice audio fetch");
      }

      return {
        kind: "ok",
        value: {
          audio: audio.body,
          contentType:
            audio.headers["content-type"] ?? "application/octet-stream",
          durationMs,
        },
      };
    },

    async modelStatus() {
      const response = await get(VOICEBOX_MODELS_STATUS_PATH, "application/json");
      if ("kind" in response) {
        return response;
      }
      if (response.status < 200 || response.status >= 300) {
        return errorFromResponse(response, "voice model status");
      }
      const parsed = modelStatusResponseSchema.safeParse(
        decodeJson(response.body),
      );
      if (!parsed.success) {
        return {
          kind: "error",
          code: "protocol",
          message: "voice model status returned an unexpected body",
        };
      }
      const models = parsed.data.models ?? [];
      const whisper = models.find(
        (entry) =>
          entry.model_name !== undefined &&
          entry.model_name.startsWith("whisper-") &&
          entry.loaded === true,
      );
      const spec = ARC_VOICE_TTS_MODELS[ttsEngine];
      const voiceEntry =
        spec === undefined
          ? undefined
          : models.find((entry) => entry.model_name === spec.modelName);
      return {
        kind: "ok",
        value: {
          speech: {
            modelName: whisper?.model_name ?? null,
            loaded: whisper !== undefined,
          },
          voice:
            spec === undefined
              ? null
              : {
                  modelName: spec.modelName,
                  engine: ttsEngine,
                  size: spec.size,
                  downloaded: voiceEntry?.downloaded ?? false,
                  loaded: voiceEntry?.loaded ?? false,
                  downloading: voiceEntry?.downloading ?? false,
                },
        },
      };
    },

    async loadVoiceModel(loadArgs) {
      const timeoutSignal =
        loadArgs.timeoutMs === undefined
          ? undefined
          : AbortSignal.timeout(loadArgs.timeoutMs);
      const signals = [
        ...(timeoutSignal === undefined ? [] : [timeoutSignal]),
        ...(loadArgs.signal === undefined ? [] : [loadArgs.signal]),
      ];
      let response: ArcVoiceHttpResponse;
      try {
        response = await args.http.request({
          method: "POST",
          url: `${baseUrl}${VOICEBOX_MODELS_LOAD_PATH}?model_size=${encodeURIComponent(loadArgs.modelSize)}`,
          headers: headers({ accept: "application/json" }),
          ...(signals.length === 0 ? {} : { signal: AbortSignal.any(signals) }),
        });
      } catch (error) {
        return errorFromException(
          error,
          "voice model load",
          loadArgs.signal?.aborted === true
            ? "aborted"
            : timeoutSignal?.aborted === true
              ? "timeout"
              : "transport",
        );
      }
      if (response.status < 200 || response.status >= 300) {
        return errorFromResponse(response, "voice model load");
      }
      return { kind: "ok", value: undefined };
    },

    async unloadModels(options = {}) {
      try {
        // Voicebox 0.5.0's global /models/unload is a no-op for the resident
        // model (live-probed: it reports success but the loaded TTS model stays
        // resident). Unload each loaded model individually instead.
        const statusResponse = await get(
          VOICEBOX_MODELS_STATUS_PATH,
          "application/json",
          options.signal,
        );
        if ("kind" in statusResponse) {
          return statusResponse;
        }
        if (statusResponse.status < 200 || statusResponse.status >= 300) {
          return errorFromResponse(statusResponse, "voice model unload");
        }
        const parsed = modelStatusResponseSchema.safeParse(
          decodeJson(statusResponse.body),
        );
        if (!parsed.success) {
          return {
            kind: "error",
            code: "protocol",
            message: "voice model status returned an unexpected body",
          };
        }
        const loaded = (parsed.data.models ?? []).flatMap((entry) =>
          entry.loaded === true && typeof entry.model_name === "string"
            ? [entry.model_name]
            : [],
        );
        for (const modelName of loaded) {
          try {
            const response = await args.http.request({
              method: "POST",
              url: `${baseUrl}${VOICEBOX_MODEL_UNLOAD_PATH(modelName)}`,
              headers: headers({ accept: "application/json" }),
              ...(options.signal === undefined
                ? {}
                : { signal: options.signal }),
            });
            if (response.status < 200 || response.status >= 300) {
              return errorFromResponse(response, "voice model unload");
            }
          } catch (error) {
            return errorFromException(
              error,
              "voice model unload",
              options.signal?.aborted === true ? "aborted" : "transport",
            );
          }
        }
        return { kind: "ok", value: undefined };
      } catch (error) {
        return errorFromException(
          error,
          "voice model unload",
          options.signal?.aborted === true ? "aborted" : "transport",
        );
      }
    },

    async voiceModelProgress(modelName, options = {}) {
      const controller = new AbortController();
      const budgetSignal =
        options.timeoutMs === undefined
          ? undefined
          : AbortSignal.timeout(options.timeoutMs);
      const signal = AbortSignal.any([
        ...(budgetSignal === undefined ? [] : [budgetSignal]),
        ...(options.signal === undefined ? [] : [options.signal]),
        controller.signal,
      ]);
      const request: ArcVoiceHttpRequest = {
        method: "GET",
        url: `${baseUrl}${voiceboxModelProgressPath(modelName)}`,
        headers: headers({ accept: "text/event-stream" }),
        signal,
      };

      let buffer = "";
      let progress: number | null = null;
      let settled = false;
      try {
        await args.http.streamText(request, (chunk) => {
          if (settled) {
            return;
          }
          buffer += chunk;
          const payload = firstSseDataLine(buffer);
          if (payload === null) {
            return;
          }
          settled = true;
          progress = parseProgressLine(payload);
          controller.abort();
        });
      } catch (error) {
        if (settled) {
          return { kind: "ok", value: progress };
        }
        return errorFromException(
          error,
          "voice model progress",
          options.signal?.aborted === true
            ? "aborted"
            : budgetSignal?.aborted === true
              ? "timeout"
              : "transport",
        );
      }
      return { kind: "ok", value: progress };
    },
  };
}

export function createArcVoiceHealthCheck(args: {
  client: ArcVoiceHttpClient;
  baseUrl: string;
  path?: string;
  timeoutMs?: number;
}): () => Promise<ArcVoiceHealthResult> {
  const baseUrl = assertLoopbackUrl(args.baseUrl).replace(/\/$/, "");
  const path = args.path ?? VOICEBOX_HEALTH_PATH;
  return async () => {
    try {
      const response = await args.client.request({
        method: "GET",
        url: `${baseUrl}${path}`,
        timeoutMs: args.timeoutMs ?? 2_000,
      });
      if (response.status < 200 || response.status >= 300) {
        return {
          kind: "unhealthy",
          detail: `${path} returned HTTP ${response.status}`,
        };
      }
      const parsed = healthSchema.safeParse(decodeJson(response.body));
      if (parsed.success && parsed.data.status !== "healthy") {
        return {
          kind: "unhealthy",
          detail: `${path} reported status ${parsed.data.status}`,
        };
      }
      return {
        kind: "healthy",
        detail: `${path} returned HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        kind: "unhealthy",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

export function createFetchArcVoiceHttpClient(
  fetchImpl: typeof fetch = fetch,
): ArcVoiceHttpClient {
  const buildSignal = (request: ArcVoiceHttpRequest): AbortSignal | undefined => {
    const signals = [
      ...(request.timeoutMs === undefined
        ? []
        : [AbortSignal.timeout(request.timeoutMs)]),
      ...(request.signal === undefined ? [] : [request.signal]),
    ];
    return signals.length === 0 ? undefined : AbortSignal.any(signals);
  };

  return {
    async request(request) {
      const signal = buildSignal(request);
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(signal === undefined ? {} : { signal }),
      });
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: new Uint8Array(await response.arrayBuffer()),
      };
    },

    async streamText(request, onChunk) {
      const signal = buildSignal(request);
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (response.body === null) {
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value !== undefined) {
          onChunk(decoder.decode(value, { stream: true }));
        }
      }
      onChunk(decoder.decode());
    },
  };
}
