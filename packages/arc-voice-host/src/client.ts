import { z } from "zod";
import { assertLoopbackUrl } from "./binding.js";
import { defaultArcVoiceSleep, type ArcVoiceHealthResult } from "./health.js";

export interface ArcVoiceHttpRequest {
  method: "GET" | "POST";
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
}

export interface ArcVoiceProfile {
  id: string;
  name: string;
}

export type ArcVoiceCallResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "error"; message: string; status?: number };

export interface ArcVoiceTranscribeArgs {
  audio: Uint8Array;
  fileName?: string;
  mimeType?: string;
  language?: string;
  model?: string;
  signal?: AbortSignal;
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
}

export interface ArcVoiceSpeakOutput {
  audio: Uint8Array;
  contentType: string;
}

export interface ArcVoiceClient {
  listProfiles(): Promise<ArcVoiceCallResult<readonly ArcVoiceProfile[]>>;
  transcribe(
    args: ArcVoiceTranscribeArgs,
  ): Promise<ArcVoiceCallResult<ArcVoiceTranscribeOutput>>;
  speak(
    args: ArcVoiceSpeakArgs,
  ): Promise<ArcVoiceCallResult<ArcVoiceSpeakOutput>>;
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

export function voiceboxGenerationStatusPath(generationId: string): string {
  return `/history/${encodeURIComponent(generationId)}`;
}

export function voiceboxAudioPath(generationId: string): string {
  return `/audio/${encodeURIComponent(generationId)}`;
}

const profileSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
});

const profilesResponseSchema = z.union([
  z.array(profileSchema),
  z.object({ profiles: z.array(profileSchema) }),
]);

const transcribeResponseSchema = z.object({
  text: z.string(),
  duration: z.number().optional(),
});

const generationSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  error: z.string().nullish(),
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

function errorFromResponse(
  response: ArcVoiceHttpResponse,
  label: string,
): ArcVoiceCallResult<never> {
  const detail = decoder.decode(response.body).slice(0, 200).trim();
  return {
    kind: "error",
    message: `${label} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    status: response.status,
  };
}

function errorFromException(
  error: unknown,
  label: string,
): ArcVoiceCallResult<never> {
  return {
    kind: "error",
    message: `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
  };
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
  const headers = (extra: Record<string, string>): Record<string, string> => ({
    ...(args.token === undefined
      ? {}
      : { authorization: `Bearer ${args.token}` }),
    ...extra,
  });

  const get = async (
    path: string,
    accept: string,
  ): Promise<ArcVoiceHttpResponse | ArcVoiceCallResult<never>> => {
    try {
      return await args.http.request({
        method: "GET",
        url: `${baseUrl}${path}`,
        headers: headers({ accept }),
        timeoutMs,
      });
    } catch (error) {
      return errorFromException(error, "voice request");
    }
  };

  const readGeneration = async (
    path: string,
  ): Promise<
    | { kind: "ok"; value: { status: string; detail: string | undefined } }
    | ArcVoiceCallResult<never>
  > => {
    const response = await get(path, "application/json");
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
        message: "voice generation status returned an unexpected body",
      };
    }
    return {
      kind: "ok",
      value: {
        status: parsed.data.status ?? "completed",
        detail: parsed.data.error ?? undefined,
      },
    };
  };

  return {
    async listProfiles() {
      const response = await get("/profiles", "application/json");
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
          message: "voice profile listing returned an unexpected body",
        };
      }
      return { kind: "ok", value: normalizeProfiles(parsed.data) };
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
          timeoutMs,
          ...(transcribeArgs.signal === undefined
            ? {}
            : { signal: transcribeArgs.signal }),
        });
      } catch (error) {
        return errorFromException(error, "voice transcription");
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
      const payload: Record<string, string> = {
        text: speakArgs.text,
        language: speakArgs.language ?? "en",
      };
      if (speakArgs.profile !== undefined) {
        payload.profile = speakArgs.profile;
      }
      if (speakArgs.engine !== undefined) {
        payload.engine = speakArgs.engine;
      }

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
        });
      } catch (error) {
        return errorFromException(error, "voice synthesis");
      }
      if (response.status < 200 || response.status >= 300) {
        return errorFromResponse(response, "voice synthesis");
      }

      const started = generationSchema.safeParse(decodeJson(response.body));
      if (!started.success) {
        return {
          kind: "error",
          message: "voice synthesis returned an unexpected body",
        };
      }

      const generationId = started.data.id;
      let status = started.data.status ?? "completed";
      let detail = started.data.error ?? undefined;
      let polls = 0;
      const maxPolls = Math.ceil(speakTimeoutMs / pollIntervalMs);

      while (ACTIVE_GENERATION_STATUSES.includes(status) && polls < maxPolls) {
        polls += 1;
        await sleep(pollIntervalMs);
        const polled = await readGeneration(
          voiceboxGenerationStatusPath(generationId),
        );
        if (polled.kind === "error") {
          return polled;
        }
        status = polled.value.status;
        detail = polled.value.detail;
      }

      if (status !== "completed") {
        return {
          kind: "error",
          message: ACTIVE_GENERATION_STATUSES.includes(status)
            ? `voice synthesis did not finish within ${speakTimeoutMs}ms`
            : `voice synthesis ${status}${detail === undefined ? "" : `: ${detail}`}`,
        };
      }

      const audio = await get(voiceboxAudioPath(generationId), "audio/*");
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
        },
      };
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
  return {
    async request(request) {
      const signals = [
        ...(request.timeoutMs === undefined
          ? []
          : [AbortSignal.timeout(request.timeoutMs)]),
        ...(request.signal === undefined ? [] : [request.signal]),
      ];
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(signals.length === 0 ? {} : { signal: AbortSignal.any(signals) }),
      });
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: new Uint8Array(await response.arrayBuffer()),
      };
    },
  };
}
