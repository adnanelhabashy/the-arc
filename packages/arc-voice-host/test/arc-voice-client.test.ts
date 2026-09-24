import { describe, expect, it } from "vitest";
import { ArcVoiceLoopbackViolationError } from "../src/binding.js";
import {
  createArcVoiceClient,
  createArcVoiceHealthCheck,
  createFetchArcVoiceHttpClient,
  type ArcVoiceHttpClient,
  type ArcVoiceHttpRequest,
  type ArcVoiceHttpResponse,
  type CreateArcVoiceClientArgs,
} from "../src/client.js";

const BASE_URL = "http://127.0.0.1:8787";
const BOUNDARY = "arc-voice-test-boundary";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function jsonResponse(value: unknown, status = 200): ArcVoiceHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: encoder.encode(JSON.stringify(value)),
  };
}

function createFakeHttp(
  handler: (request: ArcVoiceHttpRequest) => ArcVoiceHttpResponse,
): { http: ArcVoiceHttpClient; requests: ArcVoiceHttpRequest[] } {
  const requests: ArcVoiceHttpRequest[] = [];
  return {
    requests,
    http: {
      request(request) {
        requests.push(request);
        return Promise.resolve(handler(request));
      },
      streamText() {
        return Promise.reject(new Error("streamText is not implemented"));
      },
    },
  };
}

function createHangingHttp(): {
  http: ArcVoiceHttpClient;
  requests: ArcVoiceHttpRequest[];
} {
  const requests: ArcVoiceHttpRequest[] = [];
  return {
    requests,
    http: {
      request(request) {
        requests.push(request);
        const signal = request.signal;
        return new Promise<ArcVoiceHttpResponse>((_resolve, reject) => {
          if (signal === undefined) {
            return;
          }
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
      streamText() {
        return Promise.reject(new Error("streamText is not implemented"));
      },
    },
  };
}

function createClient(
  handler: (request: ArcVoiceHttpRequest) => ArcVoiceHttpResponse,
  extra: Partial<
    Pick<
      CreateArcVoiceClientArgs,
      "sleep" | "speakPollIntervalMs" | "speakTimeoutMs" | "timeoutMs"
    >
  > = {},
) {
  const fake = createFakeHttp(handler);
  return {
    requests: fake.requests,
    client: createArcVoiceClient({
      http: fake.http,
      baseUrl: BASE_URL,
      boundaryFactory: () => BOUNDARY,
      sleep: () => Promise.resolve(),
      ...extra,
    }),
  };
}

describe("createArcVoiceClient", () => {
  it("refuses a non-loopback base url", () => {
    const { http } = createFakeHttp(() => jsonResponse({}));
    expect(() =>
      createArcVoiceClient({ http, baseUrl: "http://192.168.1.30:8787" }),
    ).toThrow(ArcVoiceLoopbackViolationError);
  });

  it("lists profiles from GET /profiles", async () => {
    const { client, requests } = createClient(() =>
      jsonResponse([{ id: "atlas", name: "Atlas" }, { id: "nova" }]),
    );

    const result = await client.listProfiles();

    expect(result).toEqual({
      kind: "ok",
      value: [
        { id: "atlas", name: "Atlas" },
        { id: "nova", name: "nova" },
      ],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("GET");
    expect(requests[0].url).toBe(`${BASE_URL}/profiles`);
  });

  it("accepts a wrapped profiles payload and reports http failures", async () => {
    const wrapped = createClient(() =>
      jsonResponse({ profiles: [{ id: "ember", name: "Ember" }] }),
    );
    expect(await wrapped.client.listProfiles()).toEqual({
      kind: "ok",
      value: [{ id: "ember", name: "Ember" }],
    });

    const failing = createClient(() => jsonResponse({ detail: "boom" }, 503));
    const failure = await failing.client.listProfiles();
    expect(failure.kind).toBe("error");
    expect(failure.kind === "error" && failure.status).toBe(503);
  });

  it("posts multipart audio to /transcribe", async () => {
    const { client, requests } = createClient(() =>
      jsonResponse({ text: "hello arc" }),
    );

    const result = await client.transcribe({
      audio: encoder.encode("RIFF...."),
      language: "en",
      model: "turbo",
    });

    expect(result).toEqual({ kind: "ok", value: { text: "hello arc" } });
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toBe(`${BASE_URL}/transcribe`);
    expect(requests[0].headers?.["content-type"]).toBe(
      `multipart/form-data; boundary=${BOUNDARY}`,
    );
    const body = decoder.decode(requests[0].body);
    expect(body).toContain(`--${BOUNDARY}`);
    expect(body).toContain('name="file"; filename="audio.wav"');
    expect(body).toContain("Content-Type: audio/wav");
    expect(body).toContain("RIFF....");
    expect(body).toContain('name="language"');
    expect(body).toContain(`--${BOUNDARY}--`);
  });

  it("reports a transcription that outlives its operation budget as a timeout", async () => {
    const fake = createHangingHttp();
    const client = createArcVoiceClient({
      http: fake.http,
      baseUrl: BASE_URL,
      boundaryFactory: () => BOUNDARY,
      timeoutMs: 30_000,
    });

    const started = Date.now();
    const result = await client.transcribe({
      audio: encoder.encode("x"),
      timeoutMs: 60,
    });

    expect(result).toMatchObject({ kind: "error", code: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fake.requests[0]?.signal?.aborted).toBe(true);
  });

  it("uses the client request budget when a transcription names none", async () => {
    const fake = createHangingHttp();
    const client = createArcVoiceClient({
      http: fake.http,
      baseUrl: BASE_URL,
      boundaryFactory: () => BOUNDARY,
      timeoutMs: 60,
    });

    await expect(
      client.transcribe({ audio: encoder.encode("x") }),
    ).resolves.toMatchObject({ kind: "error", code: "timeout" });
  });

  it("reports a cancelled transcription as aborted without waiting for the budget", async () => {
    const fake = createHangingHttp();
    const client = createArcVoiceClient({
      http: fake.http,
      baseUrl: BASE_URL,
      boundaryFactory: () => BOUNDARY,
      timeoutMs: 30_000,
    });
    const controller = new AbortController();

    const started = Date.now();
    const pending = client.transcribe({
      audio: encoder.encode("x"),
      signal: controller.signal,
      timeoutMs: 30_000,
    });
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      kind: "error",
      code: "aborted",
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("accepts a transcription payload and rejects malformed bodies", async () => {
    const populated = createClient(() =>
      jsonResponse({ text: "hi", duration: 1.5 }),
    );
    expect(
      await populated.client.transcribe({ audio: encoder.encode("x") }),
    ).toEqual({
      kind: "ok",
      value: { text: "hi", duration: 1.5 },
    });

    const malformed = createClient(() => jsonResponse({ unexpected: true }));
    const failure = await malformed.client.transcribe({
      audio: encoder.encode("x"),
    });
    expect(failure.kind).toBe("error");
  });

  it("posts speak requests, polls the generation, and fetches the audio", async () => {
    const audio = encoder.encode("WAVDATA");
    const { client, requests } = createClient((request) =>
      request.url.endsWith("/speak")
        ? jsonResponse({ id: "gen-1", status: "generating" })
        : request.url.endsWith("/history/gen-1")
          ? jsonResponse({ id: "gen-1", status: "completed" })
          : {
              status: 200,
              headers: { "content-type": "audio/wav" },
              body: audio,
            },
    );

    const result = await client.speak({
      text: "Arc is ready",
      profile: "atlas",
    });

    expect(result).toEqual({
      kind: "ok",
      value: { audio, contentType: "audio/wav", durationMs: null },
    });
    expect(requests.map((request) => request.url)).toEqual([
      `${BASE_URL}/speak`,
      `${BASE_URL}/history/gen-1`,
      `${BASE_URL}/audio/gen-1`,
    ]);
    expect(requests[0].headers?.["content-type"]).toBe("application/json");
    expect(JSON.parse(decoder.decode(requests[0].body))).toEqual({
      text: "Arc is ready",
      language: "en",
      profile: "atlas",
      engine: "kokoro",
    });
  });

  it("skips polling when the generation already completed", async () => {
    const audio = encoder.encode("WAVDATA");
    const { client, requests } = createClient((request) => {
      if (request.url.endsWith("/profiles")) {
        return request.method === "GET"
          ? jsonResponse([])
          : jsonResponse({ id: "profile-1", name: "Arc Voice" });
      }
      return request.url.endsWith("/speak")
        ? jsonResponse({ id: "gen-2", status: "completed" })
        : {
            status: 200,
            headers: { "content-type": "audio/wav" },
            body: audio,
          };
    });

    await client.speak({ text: "hello" });

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `GET ${BASE_URL}/profiles`,
      `POST ${BASE_URL}/profiles`,
      `POST ${BASE_URL}/speak`,
      `GET ${BASE_URL}/audio/gen-2`,
    ]);
  });

  it("reports a failed generation without fetching audio", async () => {
    const { client, requests } = createClient((request) => {
      if (request.url.endsWith("/profiles")) {
        return jsonResponse([
          {
            id: "profile-1",
            name: "Arc Voice · af_heart",
            voice_type: "preset",
            preset_engine: "kokoro",
            preset_voice_id: "af_heart",
          },
        ]);
      }
      return request.url.endsWith("/speak")
        ? jsonResponse({ id: "gen-3", status: "generating" })
        : jsonResponse({
            id: "gen-3",
            status: "failed",
            error: "model missing",
          });
    });

    const result = await client.speak({ text: "hello" });

    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.message).toContain(
      "model missing",
    );
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `GET ${BASE_URL}/profiles`,
      `POST ${BASE_URL}/speak`,
      `GET ${BASE_URL}/history/gen-3`,
    ]);
  });

  it("gives up when a generation never reaches a terminal status", async () => {
    const { client } = createClient(
      () => jsonResponse({ id: "gen-4", status: "generating" }),
      { speakPollIntervalMs: 1_000, speakTimeoutMs: 3_000 },
    );

    const result = await client.speak({ text: "hello" });

    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.message).toContain(
      "did not finish",
    );
  });

  it("reports speak failures without throwing", async () => {
    const { client } = createClient(() =>
      jsonResponse({ detail: "no voice" }, 500),
    );
    const failure = await client.speak({ text: "hello" });
    expect(failure.kind).toBe("error");
    expect(failure.kind === "error" && failure.message).toContain("HTTP 500");
  });

  it("lists profile details with sample counts from GET /profiles", async () => {
    const { client, requests } = createClient(() =>
      jsonResponse([
        {
          id: "p1",
          name: "My Voice",
          description: null,
          language: "en",
          voice_type: "cloned",
          sample_count: 2,
        },
        {
          id: "p2",
          name: "Arc Voice",
          voice_type: "preset",
          preset_engine: "kokoro",
          preset_voice_id: "af_heart",
        },
      ]),
    );
    const result = await client.listProfileDetails();
    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" && result.value).toEqual([
      {
        id: "p1",
        name: "My Voice",
        description: null,
        language: "en",
        voiceType: "cloned",
        presetEngine: null,
        presetVoiceId: null,
        sampleCount: 2,
      },
      {
        id: "p2",
        name: "Arc Voice",
        description: null,
        language: "en",
        voiceType: "preset",
        presetEngine: "kokoro",
        presetVoiceId: "af_heart",
        sampleCount: 0,
      },
    ]);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toBe(`${BASE_URL}/profiles`);
  });

  it("creates a cloned profile through POST /profiles", async () => {
    const { client, requests } = createClient((request) => {
      expect(request.method).toBe("POST");
      return jsonResponse({
        id: "new-1",
        name: "My Voice",
        language: "en",
        voice_type: "cloned",
        sample_count: 0,
      });
    });
    const result = await client.createProfile({
      name: "My Voice",
      language: "en",
      voiceType: "cloned",
    });
    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" && result.value.id).toBe("new-1");
    const body = decoder.decode(requests[0]?.body ?? new Uint8Array());
    expect(body).toContain('"voice_type":"cloned"');
    expect(body).not.toContain("preset_engine");
  });

  it("renames a profile through PUT /profiles/{id}", async () => {
    const { client, requests } = createClient(() =>
      jsonResponse({ id: "p1", name: "Renamed", sample_count: 1 }),
    );
    const result = await client.updateProfile("p1", { name: "Renamed" });
    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" && result.value.name).toBe("Renamed");
    expect(requests[0]?.method).toBe("PUT");
    expect(requests[0]?.url).toBe(`${BASE_URL}/profiles/p1`);
  });

  it("deletes a profile through DELETE /profiles/{id}", async () => {
    const { client, requests } = createClient(() => jsonResponse({}));
    const result = await client.deleteProfile("p1");
    expect(result.kind).toBe("ok");
    expect(requests[0]?.method).toBe("DELETE");
    expect(requests[0]?.url).toBe(`${BASE_URL}/profiles/p1`);
  });

  it("uploads a sample with reference text as multipart", async () => {
    const { client, requests } = createClient(() =>
      jsonResponse({
        id: "s1",
        profile_id: "p1",
        audio_path: "profiles/p1/s1.wav",
        reference_text: "hello",
      }),
    );
    const result = await client.addProfileSample({
      profileId: "p1",
      audio: encoder.encode("RIFF...."),
      fileName: "sample.wav",
      mimeType: "audio/wav",
      referenceText: "The exact words spoken.",
    });
    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" && result.value).toBe("s1");
    const request = requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe(`${BASE_URL}/profiles/p1/samples`);
    const body = decoder.decode(request?.body ?? new Uint8Array());
    expect(body).toContain('name="reference_text"');
    expect(body).toContain("The exact words spoken.");
    expect(body).toContain('filename="sample.wav"');
  });

  it("removes a sample through DELETE /profiles/samples/{id}", async () => {
    const { client, requests } = createClient(() => jsonResponse({}));
    const result = await client.removeProfileSample("s1");
    expect(result.kind).toBe("ok");
    expect(requests[0]?.method).toBe("DELETE");
    expect(requests[0]?.url).toBe(`${BASE_URL}/profiles/samples/s1`);
  });

  it("lists presets from GET /profiles/presets/{engine}", async () => {
    const { client, requests } = createClient(() =>
      jsonResponse({
        engine: "kokoro",
        voices: [
          { voice_id: "af_heart", name: "Heart", gender: "female", language: "en" },
          { voice_id: "am_adam", name: "Adam" },
        ],
      }),
    );
    const result = await client.listPresets("kokoro");
    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" && result.value).toEqual([
      {
        voiceId: "af_heart",
        name: "Heart",
        gender: "female",
        language: "en",
      },
      { voiceId: "am_adam", name: "Adam", gender: "", language: "" },
    ]);
    expect(requests[0]?.url).toBe(`${BASE_URL}/profiles/presets/kokoro`);
  });

  it("lists models with display names from GET /models/status", async () => {
    const { client } = createClient(() =>
      jsonResponse({
        models: [
          {
            model_name: "kokoro",
            display_name: "Kokoro",
            downloaded: true,
            downloading: false,
            loaded: true,
          },
          {
            model_name: "whisper-turbo",
            display_name: "Whisper Turbo",
            downloaded: false,
            downloading: true,
            loaded: false,
          },
        ],
      }),
    );
    const result = await client.listModels();
    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" && result.value).toEqual([
      {
        name: "kokoro",
        displayName: "Kokoro",
        downloaded: true,
        downloading: false,
        loaded: true,
      },
      {
        name: "whisper-turbo",
        displayName: "Whisper Turbo",
        downloaded: false,
        downloading: true,
        loaded: false,
      },
    ]);
  });

  it("triggers and cancels model downloads", async () => {
    const { client, requests } = createClient(() => jsonResponse({ started: true }));
    const downloaded = await client.downloadModel("qwen-custom-voice-0.6B");
    expect(downloaded.kind).toBe("ok");
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toBe(`${BASE_URL}/models/download`);
    expect(decoder.decode(requests[0]?.body ?? new Uint8Array())).toBe(
      '{"model_name":"qwen-custom-voice-0.6B"}',
    );

    const cancelled = await client.cancelModelDownload("qwen-custom-voice-0.6B");
    expect(cancelled.kind).toBe("ok");
    expect(requests[1]?.url).toBe(`${BASE_URL}/models/download/cancel`);
  });

  it("speaks a selected preset through its own Arc Voice profile", async () => {
    const seen: string[] = [];
    const { client, requests } = createClient((request) => {
      seen.push(`${request.method} ${request.url}`);
      if (request.url === `${BASE_URL}/profiles`) {
        return jsonResponse([]);
      }
      if (request.url === `${BASE_URL}/speak`) {
        return jsonResponse({ id: "gen-1", status: "completed", duration: 0.5 });
      }
      return jsonResponse({ status: "completed", duration: 0.5 });
    });

    const result = await client.speak({
      text: "hello",
      engine: "kokoro",
      voiceId: "af_bella",
    });

    expect(result.kind).toBe("ok");
    const created = requests.find(
      (request) =>
        request.method === "POST" && request.url === `${BASE_URL}/profiles`,
    );
    expect(created).not.toBeUndefined();
    const body = decoder.decode(created?.body ?? new Uint8Array());
    expect(body).toContain('"name":"Arc Voice · af_bella"');
    expect(body).toContain('"preset_voice_id":"af_bella"');
    const speakRequest = requests.find(
      (request) => request.method === "POST" && request.url === `${BASE_URL}/speak`,
    );
    const speakBody = decoder.decode(speakRequest?.body ?? new Uint8Array());
    expect(speakBody).toContain('"profile":"Arc Voice · af_bella"');
  });

  it("reuses an existing per-preset profile instead of creating a duplicate", async () => {
    const { client, requests } = createClient((request) => {
      if (request.url === `${BASE_URL}/profiles`) {
        return jsonResponse([
          {
            id: "p7",
            name: "Arc Voice · af_heart",
            voice_type: "preset",
            preset_engine: "kokoro",
            preset_voice_id: "af_heart",
          },
        ]);
      }
      return jsonResponse({ id: "gen-2", status: "completed", duration: 0.5 });
    });

    const result = await client.speak({ text: "hello", voiceId: "af_heart" });

    expect(result.kind).toBe("ok");
    expect(
      requests.some(
        (request) =>
          request.method === "POST" && request.url === `${BASE_URL}/profiles`,
      ),
    ).toBe(false);
  });

  it("ignores a user profile that merely shares the preset profile name", async () => {
    const { client, requests } = createClient((request) => {
      if (request.url === `${BASE_URL}/profiles`) {
        return jsonResponse([
          {
            id: "user-1",
            name: "Arc Voice · af_heart",
            voice_type: "cloned",
            sample_count: 1,
          },
        ]);
      }
      return jsonResponse({ id: "gen-3", status: "completed", duration: 0.5 });
    });

    const result = await client.speak({ text: "hello", voiceId: "af_heart" });

    expect(result.kind).toBe("ok");
    const created = requests.find(
      (request) =>
        request.method === "POST" && request.url === `${BASE_URL}/profiles`,
    );
    expect(created).not.toBeUndefined();
    const speakRequest = requests.find(
      (request) =>
        request.method === "POST" && request.url === `${BASE_URL}/speak`,
    );
    const body = decoder.decode(speakRequest?.body ?? new Uint8Array());
    expect(body).toContain('"profile":"Arc Voice · af_heart"');
    expect(body).not.toContain('"profile":"user-1"');
  });
});

describe("createFetchArcVoiceHttpClient", () => {
  it("forwards a caller signal alongside the request timeout", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const client = createFetchArcVoiceHttpClient(fetchImpl);
    const controller = new AbortController();

    await client.request({
      method: "GET",
      url: `${BASE_URL}/health`,
      timeoutMs: 1_000,
      signal: controller.signal,
    });

    const signal = calls[0].init?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });

  it("omits the fetch signal when the caller supplies neither timeout nor signal", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const client = createFetchArcVoiceHttpClient(fetchImpl);

    await client.request({ method: "GET", url: `${BASE_URL}/health` });

    expect(calls[0].init?.signal).toBeUndefined();
  });

  it("maps fetch requests and responses onto the http seam", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 201,
          headers: { "content-type": "audio/wav" },
        }),
      );
    };
    const client = createFetchArcVoiceHttpClient(fetchImpl);

    const response = await client.request({
      method: "POST",
      url: `${BASE_URL}/speak`,
      headers: { "content-type": "application/json" },
      body: encoder.encode("{}"),
    });

    expect(response.status).toBe(201);
    expect(response.headers["content-type"]).toBe("audio/wav");
    expect([...response.body]).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE_URL}/speak`);
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.body).toBeDefined();
  });
});

describe("createArcVoiceHealthCheck", () => {
  it("reports healthy on a 2xx probe and unhealthy otherwise", async () => {
    const healthy = createArcVoiceHealthCheck({
      client: createFakeHttp(() => jsonResponse({ ok: true })).http,
      baseUrl: BASE_URL,
    });
    expect((await healthy()).kind).toBe("healthy");

    const unhealthy = createArcVoiceHealthCheck({
      client: createFakeHttp(() => jsonResponse({}, 503)).http,
      baseUrl: BASE_URL,
    });
    expect((await unhealthy()).kind).toBe("unhealthy");
  });

  it("reports unhealthy when the runtime reports a non-healthy status", async () => {
    const check = createArcVoiceHealthCheck({
      client: createFakeHttp(() =>
        jsonResponse({ status: "starting", gpu_available: false }),
      ).http,
      baseUrl: BASE_URL,
    });

    expect(await check()).toEqual({
      kind: "unhealthy",
      detail: "/health reported status starting",
    });
  });

  it("reports unhealthy when the probe cannot reach the runtime", async () => {
    const check = createArcVoiceHealthCheck({
      client: {
        request() {
          return Promise.reject(new Error("ECONNREFUSED"));
        },
        streamText() {
          return Promise.reject(new Error("not implemented"));
        },
      },
      baseUrl: BASE_URL,
    });

    const result = await check();
    expect(result).toEqual({ kind: "unhealthy", detail: "ECONNREFUSED" });
  });
});

describe("createArcVoiceClient model APIs", () => {
  it("maps the loaded whisper model and the configured voice model", async () => {
    const { client } = createClient(() =>
      jsonResponse({
        models: [
          {
            model_name: "whisper-base",
            downloaded: true,
            downloading: false,
            loaded: true,
          },
          {
            model_name: "kokoro",
            downloaded: true,
            downloading: false,
            loaded: true,
          },
        ],
      }),
    );

    expect(await client.modelStatus()).toEqual({
      kind: "ok",
      value: {
        speech: { modelName: "whisper-base", loaded: true },
        voice: {
          modelName: "kokoro",
          engine: "kokoro",
          size: "",
          downloaded: true,
          loaded: true,
          downloading: false,
        },
      },
    });
  });

  it("reports the whisper model unloaded when none is resident", async () => {
    const { client } = createClient(() =>
      jsonResponse({ models: [{ model_name: "whisper-base", loaded: false }] }),
    );

    const result = await client.modelStatus();
    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" && result.value.speech).toEqual({
      modelName: null,
      loaded: false,
    });
  });

  it("reports a null voice model for an unknown engine", async () => {
    const fake = createFakeHttp(() => jsonResponse({ models: [] }));
    const client = createArcVoiceClient({
      http: fake.http,
      baseUrl: BASE_URL,
      ttsEngine: "unknown-engine",
    });

    expect(await client.modelStatus()).toEqual({
      kind: "ok",
      value: { speech: { modelName: null, loaded: false }, voice: null },
    });
  });

  it("posts the model size to /models/load and honours an abort", async () => {
    const fake = createHangingHttp();
    const client = createArcVoiceClient({
      http: fake.http,
      baseUrl: BASE_URL,
      timeoutMs: 30_000,
    });
    const controller = new AbortController();

    const pending = client.loadVoiceModel({
      modelSize: "0.6B",
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      kind: "error",
      code: "aborted",
    });
    expect(fake.requests[0]?.method).toBe("POST");
    expect(fake.requests[0]?.url).toBe(`${BASE_URL}/models/load?model_size=0.6B`);
  });

  it("parses the first SSE data line of model progress", async () => {
    const requests: ArcVoiceHttpRequest[] = [];
    const http: ArcVoiceHttpClient = {
      request: (request) => {
        requests.push(request);
        return Promise.resolve({
          status: 200,
          headers: {},
          body: new Uint8Array(),
        });
      },
      streamText: (request, onChunk) => {
        requests.push(request);
        onChunk('data: {"progress":50}\n\ndata: {"progress":99}\n');
        return Promise.resolve();
      },
    };
    const client = createArcVoiceClient({ http, baseUrl: BASE_URL });

    expect(await client.voiceModelProgress("kokoro")).toEqual({
      kind: "ok",
      value: 0.5,
    });
    expect(requests[0]?.url).toBe(`${BASE_URL}/models/progress/kokoro`);
  });

  it("returns null when the progress line is missing or unparseable", async () => {
    const http: ArcVoiceHttpClient = {
      request: () =>
        Promise.resolve({ status: 200, headers: {}, body: new Uint8Array() }),
      streamText: (_request, onChunk) => {
        onChunk('data: {"no_progress":true}\n');
        return Promise.resolve();
      },
    };
    const client = createArcVoiceClient({ http, baseUrl: BASE_URL });

    expect(await client.voiceModelProgress("kokoro")).toEqual({
      kind: "ok",
      value: null,
    });
  });
});

describe("createArcVoiceClient unloadModels", () => {
  it("unloads each loaded model individually", async () => {
    const fake = createFakeHttp((request) => {
      if (request.url.endsWith("/models/status")) {
        return jsonResponse({
          models: [
            {
              model_name: "whisper-base",
              downloaded: true,
              downloading: false,
              loaded: true,
            },
            {
              model_name: "kokoro",
              downloaded: true,
              downloading: false,
              loaded: true,
            },
            {
              model_name: "qwen-tts-1.7B",
              downloaded: true,
              downloading: false,
              loaded: false,
            },
          ],
        });
      }
      return jsonResponse({ message: "unloaded" });
    });
    const client = createArcVoiceClient({ http: fake.http, baseUrl: BASE_URL });

    const result = await client.unloadModels();

    expect(result).toEqual({ kind: "ok", value: undefined });
    const unloadUrls = fake.requests
      .map((request) => request.url)
      .filter((url) => url.includes("/unload"));
    expect(unloadUrls).toEqual([
      `${BASE_URL}/models/whisper-base/unload`,
      `${BASE_URL}/models/kokoro/unload`,
    ]);
  });

  it("is a no-op when no models are loaded", async () => {
    const fake = createFakeHttp((request) =>
      request.url.endsWith("/models/status")
        ? jsonResponse({ models: [] })
        : jsonResponse({ message: "unloaded" }),
    );
    const client = createArcVoiceClient({ http: fake.http, baseUrl: BASE_URL });

    const result = await client.unloadModels();

    expect(result).toEqual({ kind: "ok", value: undefined });
    expect(
      fake.requests.filter((request) => request.method === "POST"),
    ).toHaveLength(0);
  });
});
