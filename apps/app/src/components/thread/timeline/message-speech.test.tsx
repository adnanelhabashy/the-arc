// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { SystemVoiceStatusResponse } from "@bb/server-contract";
import type * as ApiModule from "@/lib/api";
import { appToast } from "@/components/ui/app-toast";
import { readVoiceStatus, speakVoiceText } from "@/lib/api";
import {
  MessageSpeechProvider,
  useMessageSpeech,
} from "./message-speech";

vi.mock("@/components/ui/app-toast", () => ({ appToast: { error: vi.fn() } }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    readVoiceStatus: vi.fn(),
    speakVoiceText: vi.fn(),
  };
});

const audioInstances: FakeAudio[] = [];

class FakeAudio {
  src = "";
  paused = true;
  playCalls: string[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    audioInstances.push(this);
  }

  play() {
    this.paused = false;
    this.playCalls.push(this.src);
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

function ttsReadyStatus(): SystemVoiceStatusResponse {
  return {
    transcriptionEnabled: true,
    voiceEnabled: true,
    speech: {
      runtimeState: "ready",
      version: "0.5.0",
      speechModelLoaded: true,
      voiceModel: {
        engine: "kokoro",
        size: "base",
        downloaded: true,
        loaded: true,
        downloading: false,
        downloadPercent: null,
      },
    },
  };
}

function ttsColdStatus(): SystemVoiceStatusResponse {
  return {
    transcriptionEnabled: true,
    voiceEnabled: true,
    speech: {
      runtimeState: "ready",
      version: "0.5.0",
      speechModelLoaded: true,
      voiceModel: null,
    },
  };
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <MessageSpeechProvider>{children}</MessageSpeechProvider>
);

const flush = () => act(async () => {});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("Audio", FakeAudio);
  let counter = 0;
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => {
      const url = `blob:test-${counter}`;
      counter += 1;
      return url;
    }),
    revokeObjectURL: vi.fn(),
  });
  audioInstances.length = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("MessageSpeechProvider", () => {
  it("shows generating immediately and never flashes preparing when warm", async () => {
    vi.mocked(readVoiceStatus).mockImplementation(
      () => new Promise<SystemVoiceStatusResponse>(() => {}),
    );
    vi.mocked(speakVoiceText).mockImplementation(
      () => new Promise<Blob>(() => {}),
    );
    const { result } = renderHook(() => useMessageSpeech(), { wrapper });

    act(() => {
      result.current.speak("msg-1", "A warm reply.");
    });

    expect(result.current.state).toBe("generating");
    expect(result.current.activeMessageId).toBe("msg-1");
  });

  it("moves to preparing while the voice model is not usable", async () => {
    vi.mocked(readVoiceStatus).mockResolvedValue(ttsColdStatus());
    vi.mocked(speakVoiceText).mockImplementation(
      () => new Promise<Blob>(() => {}),
    );
    const { result } = renderHook(() => useMessageSpeech(), { wrapper });

    act(() => {
      result.current.speak("msg-1", "A cold reply.");
    });
    await flush();

    expect(result.current.state).toBe("preparing");

    vi.mocked(readVoiceStatus).mockResolvedValue(ttsReadyStatus());
    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    expect(result.current.state).toBe("generating");
  });

  it("plays chunks in order and prefetches the next chunk during playback", async () => {
    vi.mocked(readVoiceStatus).mockResolvedValue(ttsReadyStatus());
    const speakOrder: string[] = [];
    vi.mocked(speakVoiceText).mockImplementation(async (text) => {
      speakOrder.push(text);
      return new Blob([text]);
    });
    const text = `${"A".repeat(400)}. ${"B".repeat(400)}.`;
    const { result } = renderHook(() => useMessageSpeech(), { wrapper });

    act(() => {
      result.current.speak("msg-1", text);
    });
    await flush();

    expect(result.current.state).toBe("speaking");
    expect(speakOrder).toEqual([`${"A".repeat(400)}.`, `${"B".repeat(400)}.`]);

    const audio = audioInstances[0];
    expect(audio.playCalls.length).toBe(1);

    await act(async () => {
      audio.onended?.();
    });
    expect(audio.playCalls.length).toBe(2);

    await act(async () => {
      audio.onended?.();
    });
    expect(result.current.state).toBe("idle");
    expect(result.current.activeMessageId).toBeNull();
  });

  it("stops playback and revokes object URLs", async () => {
    vi.mocked(readVoiceStatus).mockResolvedValue(ttsReadyStatus());
    vi.mocked(speakVoiceText).mockResolvedValue(new Blob(["audio"]));
    const { result } = renderHook(() => useMessageSpeech(), { wrapper });

    act(() => {
      result.current.speak("msg-1", "Speak me.");
    });
    await flush();

    expect(result.current.state).toBe("speaking");
    const audio = audioInstances[0];
    expect(audio.playCalls.length).toBe(1);

    act(() => {
      result.current.stop();
    });

    expect(result.current.state).toBe("idle");
    expect(result.current.activeMessageId).toBeNull();
    expect(audio.paused).toBe(true);
    expect(audio.src).toBe("");
    expect(vi.mocked(URL.revokeObjectURL)).toHaveBeenCalled();
  });

  it("cleans up playback on unmount", async () => {
    vi.mocked(readVoiceStatus).mockResolvedValue(ttsReadyStatus());
    vi.mocked(speakVoiceText).mockResolvedValue(new Blob(["audio"]));
    const { result, unmount } = renderHook(() => useMessageSpeech(), {
      wrapper,
    });

    act(() => {
      result.current.speak("msg-1", "Speak me.");
    });
    await flush();

    const audio = audioInstances[0];
    expect(audio.playCalls.length).toBe(1);

    unmount();

    expect(audio.paused).toBe(true);
    expect(audio.src).toBe("");
    expect(vi.mocked(URL.revokeObjectURL)).toHaveBeenCalled();
  });

  it("resets to idle and reports a failure", async () => {
    vi.mocked(readVoiceStatus).mockResolvedValue(ttsReadyStatus());
    vi.mocked(speakVoiceText).mockRejectedValue(new Error("synthesis failed"));
    const { result } = renderHook(() => useMessageSpeech(), { wrapper });

    act(() => {
      result.current.speak("msg-1", "Speak me.");
    });
    await flush();

    expect(result.current.state).toBe("idle");
    expect(result.current.activeMessageId).toBeNull();
    expect(vi.mocked(appToast.error)).toHaveBeenCalledWith(
      "Speak failed",
      expect.objectContaining({ description: "synthesis failed" }),
    );
  });

  it("stops the current message when another message is spoken", async () => {
    vi.mocked(readVoiceStatus).mockResolvedValue(ttsReadyStatus());
    vi.mocked(speakVoiceText).mockResolvedValue(new Blob(["audio"]));
    const { result } = renderHook(() => useMessageSpeech(), { wrapper });

    act(() => {
      result.current.speak("msg-1", "First message.");
    });
    await flush();
    expect(result.current.activeMessageId).toBe("msg-1");
    expect(audioInstances[0].playCalls.length).toBe(1);

    act(() => {
      result.current.speak("msg-2", "Second message.");
    });
    await flush();

    expect(result.current.activeMessageId).toBe("msg-2");
    expect(audioInstances[0].playCalls.length).toBe(2);
  });

  it("restarts cleanly when the same message is spoken again", async () => {
    vi.mocked(readVoiceStatus).mockResolvedValue(ttsReadyStatus());
    vi.mocked(speakVoiceText).mockResolvedValue(new Blob(["audio"]));
    const { result } = renderHook(() => useMessageSpeech(), { wrapper });

    act(() => {
      result.current.speak("msg-1", "Speak me.");
    });
    await flush();
    act(() => {
      result.current.speak("msg-1", "Speak me.");
    });
    await flush();

    expect(result.current.activeMessageId).toBe("msg-1");
    expect(audioInstances[0].playCalls.length).toBe(2);
  });
});
