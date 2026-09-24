// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SystemVoiceStatusResponse } from "@bb/server-contract";
import { appToast } from "@/components/ui/app-toast";
import { readVoiceStatus } from "@/lib/api";
import { useVoiceInput } from "./useVoiceInput";

vi.mock("@/components/ui/app-toast", () => ({ appToast: { error: vi.fn() } }));
vi.mock("@/lib/audio-input-device-preference", () => ({
  useAudioInputDevicePreferenceValue: () => null,
  buildAudioInputConstraints: () => ({ audio: true }),
}));
vi.mock("@/lib/api", () => ({ readVoiceStatus: vi.fn() }));
vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      generalSettings: {
        voice: { input: { reduceBackgroundNoise: true } },
      },
    },
  }),
}));

class Recorder {
  static isTypeSupported = () => true;
  mimeType = "audio/webm;codecs=opus";
  state = "inactive";
  onstart = () => {};
  ondataavailable = (_event: { data: Blob }) => {};
  onstop = async () => {};
  start() {
    this.state = "recording";
    this.onstart();
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable({ data: new Blob(["recorded audio"]) });
    return this.onstop();
  }
}

const audioContextCloses = vi.fn(async () => undefined);

function fakeAudioBuffer(args: {
  length: number;
  duration: number;
  sampleRate: number;
  numberOfChannels: number;
  samples: Float32Array;
}): AudioBuffer {
  return {
    length: args.length,
    duration: args.duration,
    sampleRate: args.sampleRate,
    numberOfChannels: args.numberOfChannels,
    getChannelData: () => args.samples,
  } as unknown as AudioBuffer;
}

class AudioDecoder {
  async decodeAudioData() {
    return fakeAudioBuffer({
      length: 4_000,
      duration: 0.25,
      sampleRate: 16_000,
      numberOfChannels: 1,
      samples: new Float32Array([0, 0.5, 0, 0.5]),
    });
  }
  close = audioContextCloses;
}

class VoiceboxRenderer {
  constructor(
    readonly channels: number,
    readonly frames: number,
    readonly sampleRate: number,
  ) {}
  createBufferSource() {
    return { buffer: null, connect: vi.fn(), start: vi.fn() };
  }
  async startRendering() {
    return fakeAudioBuffer({
      length: 4_000,
      duration: 0.25,
      sampleRate: this.sampleRate,
      numberOfChannels: this.channels,
      samples: new Float32Array([0, 0.5, 0, 0.5]),
    });
  }
}

function stubMicrophone(tracks: { stop: () => void }[] = []) {
  const stream = {
    getTracks: () => tracks,
  };
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  return { getUserMedia, stream, tracks };
}

function lastToastOptions() {
  return vi.mocked(appToast.error).mock.calls.at(-1)?.[1];
}

function readyVoiceStatus(): SystemVoiceStatusResponse {
  return {
    transcriptionEnabled: true,
      voiceEnabled: true,
    speech: {
      runtimeState: "ready",
      version: null,
      speechModelLoaded: true,
      voiceModel: {
        engine: "whisper",
        size: "small",
        downloaded: true,
        loaded: true,
        downloading: false,
        downloadPercent: null,
      },
    },
  };
}

function coldVoiceStatus(): SystemVoiceStatusResponse {
  return {
    transcriptionEnabled: true,
      voiceEnabled: true,
    speech: {
      runtimeState: "starting",
      version: null,
      speechModelLoaded: false,
      voiceModel: null,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("MediaRecorder", Recorder);
  vi.stubGlobal("AudioContext", AudioDecoder);
  vi.stubGlobal("OfflineAudioContext", VoiceboxRenderer);
  stubMicrophone();
  vi.mocked(readVoiceStatus).mockReset();
  vi.mocked(readVoiceStatus).mockResolvedValue(readyVoiceStatus());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("reports denied microphone permission without a download affordance", async () => {
  const createObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
  vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(
    new DOMException("denied", "NotAllowedError"),
  );
  const transcript = vi.fn();
  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: vi.fn(), onTranscript: transcript }),
  );

  await act(() => result.current.start());

  expect(result.current.state).toBe("error");
  expect(lastToastOptions()?.description).toBe("Microphone permission denied");
  expect(lastToastOptions()?.action).toBeUndefined();
  expect(lastToastOptions()?.duration).toBeUndefined();
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(transcript).not.toHaveBeenCalled();
});

it("reports a recorder failure without retaining the recording", async () => {
  const createObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
  const { result } = renderHook(() =>
    useVoiceInput({
      onTranscribe: vi
        .fn()
        .mockRejectedValue(new Error("Upload failed with HTTP 500")),
      onTranscript: vi.fn(),
    }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => result.current.stop());

  expect(result.current.state).toBe("error");
  expect(lastToastOptions()?.description).toBe("Upload failed with HTTP 500");
  expect(lastToastOptions()?.action).toBeUndefined();
  expect(lastToastOptions()?.duration).toBeUndefined();
  expect(createObjectURL).not.toHaveBeenCalled();
});

it("refuses a capture shorter than the minimum and releases the microphone", async () => {
  const { tracks } = stubMicrophone([{ stop: vi.fn() }]);
  const transcribe = vi.fn();
  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: transcribe, onTranscript: vi.fn() }),
  );

  await act(() => result.current.start());
  await act(async () => result.current.stop());

  expect(result.current.state).toBe("error");
  expect(lastToastOptions()?.description).toBe(
    "Recording too short (minimum 1 second)",
  );
  expect(transcribe).not.toHaveBeenCalled();
  expect(tracks[0]?.stop).toHaveBeenCalled();
});

it("refuses a capture beyond the maximum length before converting it", async () => {
  const { tracks } = stubMicrophone([{ stop: vi.fn() }]);
  const transcribe = vi.fn();
  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: transcribe, onTranscript: vi.fn() }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(10 * 60 * 1_000 + 1_000);
  await act(async () => result.current.stop());

  expect(result.current.state).toBe("error");
  expect(lastToastOptions()?.description).toBe(
    "Recording too long (maximum 10 minutes)",
  );
  expect(transcribe).not.toHaveBeenCalled();
  expect(audioContextCloses).not.toHaveBeenCalled();
  expect(tracks[0]?.stop).toHaveBeenCalled();
});

it("transcribes a successful capture and hands over normalized text", async () => {
  const { tracks } = stubMicrophone([{ stop: vi.fn() }]);
  const transcribe = vi.fn().mockResolvedValue("  hello   there  ");
  const transcript = vi.fn();
  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: transcribe, onTranscript: transcript }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => result.current.stop());

  expect(transcript).toHaveBeenCalledWith("hello there");
  const recording = transcribe.mock.calls[0]?.[0].file;
  expect(recording?.type).toBe("audio/wav");
  expect(recording?.name).toBe("recording.wav");
  const header = new DataView(await recording!.slice(0, 44).arrayBuffer());
  expect(header.getUint32(0, false)).toBe(0x52494646);
  expect(header.getUint32(8, false)).toBe(0x57415645);
  expect(header.getUint16(20, true)).toBe(1);
  expect(header.getUint16(22, true)).toBe(1);
  expect(header.getUint16(34, true)).toBe(16);
  expect(result.current.state).toBe("idle");
  expect(tracks[0]?.stop).toHaveBeenCalled();
  expect(audioContextCloses).toHaveBeenCalledTimes(1);
});

it("reports unsupported recorded audio as a controlled normalization error", async () => {
  class RejectingAudioDecoder {
    async decodeAudioData() {
      throw new DOMException("unsupported codec", "EncodingError");
    }
    async close() {}
  }
  vi.stubGlobal("AudioContext", RejectingAudioDecoder);
  const transcribe = vi.fn();
  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: transcribe, onTranscript: vi.fn() }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => result.current.stop());

  expect(transcribe).not.toHaveBeenCalled();
  expect(result.current.state).toBe("error");
  expect(lastToastOptions()?.description).toBe(
    'Arc Voice cannot convert recorded audio of type "audio/webm;codecs=opus" to PCM WAV.',
  );
});

it("drops a recording that is cancelled while it is being converted", async () => {
  let releaseDecode: (() => void) | undefined;
  class SlowAudioDecoder {
    async decodeAudioData() {
      await new Promise<void>((resolve) => {
        releaseDecode = resolve;
      });
      return fakeAudioBuffer({
        length: 4_000,
        duration: 0.25,
        sampleRate: 48_000,
        numberOfChannels: 2,
        samples: new Float32Array(0),
      });
    }
    close = audioContextCloses;
  }
  vi.stubGlobal("AudioContext", SlowAudioDecoder);
  const transcribe = vi.fn();
  const transcript = vi.fn();
  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: transcribe, onTranscript: transcript }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => {
    void result.current.stop();
  });
  expect(result.current.state).toBe("transcribing");

  await act(async () => result.current.cancel());
  expect(result.current.state).toBe("idle");

  await act(async () => {
    releaseDecode?.();
  });

  expect(transcribe).not.toHaveBeenCalled();
  expect(transcript).not.toHaveBeenCalled();
  expect(result.current.state).toBe("idle");
  expect(appToast.error).not.toHaveBeenCalled();
});

it("keeps a restarted recording when an earlier conversion settles late", async () => {
  const pendingDecodes: Array<() => void> = [];
  class SlowAudioDecoder {
    async decodeAudioData() {
      await new Promise<void>((resolve) => {
        pendingDecodes.push(resolve);
      });
      return fakeAudioBuffer({
        length: 4_000,
        duration: 0.25,
        sampleRate: 48_000,
        numberOfChannels: 2,
        samples: new Float32Array(0),
      });
    }
    close = audioContextCloses;
  }
  vi.stubGlobal("AudioContext", SlowAudioDecoder);
  const transcribe = vi.fn().mockResolvedValue("spoken");
  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: transcribe, onTranscript: vi.fn() }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => {
    void result.current.stop();
  });
  await act(async () => result.current.cancel());
  expect(result.current.state).toBe("idle");

  await act(() => result.current.start());
  expect(result.current.state).toBe("recording");

  await act(async () => {
    for (const release of pendingDecodes) release();
  });

  expect(result.current.state).toBe("recording");
  expect(transcribe).not.toHaveBeenCalled();

  vi.advanceTimersByTime(1500);
  await act(async () => result.current.stop());
  await act(async () => {
    for (const release of pendingDecodes) release();
  });

  expect(transcribe).toHaveBeenCalledTimes(1);
  expect(result.current.state).toBe("idle");
});

it("treats an empty transcript as a failure and inserts nothing", async () => {
  const transcript = vi.fn();
  const { result } = renderHook(() =>
    useVoiceInput({
      onTranscribe: vi.fn().mockResolvedValue("   "),
      onTranscript: transcript,
    }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => result.current.stop());

  expect(result.current.state).toBe("error");
  expect(transcript).not.toHaveBeenCalled();
  expect(lastToastOptions()?.action).toBeUndefined();
});

it("cancels a recording without transcribing", async () => {
  const { tracks } = stubMicrophone([{ stop: vi.fn() }]);
  const transcribe = vi.fn();
  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: transcribe, onTranscript: vi.fn() }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => result.current.cancel());

  expect(result.current.state).toBe("idle");
  expect(transcribe).not.toHaveBeenCalled();
  expect(appToast.error).not.toHaveBeenCalled();
  expect(tracks[0]?.stop).toHaveBeenCalled();
});

it("aborts in-flight transcription on cancel and drops the late transcript", async () => {
  let settle: ((text: string) => void) | undefined;
  const signals: AbortSignal[] = [];
  const transcript = vi.fn();
  const { result } = renderHook(() =>
    useVoiceInput({
      onTranscribe: (args) => {
        signals.push(args.signal as AbortSignal);
        return new Promise<string>((resolve) => {
          settle = resolve;
        });
      },
      onTranscript: transcript,
    }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  let stopping: Promise<void> | undefined;
  await act(async () => {
    stopping = Promise.resolve(result.current.stop());
  });
  expect(result.current.state).toBe("transcribing");

  await act(async () => result.current.cancel());
  expect(signals[0]?.aborted).toBe(true);

  await act(async () => {
    settle?.("late words");
    await stopping;
  });

  expect(transcript).not.toHaveBeenCalled();
  expect(result.current.state).toBe("idle");
  expect(appToast.error).not.toHaveBeenCalled();
});

it("cancels the recording and in-flight work when the composer scope changes", async () => {
  const { tracks } = stubMicrophone([{ stop: vi.fn() }]);
  const signals: AbortSignal[] = [];
  const { result, rerender } = renderHook(
    ({ scopeKey }) =>
      useVoiceInput({
        onTranscribe: (args) => {
          signals.push(args.signal as AbortSignal);
          return new Promise<string>(() => {});
        },
        onTranscript: vi.fn(),
        scopeKey,
      }),
    { initialProps: { scopeKey: "thread-a" } },
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => {
    void result.current.stop();
  });
  expect(result.current.state).toBe("transcribing");

  rerender({ scopeKey: "thread-b" });

  expect(signals[0]?.aborted).toBe(true);
  expect(result.current.state).toBe("idle");
  expect(tracks[0]?.stop).toHaveBeenCalled();
});

it("stops the microphone tracks and aborts work on unmount", async () => {
  const { tracks } = stubMicrophone([{ stop: vi.fn() }]);
  const signals: AbortSignal[] = [];
  const { result, unmount } = renderHook(() =>
    useVoiceInput({
      onTranscribe: (args) => {
        signals.push(args.signal as AbortSignal);
        return new Promise<string>(() => {});
      },
      onTranscript: vi.fn(),
    }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => {
    void result.current.stop();
  });
  unmount();

  expect(signals[0]?.aborted).toBe(true);
  expect(tracks[0]?.stop).toHaveBeenCalled();
});

it("runs repeated dictations independently", async () => {
  const transcribe = vi.fn().mockResolvedValue("spoken");
  const transcript = vi.fn();
  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: transcribe, onTranscript: transcript }),
  );

  for (let session = 0; session < 3; session += 1) {
    await act(() => result.current.start());
    vi.advanceTimersByTime(1500);
    await act(async () => result.current.stop());
  }

  expect(transcript).toHaveBeenCalledTimes(3);
  expect(result.current.state).toBe("idle");
});

it("does not offer a download after explicit cancellation", async () => {
  const createObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
  const { result } = renderHook(() =>
    useVoiceInput({
      onTranscribe: vi
        .fn()
        .mockRejectedValue(new DOMException("Cancelled", "AbortError")),
      onTranscript: vi.fn(),
    }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => result.current.stop());

  expect(result.current.state).toBe("idle");
  expect(appToast.error).not.toHaveBeenCalled();
  expect(createObjectURL).not.toHaveBeenCalled();
});

it("shows preparing until the speech model is ready, then transcribes", async () => {
  vi.mocked(readVoiceStatus)
    .mockReset()
    .mockResolvedValueOnce(coldVoiceStatus())
    .mockResolvedValue(readyVoiceStatus());
  let settle: ((text: string) => void) | undefined;
  const transcribe = vi.fn().mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        settle = resolve;
      }),
  );
  const transcript = vi.fn();
  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: transcribe, onTranscript: transcript }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => result.current.stop());

  expect(result.current.state).toBe("preparing");

  await act(async () => {
    vi.advanceTimersByTime(400);
  });
  expect(result.current.state).toBe("transcribing");

  await act(async () => {
    settle?.("spoken words");
  });
  expect(transcript).toHaveBeenCalledWith("spoken words");
  expect(result.current.state).toBe("idle");
});

it("goes straight to transcribing when the speech model is already ready", async () => {
  vi.mocked(readVoiceStatus).mockResolvedValue(readyVoiceStatus());
  const transcribe = vi.fn().mockImplementation(
    () => new Promise<string>(() => {}),
  );
  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: transcribe, onTranscript: vi.fn() }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => result.current.stop());

  expect(result.current.state).toBe("transcribing");
});

it("cancels during preparing without inserting the transcript", async () => {
  vi.mocked(readVoiceStatus)
    .mockReset()
    .mockResolvedValue(coldVoiceStatus());
  let settle: ((text: string) => void) | undefined;
  const transcribe = vi.fn().mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        settle = resolve;
      }),
  );
  const transcript = vi.fn();
  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: transcribe, onTranscript: transcript }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => result.current.stop());
  expect(result.current.state).toBe("preparing");

  await act(async () => result.current.cancel());
  expect(result.current.state).toBe("idle");
  expect(appToast.error).not.toHaveBeenCalled();

  await act(async () => {
    settle?.("late words");
  });
  expect(transcript).not.toHaveBeenCalled();
  expect(result.current.state).toBe("idle");
});

it("honours cancel issued while the voice status read is still pending", async () => {
  let resolveStatus:
    | ((value: ReturnType<typeof readyVoiceStatus>) => void)
    | undefined;
  vi.mocked(readVoiceStatus)
    .mockReset()
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );
  const transcribe = vi.fn().mockResolvedValue("late words");
  const transcript = vi.fn();
  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: transcribe, onTranscript: transcript }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => result.current.stop());

  await act(async () => result.current.cancel());
  await act(async () => {
    resolveStatus?.(readyVoiceStatus());
  });

  expect(transcribe).not.toHaveBeenCalled();
  expect(transcript).not.toHaveBeenCalled();
  expect(result.current.state).toBe("idle");
});

it("drops a pending transcription when the composer scope changes", async () => {
  let resolveStatus:
    | ((value: ReturnType<typeof readyVoiceStatus>) => void)
    | undefined;
  vi.mocked(readVoiceStatus)
    .mockReset()
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );
  const transcribe = vi.fn().mockResolvedValue("late words");
  const transcript = vi.fn();
  const { result, rerender } = renderHook(
    ({ scopeKey }: { scopeKey: string }) =>
      useVoiceInput({
        onTranscribe: transcribe,
        onTranscript: transcript,
        scopeKey,
      }),
    { initialProps: { scopeKey: "thread-a" } },
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => result.current.stop());

  rerender({ scopeKey: "thread-b" });
  await act(async () => {
    resolveStatus?.(readyVoiceStatus());
  });

  expect(transcribe).not.toHaveBeenCalled();
  expect(transcript).not.toHaveBeenCalled();
  expect(result.current.state).toBe("idle");
});

it("transcribes even when the voice status read fails", async () => {
  vi.mocked(readVoiceStatus)
    .mockReset()
    .mockRejectedValue(new Error("status unavailable"));
  const transcribe = vi.fn().mockResolvedValue("spoken words");
  const transcript = vi.fn();
  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: transcribe, onTranscript: transcript }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => result.current.stop());

  expect(result.current.state).toBe("idle");
  expect(transcript).toHaveBeenCalledWith("spoken words");
});

it("rejects near-silent audio without transcribing", async () => {
  const { tracks } = stubMicrophone([{ stop: vi.fn() }]);
  class SilentVoiceboxRenderer {
    constructor(
      readonly channels: number,
      readonly frames: number,
      readonly sampleRate: number,
    ) {}
    createBufferSource() {
      return { buffer: null, connect: vi.fn(), start: vi.fn() };
    }
    async startRendering() {
      return fakeAudioBuffer({
        length: 4_000,
        duration: 0.25,
        sampleRate: this.sampleRate,
        numberOfChannels: this.channels,
        samples: new Float32Array(0),
      });
    }
  }
  vi.stubGlobal("OfflineAudioContext", SilentVoiceboxRenderer);
  const transcribe = vi.fn();
  const transcript = vi.fn();
  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: transcribe, onTranscript: transcript }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => result.current.stop());

  expect(transcribe).not.toHaveBeenCalled();
  expect(transcript).not.toHaveBeenCalled();
  expect(result.current.state).toBe("idle");
  expect(appToast.error).toHaveBeenCalledWith(
    "No clear speech detected. Try again.",
  );
  expect(tracks[0]?.stop).toHaveBeenCalled();
});

it("rejects a pathologically repetitive transcript without inserting it", async () => {
  const transcribe = vi
    .fn()
    .mockResolvedValue(
      "thank you thank you thank you thank you thank you thank you",
    );
  const transcript = vi.fn();
  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: transcribe, onTranscript: transcript }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => result.current.stop());

  expect(transcribe).toHaveBeenCalledTimes(1);
  expect(transcript).not.toHaveBeenCalled();
  expect(result.current.state).toBe("idle");
  expect(appToast.error).toHaveBeenCalledWith(
    "No clear speech detected. Try again.",
  );
});

it("still appends a normal transcript with no rejection toast", async () => {
  const transcribe = vi.fn().mockResolvedValue("hello there");
  const transcript = vi.fn();
  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: transcribe, onTranscript: transcript }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => result.current.stop());

  expect(transcript).toHaveBeenCalledWith("hello there");
  expect(result.current.state).toBe("idle");
  expect(appToast.error).not.toHaveBeenCalled();
});

it("keeps cancel behaviour when cancellation lands during analysis", async () => {
  let releaseRender: (() => void) | undefined;
  class SlowVoiceboxRenderer {
    constructor(
      readonly channels: number,
      readonly frames: number,
      readonly sampleRate: number,
    ) {}
    createBufferSource() {
      return { buffer: null, connect: vi.fn(), start: vi.fn() };
    }
    async startRendering() {
      await new Promise<void>((resolve) => {
        releaseRender = resolve;
      });
      return fakeAudioBuffer({
        length: 4_000,
        duration: 0.25,
        sampleRate: this.sampleRate,
        numberOfChannels: this.channels,
        samples: new Float32Array(0),
      });
    }
  }
  vi.stubGlobal("OfflineAudioContext", SlowVoiceboxRenderer);
  const transcribe = vi.fn();
  const transcript = vi.fn();
  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: transcribe, onTranscript: transcript }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => {
    void result.current.stop();
  });
  expect(result.current.state).toBe("transcribing");

  await act(async () => result.current.cancel());
  expect(result.current.state).toBe("idle");

  await act(async () => {
    releaseRender?.();
  });

  expect(transcribe).not.toHaveBeenCalled();
  expect(transcript).not.toHaveBeenCalled();
  expect(result.current.state).toBe("idle");
  expect(appToast.error).not.toHaveBeenCalled();
});
