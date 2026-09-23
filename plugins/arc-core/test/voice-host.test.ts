import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import type {
  ExperimentalAiVoiceTranscribeInput,
  ExperimentalAiVoiceTranscribeOutput,
} from "@get-bb/plugin-sdk/ai-services";
import type { ExperimentalHostRpcContext } from "@get-bb/plugin-sdk/host";
import type { ArcVoiceCallResult, ArcVoiceTranscribeArgs } from "bb-arc-voice-host";
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

function transcribeInput(
  overrides: Partial<ExperimentalAiVoiceTranscribeInput> = {},
): ExperimentalAiVoiceTranscribeInput {
  return {
    serviceId: ARC_VOICE_SERVICE_ID,
    model: ARC_VOICE_DEFAULT_MODEL,
    audioBase64: Buffer.from("audio-bytes").toString("base64"),
    mimeType: "audio/webm",
    filename: "recording.webm",
    prompt: null,
    timeoutMs: 10_000,
    ...overrides,
  };
}

function fakeService(
  result: ArcVoiceCallResult<{ text: string }> = {
    kind: "ok",
    value: { text: "hello arc" },
  },
): {
  service: ArcVoiceTranscriptionService;
  calls: ArcVoiceTranscribeArgs[];
  stop: ReturnType<typeof vi.fn>;
} {
  const calls: ArcVoiceTranscribeArgs[] = [];
  const stop = vi.fn(async () => ({ kind: "not-running", detail: "stopped" }));
  return {
    calls,
    stop,
    service: {
      transcribe: (args) => {
        calls.push(args);
        return Promise.resolve(result);
      },
      stop,
    },
  };
}

function buildHost(
  args: {
    env?: NodeJS.ProcessEnv;
    result?: ArcVoiceCallResult<{ text: string }>;
  } = {},
) {
  const fake = fakeService(args.result);
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
  return { created, entry, fake, transcribe };
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
    });
  });
});

describe("arc-voice host entry", () => {
  it("exposes only the shared AI-services contract methods", () => {
    const { entry } = buildHost();

    expect(Object.keys(entry.handlers).sort()).toEqual([
      "ai.inference.complete",
      "ai.voice.transcribe",
    ]);
  });

  it("refuses another service id without building the runtime", async () => {
    const { created, transcribe } = buildHost();

    await expect(
      transcribe(transcribeInput({ serviceId: "codex" })),
    ).resolves.toMatchObject({ ok: false, code: "request_failed" });
    expect(created).toEqual([]);
  });

  it("serves only the default model", async () => {
    const { created, transcribe } = buildHost();

    const result = await transcribe(transcribeInput({ model: "turbo" }));

    expect(result).toMatchObject({ ok: false, code: "request_failed" });
    expect(result.ok === false && result.message).toContain("default");
    expect(created).toEqual([]);
  });

  it("rejects audio that is not valid base64", async () => {
    const { created, transcribe } = buildHost();

    await expect(
      transcribe(transcribeInput({ audioBase64: "not base64 !!" })),
    ).resolves.toMatchObject({ ok: false, code: "request_failed" });
    expect(created).toEqual([]);
  });

  it("rejects a non-audio content type and an unusable file name", async () => {
    const { transcribe } = buildHost();

    await expect(
      transcribe(transcribeInput({ mimeType: "text/html" })),
    ).resolves.toMatchObject({ ok: false, code: "request_failed" });
    await expect(
      transcribe(transcribeInput({ filename: "../../etc/passwd" })),
    ).resolves.toMatchObject({ ok: false, code: "request_failed" });
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
    expect(fake.calls[0]?.fileName).toBe("recording.webm");
    expect(fake.calls[0]?.mimeType).toBe("audio/webm");
    expect(fake.calls[0]?.model).toBeUndefined();
    expect([...(fake.calls[0]?.audio ?? [])]).toEqual([
      ...Buffer.from("audio-bytes"),
    ]);
  });

  it("reports a service failure as a typed result", async () => {
    const { transcribe } = buildHost({
      result: { kind: "error", message: "voice transcription failed" },
    });

    await expect(transcribe()).resolves.toEqual({
      ok: false,
      code: "request_failed",
      message: "voice transcription failed",
    });
  });

  it("reports an aborted call as a timeout result", async () => {
    const { transcribe } = buildHost({
      result: { kind: "error", message: "voice transcription was cancelled" },
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
});
