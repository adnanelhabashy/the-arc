// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VoiceAudioNormalizationError,
  analyzeVoiceEnergy,
  normalizeVoiceRecordingToWav,
  normalizeVoiceRecordingToWavWithAnalysis,
} from "./voice-audio-normalization";

interface AudioGraphOptions {
  duration?: number;
  sampleRate?: number;
  numberOfChannels?: number;
  decodeError?: unknown;
  voiceboxSamples?: Float32Array;
  onDecode?: () => void;
  onRender?: () => void;
}

function installAudioGraph(options: AudioGraphOptions = {}) {
  const decoded = {
    duration: options.duration ?? 0.5,
    sampleRate: options.sampleRate ?? 48_000,
    numberOfChannels: options.numberOfChannels ?? 2,
  };
  const voiceboxSamples =
    options.voiceboxSamples ?? new Float32Array([-1, 0, 0.5, 1]);
  const close = vi.fn(async () => undefined);
  const renders: { channels: number; frames: number; sampleRate: number }[] = [];
  const contexts: unknown[] = [];

  class FakeAudioContext {
    constructor() {
      contexts.push(this);
    }
    decodeAudioData = vi.fn(async () => {
      options.onDecode?.();
      if (options.decodeError !== undefined) throw options.decodeError;
      return decoded;
    });
    close = close;
  }

  class FakeOfflineAudioContext {
    constructor(channels: number, frames: number, sampleRate: number) {
      renders.push({ channels, frames, sampleRate });
    }
    createBufferSource() {
      return { buffer: null, connect: vi.fn(), start: vi.fn() };
    }
    async startRendering() {
      options.onRender?.();
      return {
        getChannelData: (channel: number) =>
          channel === 0 ? voiceboxSamples : new Float32Array(0),
      };
    }
  }

  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);

  return { close, renders, contexts };
}

function reading(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function ascii(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + 4));
}

const RECORDING = new Blob([new Uint8Array([1, 2, 3, 4])], {
  type: "audio/webm;codecs=opus",
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("normalizeVoiceRecordingToWav", () => {
  it("encodes a 16 kHz mono 16-bit PCM WAV named for Voicebox", async () => {
    const graph = installAudioGraph({
      voiceboxSamples: new Float32Array([-1, 0, 0.5, 1]),
    });

    const file = await normalizeVoiceRecordingToWav({
      blob: RECORDING,
      sourceMimeType: "audio/webm;codecs=opus",
    });

    expect(file.type).toBe("audio/wav");
    expect(file.name).toBe("recording.wav");
    expect(file.size).toBe(44 + 4 * 2);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const view = reading(bytes);
    expect(ascii(bytes, 0)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 8);
    expect(ascii(bytes, 8)).toBe("WAVE");
    expect(ascii(bytes, 12)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(bytes, 36)).toBe("data");
    expect(view.getUint32(40, true)).toBe(8);
    expect(view.getInt16(44, true)).toBe(-32_767);
    expect(view.getInt16(46, true)).toBe(0);
    expect(view.getInt16(48, true)).toBe(16_384);
    expect(view.getInt16(50, true)).toBe(32_767);
    expect(graph.close).toHaveBeenCalledTimes(1);
  });

  it("renders Voicebox input at 16 kHz mono whatever the recording rate was", async () => {
    const graph = installAudioGraph({
      duration: 1.25,
      sampleRate: 44_100,
      numberOfChannels: 2,
    });

    await normalizeVoiceRecordingToWav({
      blob: RECORDING,
      sourceMimeType: "audio/mp4;codecs=mp4a.40.2",
    });

    expect(graph.renders).toEqual([
      { channels: 1, frames: 20_000, sampleRate: 16_000 },
    ]);
  });

  it("clamps samples outside the PCM range", async () => {
    installAudioGraph({ voiceboxSamples: new Float32Array([-4, 4, Number.NaN]) });

    const file = await normalizeVoiceRecordingToWav({
      blob: RECORDING,
      sourceMimeType: "audio/webm",
    });

    const view = reading(new Uint8Array(await file.arrayBuffer()));
    expect(view.getInt16(44, true)).toBe(-32_767);
    expect(view.getInt16(46, true)).toBe(32_767);
    expect(view.getInt16(48, true)).toBe(0);
  });

  it("reports undecodable recordings with their source type", async () => {
    const graph = installAudioGraph({
      decodeError: new DOMException("unsupported codec", "EncodingError"),
    });

    await expect(
      normalizeVoiceRecordingToWav({
        blob: RECORDING,
        sourceMimeType: "audio/webm;codecs=opus",
      }),
    ).rejects.toThrow(VoiceAudioNormalizationError);
    await expect(
      normalizeVoiceRecordingToWav({
        blob: RECORDING,
        sourceMimeType: "audio/webm;codecs=opus",
      }),
    ).rejects.toThrow(
      'Arc Voice cannot convert recorded audio of type "audio/webm;codecs=opus" to PCM WAV.',
    );
    await expect(
      normalizeVoiceRecordingToWav({ blob: RECORDING, sourceMimeType: "" }),
    ).rejects.toThrow('recorded audio of type "unknown"');
    expect(graph.close).toHaveBeenCalledTimes(3);
  });

  it("reports a missing Web Audio implementation instead of crashing", async () => {
    vi.stubGlobal("AudioContext", undefined);

    await expect(
      normalizeVoiceRecordingToWav({
        blob: RECORDING,
        sourceMimeType: "audio/webm",
      }),
    ).rejects.toThrow(
      "This browser cannot convert microphone audio for Arc Voice.",
    );
  });

  it("does not touch Web Audio for a recording that was already cancelled", async () => {
    const graph = installAudioGraph();
    const controller = new AbortController();
    controller.abort();

    await expect(
      normalizeVoiceRecordingToWav({
        blob: RECORDING,
        sourceMimeType: "audio/webm",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(graph.contexts).toEqual([]);
    expect(graph.renders).toEqual([]);
  });

  it("gives up before rendering when the conversion was cancelled", async () => {
    const controller = new AbortController();
    const graph = installAudioGraph({ onDecode: () => controller.abort() });

    await expect(
      normalizeVoiceRecordingToWav({
        blob: RECORDING,
        sourceMimeType: "audio/webm",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(graph.renders).toEqual([]);
    expect(graph.close).toHaveBeenCalledTimes(1);
  });

  it("returns no file when the conversion was cancelled while rendering", async () => {
    const controller = new AbortController();
    const graph = installAudioGraph({ onRender: () => controller.abort() });

    await expect(
      normalizeVoiceRecordingToWav({
        blob: RECORDING,
        sourceMimeType: "audio/webm",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(graph.renders).toHaveLength(1);
    expect(graph.close).toHaveBeenCalledTimes(1);
  });
});

describe("analyzeVoiceEnergy", () => {
  it("flags a pure silence buffer as near silence", () => {
    const analysis = analyzeVoiceEnergy(new Float32Array(16_000), 16_000);

    expect(analysis.peakRms).toBe(0);
    expect(analysis.meanRms).toBe(0);
    expect(analysis.isNearSilence).toBe(true);
  });

  it("does not flag loud speech-like amplitude as near silence", () => {
    const analysis = analyzeVoiceEnergy(
      new Float32Array(16_000).fill(0.5),
      16_000,
    );

    expect(analysis.peakRms).toBeCloseTo(0.5, 5);
    expect(analysis.meanRms).toBeCloseTo(0.5, 5);
    expect(analysis.isNearSilence).toBe(false);
  });

  it("flags low-level noise below the mean threshold as near silence", () => {
    const analysis = analyzeVoiceEnergy(
      new Float32Array(16_000).fill(0.002),
      16_000,
    );

    expect(analysis.isNearSilence).toBe(true);
  });

  it("does not flag low-level noise above the mean threshold", () => {
    const analysis = analyzeVoiceEnergy(
      new Float32Array(16_000).fill(0.005),
      16_000,
    );

    expect(analysis.isNearSilence).toBe(false);
  });
});

describe("normalizeVoiceRecordingToWavWithAnalysis", () => {
  it("returns the same WAV shape plus an energy analysis", async () => {
    const graph = installAudioGraph({
      voiceboxSamples: new Float32Array([-1, 0, 0.5, 1]),
    });

    const { file, analysis } = await normalizeVoiceRecordingToWavWithAnalysis({
      blob: RECORDING,
      sourceMimeType: "audio/webm;codecs=opus",
    });

    expect(file.type).toBe("audio/wav");
    expect(file.name).toBe("recording.wav");
    expect(file.size).toBe(44 + 4 * 2);
    expect(analysis.isNearSilence).toBe(false);
    expect(analysis.peakRms).toBeGreaterThan(0.01);
    expect(graph.close).toHaveBeenCalledTimes(1);
  });
});
