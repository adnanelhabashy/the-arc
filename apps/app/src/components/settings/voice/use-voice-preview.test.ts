// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ApiModule from "@/lib/api";
import { speakVoiceText } from "@/lib/api";
import { startVoicePreview, stopVoicePreview } from "./use-voice-preview";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, speakVoiceText: vi.fn() };
});

class FakeAudio {
  src = "";
  paused = true;
  playbackRate = 1;
  preservesPitch = false;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;

  play() {
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
  }

  removeAttribute(name: string) {
    if (name === "src") {
      this.src = "";
    }
  }

  load() {}
}

const signals: (AbortSignal | undefined)[] = [];
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let urlCounter = 0;

const flush = async () => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
};

beforeEach(() => {
  signals.length = 0;
  urlCounter = 0;
  createObjectURL = vi.fn(() => {
    const url = `blob:test-${urlCounter}`;
    urlCounter += 1;
    return url;
  });
  revokeObjectURL = vi.fn();
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  stopVoicePreview();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("voice preview controller", () => {
  it("aborts the in-flight request when a second preview starts", () => {
    vi.mocked(speakVoiceText).mockImplementation((_text, options) => {
      signals.push(options?.signal);
      return new Promise<Blob>(() => {});
    });

    startVoicePreview({ key: "a", text: "first", engine: "kokoro" }, 1);
    expect(signals[0]?.aborted).toBe(false);

    startVoicePreview({ key: "b", text: "second", engine: "kokoro" }, 1);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it("aborts the in-flight request when stopped", () => {
    vi.mocked(speakVoiceText).mockImplementation((_text, options) => {
      signals.push(options?.signal);
      return new Promise<Blob>(() => {});
    });

    startVoicePreview({ key: "a", text: "hello", engine: "kokoro" }, 1);
    expect(signals[0]?.aborted).toBe(false);

    stopVoicePreview();
    expect(signals[0]?.aborted).toBe(true);
  });

  it("revokes the object URL after playback completes", async () => {
    let resolveSpeak: (blob: Blob) => void = () => {};
    vi.mocked(speakVoiceText).mockImplementation(
      () =>
        new Promise<Blob>((resolve) => {
          resolveSpeak = resolve;
        }),
    );

    startVoicePreview({ key: "a", text: "hello", engine: "kokoro" }, 1);
    resolveSpeak(new Blob(["audio"]));
    await flush();

    expect(createObjectURL).toHaveBeenCalledTimes(1);

    stopVoicePreview();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test-0");
  });
});
