// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribeVoiceInput } from "@/lib/api";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import type { PromptBoxHandle } from "./PromptBoxInternal";
import { usePromptVoice } from "./usePromptVoice";

vi.mock("@/lib/api", () => ({
  transcribeVoiceInput: vi.fn(),
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      generalSettings: {
        voice: { enabled: true },
      },
    },
  }),
}));

vi.mock("@/hooks/useVoiceInput", () => ({
  useVoiceInput: vi.fn(),
}));

const voiceInput = {
  state: "transcribing" as const,
  isSupported: true,
  unsupportedReason: null,
  errorMessage: null,
  stream: null,
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
};

function promptBoxHandle(overrides: Partial<PromptBoxHandle> = {}) {
  return {
    captureHeightForLayoutChange: vi.fn(),
    focusEnd: vi.fn(),
    getTextBeforeCursor: vi.fn(),
    insertTextAtCursor: vi.fn(),
    appendVoiceTranscript: vi.fn(),
    playVoiceCompletionTransition: vi.fn(async () => {}),
    ...overrides,
  } satisfies PromptBoxHandle;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("usePromptVoice", () => {
  it("waits for the completion transition after transcription resolves", async () => {
    vi.mocked(useVoiceInput).mockReturnValue({
      ...voiceInput,
      isRecording: false,
      isProcessing: true,
      isListening: false,
    });
    vi.mocked(transcribeVoiceInput).mockResolvedValue({ text: "Transcript" });

    let finishTransition: (() => void) | undefined;
    const playVoiceCompletionTransition = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishTransition = resolve;
        }),
    );
    const appendVoiceTranscript = vi.fn();
    const promptBoxRef = {
      current: promptBoxHandle({
        appendVoiceTranscript,
        playVoiceCompletionTransition,
      }),
    };

    renderHook(() => usePromptVoice(promptBoxRef));
    const options = vi.mocked(useVoiceInput).mock.calls[0]?.[0];
    const transcription = options?.onTranscribe({
      file: new File([], "recording.wav", { type: "audio/wav" }),
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(playVoiceCompletionTransition).toHaveBeenCalledOnce();

    let settled = false;
    void transcription?.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishTransition?.();
    await expect(transcription).resolves.toBe("Transcript");
    expect(appendVoiceTranscript).not.toHaveBeenCalled();
  });

  it("appends the transcript at the end of the draft", () => {
    vi.mocked(useVoiceInput).mockReturnValue({
      ...voiceInput,
      isRecording: false,
      isProcessing: false,
      isListening: false,
    });
    const appendVoiceTranscript = vi.fn();
    const insertTextAtCursor = vi.fn();
    const promptBoxRef = {
      current: promptBoxHandle({ appendVoiceTranscript, insertTextAtCursor }),
    };

    renderHook(() => usePromptVoice(promptBoxRef));
    const options = vi.mocked(useVoiceInput).mock.calls[0]?.[0];
    options?.onTranscript("spoken words");

    expect(appendVoiceTranscript).toHaveBeenCalledWith("spoken words");
    expect(insertTextAtCursor).not.toHaveBeenCalled();
  });

  it("drops a transcript that resolves after the request was aborted", async () => {
    vi.mocked(useVoiceInput).mockReturnValue({
      ...voiceInput,
      isRecording: false,
      isProcessing: true,
      isListening: false,
    });
    vi.mocked(transcribeVoiceInput).mockResolvedValue({ text: "late text" });
    const promptBoxRef = { current: promptBoxHandle() };

    renderHook(() => usePromptVoice(promptBoxRef));
    const options = vi.mocked(useVoiceInput).mock.calls[0]?.[0];
    const controller = new AbortController();
    controller.abort();

    await expect(
      options?.onTranscribe({
        file: new File([], "recording.wav", { type: "audio/wav" }),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("passes the composer scope key into the voice input lifecycle", () => {
    vi.mocked(useVoiceInput).mockReturnValue({
      ...voiceInput,
      isRecording: false,
      isProcessing: false,
      isListening: false,
    });

    renderHook(() => usePromptVoice({ current: promptBoxHandle() }, "thread-1"));

    expect(vi.mocked(useVoiceInput).mock.calls[0]?.[0].scopeKey).toBe(
      "thread-1",
    );
  });
});
