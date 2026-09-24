import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import type {
  ExperimentalAiVoiceCapabilitiesOutput,
  ExperimentalAiVoiceProfilesOutput,
  ExperimentalAiVoiceRepairOutput,
  ExperimentalAiVoiceSpeakInput,
  ExperimentalAiVoiceSpeakOutput,
  ExperimentalAiVoiceStatusInput,
  ExperimentalAiVoiceStatusOutput,
  ExperimentalAiVoiceTranscribeInput,
  ExperimentalAiVoiceTranscribeOutput,
} from "@get-bb/plugin-sdk/ai-services";
import type { ExperimentalHostRpcContext } from "@get-bb/plugin-sdk/host";
import type {
  ArcVoiceCallResult,
  ArcVoiceSpeakArgs,
  ArcVoiceSpeakOutput,
  ArcVoiceSpeechStatus,
  ArcVoiceTranscribeArgs,
} from "bb-arc-voice-host";
import {
  ARC_VOICE_DEFAULT_MODEL,
  ARC_VOICE_SERVICE_ID,
  createArcVoiceHostEntry,
  resolveArcVoiceHostConfig,
  type ArcVoiceHostConfig,
  type ArcVoiceTranscriptionService,
} from "../src/voice-host.js";

const ARC_ENV = {
  ARC_VOICE_RUNTIME_ROOT: "/arc/userData",
  ARC_VOICE_SEED_ROOT: "/arc/resources/arc-runtimes",
  ARC_VOICE_APP_VERSION: "1.2.3",
};

function hostContext(signal: AbortSignal = new AbortController().signal) {
  return {
    signal,
    lifecycle: { signal: new AbortController().signal },
    experimental_paths: { dataDir: "/tmp/arc-voice-data", tempDir: "/tmp" },
    experimental_emitSignal: () => {
      throw new Error("no signal is emitted by the voice host");
    },
    experimental_watch: () => {
      throw new Error("the voice host watches nothing");
    },
    experimental_retainWorker: () => {
      throw new Error("the voice host retains no worker");
    },
  } satisfies ExperimentalHostRpcContext;
}

function pcmWavBytes(frames = 2): Buffer {
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + frames * 2, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24);
  bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(frames * 2, 40);
  return bytes;
}

function transcribeInput(
  overrides: Partial<ExperimentalAiVoiceTranscribeInput> = {},
): ExperimentalAiVoiceTranscribeInput {
  return {
    serviceId: ARC_VOICE_SERVICE_ID,
    model: ARC_VOICE_DEFAULT_MODEL,
    language: null,
    audioBase64: pcmWavBytes().toString("base64"),
    mimeType: "audio/wav",
    filename: "recording.wav",
    prompt: null,
    timeoutMs: 120_000,
    ...overrides,
  };
}

function speakInput(
  overrides: Partial<ExperimentalAiVoiceSpeakInput> = {},
): ExperimentalAiVoiceSpeakInput {
  return {
    serviceId: ARC_VOICE_SERVICE_ID,
    text: "Hello there",
    language: null,
    profile: null,
    engine: null,
    voiceId: null,
    timeoutMs: 180_000,
    ...overrides,
  };
}

function fakeService(
  result: ArcVoiceCallResult<{ text: string }> = {
    kind: "ok",
    value: { text: "hello arc" },
  },
  speakResult: ArcVoiceCallResult<ArcVoiceSpeakOutput> = {
    kind: "ok",
    value: {
      audio: new Uint8Array([1]),
      contentType: "audio/wav",
      durationMs: null,
    },
  },
  statusResult: ArcVoiceCallResult<ArcVoiceSpeechStatus> = {
    kind: "ok",
    value: {
      runtimeState: "ready",
      version: "0.5.0",
      speechModelLoaded: true,
      voiceModel: null,
    },
  },
): {
  service: ArcVoiceTranscriptionService;
  calls: ArcVoiceTranscribeArgs[];
  speakCalls: ArcVoiceSpeakArgs[];
  stop: ReturnType<typeof vi.fn>;
} {
  const calls: ArcVoiceTranscribeArgs[] = [];
  const speakCalls: ArcVoiceSpeakArgs[] = [];
  const stop = vi.fn(async () => ({ kind: "not-running", detail: "stopped" }));
  const unavailable = <T>(): Promise<ArcVoiceCallResult<T>> =>
    Promise.resolve({ kind: "error", code: "unavailable", message: "unused" });
  return {
    calls,
    speakCalls,
    stop,
    service: {
      transcribe: (args) => {
        calls.push(args);
        return Promise.resolve(result);
      },
      speechStatus: () => Promise.resolve(statusResult),
      speak: (args) => {
        speakCalls.push(args);
        return Promise.resolve(speakResult);
      },
      listProfileDetails: () => unavailable(),
      createProfile: () => unavailable(),
      updateProfile: () => unavailable(),
      deleteProfile: () => unavailable(),
      addProfileSample: () => unavailable(),
      removeProfileSample: () => unavailable(),
      capabilities: () => unavailable(),
      downloadModel: () => unavailable(),
      cancelModelDownload: () => unavailable(),
      prepareForSpeech: () =>
        Promise.resolve({ kind: "ok", value: { runtimeState: "ready" } }),
      release: () =>
        Promise.resolve({ kind: "ok", value: { runtimeState: "stopped" } }),
      unloadModels: () =>
        Promise.resolve({ kind: "ok", value: undefined }),
      repair: () =>
        Promise.resolve({ kind: "healthy", version: "0.5.0", detail: "ok" }),
      stop,
    },
  };
}

function buildHost(
  args: {
    env?: NodeJS.ProcessEnv;
    result?: ArcVoiceCallResult<{ text: string }>;
    speakResult?: ArcVoiceCallResult<ArcVoiceSpeakOutput>;
    statusResult?: ArcVoiceCallResult<ArcVoiceSpeechStatus>;
  } = {},
) {
  const fake = fakeService(args.result, args.speakResult, args.statusResult);
  const created: ArcVoiceHostConfig[] = [];
  const entry = createArcVoiceHostEntry({
    env: args.env ?? ARC_ENV,
    platform: "darwin",
    arch: "arm64",
    createService: (config) => {
      created.push(config);
      return fake.service;
    },
  });
  const transcribe = (
    input: ExperimentalAiVoiceTranscribeInput = transcribeInput(),
    context: ExperimentalHostRpcContext = hostContext(),
  ) =>
    entry.handlers["ai.voice.transcribe"](
      input,
      context,
    ) as Promise<ExperimentalAiVoiceTranscribeOutput>;
  const speak = (
    input: ExperimentalAiVoiceSpeakInput = speakInput(),
    context: ExperimentalHostRpcContext = hostContext(),
  ) =>
    entry.handlers["ai.voice.speak"](
      input,
      context,
    ) as Promise<ExperimentalAiVoiceSpeakOutput>;
  const status = (
    input: ExperimentalAiVoiceStatusInput = { serviceId: ARC_VOICE_SERVICE_ID },
    context: ExperimentalHostRpcContext = hostContext(),
  ) =>
    entry.handlers["ai.voice.status"](
      input,
      context,
    ) as Promise<ExperimentalAiVoiceStatusOutput>;
  return { created, entry, fake, transcribe, speak, status };
}

describe("resolveArcVoiceHostConfig", () => {
  it("requires the Arc Voice runtime, seed, and app-version roots", () => {
    expect(resolveArcVoiceHostConfig({}, "darwin", "arm64")).toBeNull();
    expect(
      resolveArcVoiceHostConfig(
        { ARC_VOICE_RUNTIME_ROOT: "/arc/userData" },
        "darwin",
        "arm64",
      ),
    ).toBeNull();
    expect(resolveArcVoiceHostConfig(ARC_ENV, "darwin", "arm64")).toEqual({
      runtimeRoot: "/arc/userData",
      seedRoot: "/arc/resources/arc-runtimes",
      appVersion: "1.2.3",
      platform: "darwin",
      arch: "arm64",
      ttsEngine: "kokoro",
      ttsVoice: "af_heart",
    });
  });
});

describe("arc-voice host entry", () => {
  it("exposes only the shared AI-services contract methods", () => {
    const { entry } = buildHost();

    expect(Object.keys(entry.handlers).sort()).toEqual([
      "ai.inference.complete",
      "ai.voice.capabilities",
      "ai.voice.modelDownload",
      "ai.voice.modelDownloadCancel",
      "ai.voice.prepare",
      "ai.voice.profileCreate",
      "ai.voice.profileDelete",
      "ai.voice.profileSampleAdd",
      "ai.voice.profileSampleRemove",
      "ai.voice.profileUpdate",
      "ai.voice.profiles",
      "ai.voice.release",
      "ai.voice.repair",
      "ai.voice.speak",
      "ai.voice.status",
      "ai.voice.transcribe",
      "ai.voice.unloadModels",
    ]);
  });

  it("refuses another service id without building the runtime", async () => {
    const { created, transcribe } = buildHost();

    await expect(
      transcribe(transcribeInput({ serviceId: "codex" })),
    ).resolves.toMatchObject({ ok: false, code: "request_failed" });
    expect(created).toEqual([]);
  });

  it("serves the whisper model sizes and refuses other models", async () => {
    const { created, transcribe, fake } = buildHost();

    const accepted = await transcribe(
      transcribeInput({ model: "whisper-turbo", language: "en" }),
    );
    expect(accepted).toMatchObject({ ok: true, model: "whisper-turbo" });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.model).toBe("turbo");
    expect(fake.calls[0]?.language).toBe("en");

    const { created: refusedCreated, transcribe: refusedTranscribe } =
      buildHost();
    const refused = await refusedTranscribe(
      transcribeInput({ model: "llama-3" }),
    );
    expect(refused).toMatchObject({ ok: false, code: "request_failed" });
    expect(refused.ok === false && refused.message).toContain("Whisper");
    expect(refusedCreated).toEqual([]);
    expect(created).toHaveLength(1);
  });

  it("rejects an unusable transcription language", async () => {
    const { created, transcribe } = buildHost();

    const result = await transcribe(
      transcribeInput({ language: "en\r\nX-Injected: yes" }),
    );

    expect(result).toMatchObject({ ok: false, code: "request_failed" });
    expect(created).toEqual([]);
  });

  it("rejects audio that is not valid base64", async () => {
    const { created, transcribe } = buildHost();

    await expect(
      transcribe(transcribeInput({ audioBase64: "not base64 !!" })),
    ).resolves.toMatchObject({ ok: false, code: "request_failed" });
    expect(created).toEqual([]);
  });

  it("rejects audio whose file name is unusable", async () => {
    const { transcribe } = buildHost();

    await expect(
      transcribe(transcribeInput({ filename: "../../etc/passwd" })),
    ).resolves.toMatchObject({ ok: false, code: "request_failed" });
  });

  it("rejects audio whose content type could break the outbound request", async () => {
    const { created, transcribe } = buildHost();

    await expect(
      transcribe(
        transcribeInput({ mimeType: 'audio/wav\r\nContent-Disposition: form-data; name="model"' }),
      ),
    ).resolves.toMatchObject({ ok: false, code: "request_failed" });
    await expect(
      transcribe(transcribeInput({ mimeType: `audio/${"w".repeat(200)}` })),
    ).resolves.toMatchObject({ ok: false, code: "request_failed" });
    await expect(
      transcribe(
        transcribeInput({ mimeType: `audio/wav${";".repeat(50)}\r` }),
      ),
    ).resolves.toMatchObject({ ok: false, code: "request_failed" });
    await expect(
      transcribe(transcribeInput({ filename: `${"a".repeat(400)}.wav` })),
    ).resolves.toMatchObject({ ok: false, code: "request_failed" });
    expect(created).toEqual([]);
  });

  it("accepts the content types the renderer and CLI produce", async () => {
    const { transcribe } = buildHost();

    for (const mimeType of [
      "audio/wav",
      "audio/webm;codecs=opus",
      "audio/mp4;codecs=mp4a.40.2",
      "audio/ogg",
      "application/octet-stream",
    ]) {
      await expect(transcribe(transcribeInput({ mimeType }))).resolves.toMatchObject({
        ok: true,
      });
    }
  });

  it("rejects an audio payload beyond the host limit", async () => {
    const { created, transcribe } = buildHost();

    const result = await transcribe(
      transcribeInput({ audioBase64: "A".repeat(35_000_000) }),
    );

    expect(result).toMatchObject({ ok: false, code: "request_failed" });
    expect(result.ok === false && result.message).toContain("25MB");
    expect(created).toEqual([]);
  });

  it("rejects audio bytes that are not a RIFF/WAVE file", async () => {
    const { created, transcribe } = buildHost();

    await expect(
      transcribe(
        transcribeInput({
          audioBase64: Buffer.from("not audio at all").toString("base64"),
        }),
      ),
    ).resolves.toMatchObject({ ok: false, code: "request_failed" });
    expect(created).toEqual([]);
  });

  it("rejects unnormalized Chromium audio with a controlled error", async () => {
    const { created, transcribe } = buildHost();

    const result = await transcribe(
      transcribeInput({
        audioBase64: Buffer.from([
          0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x82, 0x88, 0x77, 0x65, 0x62,
          0x6d,
        ]).toString("base64"),
        mimeType: "audio/webm;codecs=opus",
        filename: "recording.webm",
      }),
    );

    expect(result).toMatchObject({ ok: false, code: "request_failed" });
    expect(result.ok === false && result.message).toContain("PCM WAV");
    expect(created).toEqual([]);
  });

  it("accepts RIFF/WAVE bytes under any MIME label", async () => {
    const { transcribe } = buildHost();

    await expect(
      transcribe(
        transcribeInput({
          mimeType: "audio/webm",
          filename: "voice-input",
        }),
      ),
    ).resolves.toMatchObject({ ok: true, text: "hello arc" });
    await expect(
      transcribe(
        transcribeInput({ mimeType: "application/octet-stream" }),
      ),
    ).resolves.toMatchObject({ ok: true, text: "hello arc" });
  });

  it("builds one service lazily and forwards audio, metadata, and the call signal", async () => {
    const { created, fake, transcribe } = buildHost();
    const controller = new AbortController();

    await expect(
      transcribe(transcribeInput(), hostContext(controller.signal)),
    ).resolves.toEqual({
      ok: true,
      model: ARC_VOICE_DEFAULT_MODEL,
      text: "hello arc",
    });
    await transcribe();

    expect(created).toHaveLength(1);
    expect(created[0]?.runtimeRoot).toBe("/arc/userData");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.signal).toBe(controller.signal);
    expect(fake.calls[0]?.timeoutMs).toBe(120_000);
    expect(fake.calls[0]?.fileName).toBe("recording.wav");
    expect(fake.calls[0]?.mimeType).toBe("audio/wav");
    expect(fake.calls[0]?.model).toBeUndefined();
    expect([...(fake.calls[0]?.audio ?? [])]).toEqual([...pcmWavBytes()]);
  });

  it("forwards the caller's transcription budget to the runtime", async () => {
    const { fake, transcribe } = buildHost();

    await transcribe(transcribeInput({ timeoutMs: 90_000 }));

    expect(fake.calls[0]?.timeoutMs).toBe(90_000);
  });

  it("reports a service failure as a typed result", async () => {
    const { transcribe } = buildHost({
      result: {
        kind: "error",
        code: "transport",
        message: "voice transcription failed",
      },
    });

    await expect(transcribe()).resolves.toEqual({
      ok: false,
      code: "request_failed",
      message: "voice transcription failed",
    });
  });

  it("reports an unavailable runtime as retryable rather than a hard failure", async () => {
    const { transcribe } = buildHost({
      result: {
        kind: "error",
        code: "unavailable",
        message: "voice runtime is unavailable: staging failed",
      },
    });

    await expect(transcribe()).resolves.toEqual({
      ok: false,
      code: "service_unavailable",
      message: "voice runtime is unavailable: staging failed",
    });
  });

  it("reports a transcription that exceeded its budget as a timeout result", async () => {
    const { transcribe } = buildHost({
      result: {
        kind: "error",
        code: "timeout",
        message: "voice transcription failed: The operation was aborted",
      },
    });

    await expect(transcribe()).resolves.toEqual({
      ok: false,
      code: "timeout",
      message: "voice transcription failed: The operation was aborted",
    });
  });

  it("reports an aborted call as a timeout result", async () => {
    const { transcribe } = buildHost({
      result: {
        kind: "error",
        code: "aborted",
        message: "voice transcription was cancelled",
      },
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      transcribe(transcribeInput(), hostContext(controller.signal)),
    ).resolves.toMatchObject({ ok: false, code: "timeout" });
  });

  it("rejects an empty transcript instead of returning it", async () => {
    const { transcribe } = buildHost({
      result: { kind: "ok", value: { text: "   " } },
    });

    await expect(transcribe()).resolves.toMatchObject({
      ok: false,
      code: "invalid_response",
    });
  });

  it("reports Arc Voice as unavailable when the Arc environment is absent", async () => {
    const { transcribe } = buildHost({ env: {} });

    const result = await transcribe();

    expect(result).toMatchObject({ ok: false, code: "service_unavailable" });
    expect(result.ok === false && result.message).toContain("Arc");
  });

  it("stops the runtime on disposal and tolerates disposal before any call", async () => {
    const unused = buildHost();
    await expect(unused.entry.dispose?.()).resolves.toBeUndefined();
    expect(unused.fake.stop).not.toHaveBeenCalled();

    const { entry, fake, transcribe } = buildHost();
    await transcribe();

    await entry.dispose?.();

    expect(fake.stop).toHaveBeenCalledOnce();
  });

  it("maps voice status through without starting the runtime", async () => {
    const { fake, status } = buildHost();

    await expect(status()).resolves.toEqual({
      ok: true,
      runtimeState: "ready",
      version: "0.5.0",
      speechModelLoaded: true,
      voiceModel: null,
    });
    expect(fake.calls).toHaveLength(0);
    expect(fake.speakCalls).toHaveLength(0);
  });

  it("refuses a status for another service id", async () => {
    const { status } = buildHost();

    await expect(
      status({ serviceId: "codex" }),
    ).resolves.toMatchObject({ ok: false, code: "request_failed" });
  });

  it("speaks and returns base64 audio with its duration", async () => {
    const { fake, speak } = buildHost({
      speakResult: {
        kind: "ok",
        value: { audio: new Uint8Array([1]), contentType: "audio/wav", durationMs: 1500 },
      },
    });

    await expect(speak()).resolves.toEqual({
      ok: true,
      audioBase64: "AQ==",
      contentType: "audio/wav",
      durationMs: 1500,
    });
    expect(fake.speakCalls[0]?.text).toBe("Hello there");
  });

  it("rejects empty speak text", async () => {
    const { speak } = buildHost();

    await expect(speak(speakInput({ text: "   " }))).resolves.toMatchObject({
      ok: false,
      code: "request_failed",
    });
  });

  it("maps a speak timeout to the timeout code", async () => {
    const { speak } = buildHost({
      speakResult: {
        kind: "error",
        code: "timeout",
        message: "voice synthesis exceeded its time budget",
      },
    });

    await expect(speak()).resolves.toMatchObject({ ok: false, code: "timeout" });
  });

  it("rejects audio larger than the playback cap", async () => {
    const { speak } = buildHost({
      speakResult: {
        kind: "ok",
        value: {
          audio: new Uint8Array(24 * 1024 * 1024 + 1),
          contentType: "audio/wav",
          durationMs: null,
        },
      },
    });

    await expect(speak()).resolves.toMatchObject({
      ok: false,
      code: "request_failed",
    });
  });
});

describe("arc-voice host entry v4 control plane", () => {
  const call = <Output>(
    entry: ReturnType<typeof createArcVoiceHostEntry>,
    method: string,
    input: unknown,
  ): Promise<Output> =>
    (
      entry.handlers as unknown as Record<
        string,
        (value: unknown, context: ExperimentalHostRpcContext) => Promise<Output>
      >
    )[method](input, hostContext()) as Promise<Output>;

  const buildHostWith = (
    overrides: Partial<ArcVoiceTranscriptionService>,
  ): ReturnType<typeof createArcVoiceHostEntry> => {
    const { fake } = buildHost();
    return createArcVoiceHostEntry({
      env: ARC_ENV,
      platform: "darwin",
      arch: "arm64",
      createService: () => ({ ...fake.service, ...overrides }),
    });
  };

  it("maps capabilities from the runtime", async () => {
    const capabilities = vi.fn(async () => ({
      kind: "ok" as const,
      value: {
        runtimeState: "ready" as const,
        version: "0.5.0",
        engines: [
          {
            engine: "kokoro",
            requiresClonedProfile: false,
            presets: [
              {
                voiceId: "af_heart",
                name: "Heart",
                gender: "female",
                language: "en",
              },
            ],
            models: [
              {
                name: "kokoro",
                displayName: "Kokoro",
                downloaded: true,
                downloading: false,
                loaded: true,
                downloadPercent: null,
              },
            ],
          },
        ],
        speechModels: [],
      },
    }));
    const entry = buildHostWith({ capabilities });

    const result = await call<ExperimentalAiVoiceCapabilitiesOutput>(
      entry,
      "ai.voice.capabilities",
      { serviceId: ARC_VOICE_SERVICE_ID },
    );

    expect(result).toEqual({
      ok: true,
      runtimeState: "ready",
      version: "0.5.0",
      engines: [
        {
          engine: "kokoro",
          requiresClonedProfile: false,
          presets: [
            {
              voiceId: "af_heart",
              name: "Heart",
              gender: "female",
              language: "en",
            },
          ],
          models: [
            {
              name: "kokoro",
              displayName: "Kokoro",
              downloaded: true,
              downloading: false,
              loaded: true,
              downloadPercent: null,
            },
          ],
        },
      ],
      speechModels: [],
    });
    expect(capabilities).toHaveBeenCalledTimes(1);
  });

  it("maps a runtime capabilities failure to service_unavailable", async () => {
    const entry = buildHostWith({
      capabilities: async () => ({
        kind: "error" as const,
        code: "unavailable" as const,
        message: "voice runtime is unavailable: no install",
      }),
    });

    await expect(
      call<ExperimentalAiVoiceCapabilitiesOutput>(
        entry,
        "ai.voice.capabilities",
        { serviceId: ARC_VOICE_SERVICE_ID },
      ),
    ).resolves.toEqual({
      ok: false,
      code: "service_unavailable",
      message: "voice runtime is unavailable: no install",
    });
  });

  it("lists profiles and maps runtime errors", async () => {
    const entry = buildHostWith({
      listProfileDetails: async () => ({
        kind: "ok" as const,
        value: [
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
        ],
      }),
    });

    await expect(
      call<ExperimentalAiVoiceProfilesOutput>(
        entry,
        "ai.voice.profiles",
        { serviceId: ARC_VOICE_SERVICE_ID },
      ),
    ).resolves.toEqual({
      ok: true,
      profiles: [
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
      ],
    });

    const { entry: plainEntry } = buildHost();
    await expect(
      call<ExperimentalAiVoiceProfilesOutput>(
        plainEntry,
        "ai.voice.profiles",
        { serviceId: ARC_VOICE_SERVICE_ID },
      ),
    ).resolves.toMatchObject({ ok: false, code: "service_unavailable" });
  });

  it("gates sample upload on WAV bytes and reference text", async () => {
    const { fake } = buildHost();
    const entry = createArcVoiceHostEntry({
      env: ARC_ENV,
      platform: "darwin",
      arch: "arm64",
      createService: () => ({ ...fake.service }),
    });

    const noText = await call(
      entry,
      "ai.voice.profileSampleAdd",
      {
        serviceId: ARC_VOICE_SERVICE_ID,
        profileId: "p1",
        audioBase64: pcmWavBytes().toString("base64"),
        mimeType: "audio/wav",
        filename: "sample.wav",
        referenceText: "   ",
      },
    );
    expect(noText).toMatchObject({ ok: false, code: "request_failed" });

    const notWav = await call(
      entry,
      "ai.voice.profileSampleAdd",
      {
        serviceId: ARC_VOICE_SERVICE_ID,
        profileId: "p1",
        audioBase64: Buffer.from("not a wav at all").toString("base64"),
        mimeType: "audio/wav",
        filename: "sample.wav",
        referenceText: "hello",
      },
    );
    expect(notWav).toMatchObject({ ok: false, code: "request_failed" });
  });

  it("maps repair failure to service_unavailable and success to ok", async () => {
    const failing = buildHostWith({
      repair: async () => ({ kind: "failed" as const, detail: "bad digest" }),
    });
    await expect(
      call<ExperimentalAiVoiceRepairOutput>(failing, "ai.voice.repair", {
        serviceId: ARC_VOICE_SERVICE_ID,
      }),
    ).resolves.toEqual({
      ok: false,
      code: "service_unavailable",
      message: "bad digest",
    });

    const { entry: healthyEntry } = buildHost();
    await expect(
      call<ExperimentalAiVoiceRepairOutput>(healthyEntry, "ai.voice.repair", {
        serviceId: ARC_VOICE_SERVICE_ID,
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("answers prepare with the runtime state", async () => {
    const { entry } = buildHost();

    const result = await call(entry, "ai.voice.prepare", {
      serviceId: ARC_VOICE_SERVICE_ID,
    });

    expect(result).toEqual({ ok: true, runtimeState: "ready" });
  });
});
