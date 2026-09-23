// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appToast } from "@/components/ui/app-toast";
import { useVoiceInput } from "./useVoiceInput";

vi.mock("@/components/ui/app-toast", () => ({ appToast: { error: vi.fn() } }));
vi.mock("@/lib/audio-input-device-preference", () => ({
  useAudioInputDevicePreferenceValue: () => null,
  buildAudioInputConstraints: () => ({ audio: true }),
}));

class Recorder {
  static isTypeSupported = () => true;
  mimeType = "audio/webm";
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("MediaRecorder", Recorder);
  stubMicrophone();
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
  expect(result.current.state).toBe("idle");
  expect(tracks[0]?.stop).toHaveBeenCalled();
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
