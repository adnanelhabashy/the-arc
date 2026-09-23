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
    },
  };
}

function createClient(
  handler: (request: ArcVoiceHttpRequest) => ArcVoiceHttpResponse,
  extra: Partial<
    Pick<
      CreateArcVoiceClientArgs,
      "sleep" | "speakPollIntervalMs" | "speakTimeoutMs"
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

  it("forwards the caller signal into the transcription request", async () => {
    const { client, requests } = createClient(() =>
      jsonResponse({ text: "hello arc" }),
    );
    const controller = new AbortController();

    await client.transcribe({
      audio: encoder.encode("x"),
      signal: controller.signal,
    });

    expect(requests[0].signal).toBe(controller.signal);
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
      value: { audio, contentType: "audio/wav" },
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
    });
  });

  it("skips polling when the generation already completed", async () => {
    const audio = encoder.encode("WAVDATA");
    const { client, requests } = createClient((request) =>
      request.url.endsWith("/speak")
        ? jsonResponse({ id: "gen-2", status: "completed" })
        : {
            status: 200,
            headers: { "content-type": "audio/wav" },
            body: audio,
          },
    );

    await client.speak({ text: "hello" });

    expect(requests.map((request) => request.url)).toEqual([
      `${BASE_URL}/speak`,
      `${BASE_URL}/audio/gen-2`,
    ]);
  });

  it("reports a failed generation without fetching audio", async () => {
    const { client, requests } = createClient((request) =>
      request.url.endsWith("/speak")
        ? jsonResponse({ id: "gen-3", status: "generating" })
        : jsonResponse({
            id: "gen-3",
            status: "failed",
            error: "model missing",
          }),
    );

    const result = await client.speak({ text: "hello" });

    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.message).toContain(
      "model missing",
    );
    expect(requests).toHaveLength(2);
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
      },
      baseUrl: BASE_URL,
    });

    const result = await check();
    expect(result).toEqual({ kind: "unhealthy", detail: "ECONNREFUSED" });
  });
});
