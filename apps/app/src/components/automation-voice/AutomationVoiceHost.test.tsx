// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ApiModule from "@/lib/api";
import { speakVoiceText } from "@/lib/api";
import {
  registerSpeechPlaybackOwner,
  requestSpeechPlayback,
} from "@/lib/speech-playback-coordinator";
import { AUTOMATION_VOICE_ANNOUNCE_CHANNEL } from "./automation-voice";
import { AutomationVoiceHost } from "./AutomationVoiceHost";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, speakVoiceText: vi.fn() };
});

const signalHandlers: Array<(signal: unknown) => void> = [];

vi.mock("@/lib/ws", () => ({
  wsManager: {
    onPluginSignal: vi.fn((handler: (signal: unknown) => void) => {
      signalHandlers.push(handler);
      return () => {
        const index = signalHandlers.indexOf(handler);
        if (index >= 0) signalHandlers.splice(index, 1);
      };
    }),
  },
}));

let voiceEnabled = true;

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: { generalSettings: { voice: { enabled: voiceEnabled } } },
  }),
}));

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

function announce(
  overrides: Record<string, unknown> = {},
): void {
  const signal = {
    channel: AUTOMATION_VOICE_ANNOUNCE_CHANNEL,
    payload: {
      text: "Build finished.",
      threadId: "thr_1",
      automationId: "auto_1",
      providerId: "codex",
      ...overrides,
    },
  };
  for (const handler of [...signalHandlers]) {
    handler(signal);
  }
}

const flush = () => act(async () => {});

beforeEach(() => {
  voiceEnabled = true;
  vi.stubGlobal("Audio", FakeAudio);
  let counter = 0;
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => {
      counter += 1;
      return `blob:announce-${counter}`;
    }),
    revokeObjectURL: vi.fn(),
  });
  audioInstances.length = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  signalHandlers.length = 0;
});

describe("AutomationVoiceHost", () => {
  it("speaks an announcement with the agent voice resolved from the provider", async () => {
    vi.mocked(speakVoiceText).mockResolvedValue(new Blob(["audio"]));
    render(<AutomationVoiceHost />);

    act(() => {
      announce();
    });
    await flush();

    expect(speakVoiceText).toHaveBeenCalledWith(
      "Build finished.",
      expect.objectContaining({ agentId: "codex" }),
    );
    expect(audioInstances[0]?.playCalls).toHaveLength(1);
  });

  it("maps a non-agent provider to the global default voice", async () => {
    vi.mocked(speakVoiceText).mockResolvedValue(new Blob(["audio"]));
    render(<AutomationVoiceHost />);

    act(() => {
      announce({ providerId: "some-other-provider" });
    });
    await flush();

    expect(speakVoiceText).toHaveBeenCalledWith(
      "Build finished.",
      expect.objectContaining({ agentId: undefined }),
    );
  });

  it("stays silent when the voice master switch is off", async () => {
    voiceEnabled = false;
    vi.mocked(speakVoiceText).mockResolvedValue(new Blob(["audio"]));
    render(<AutomationVoiceHost />);

    act(() => {
      announce();
    });
    await flush();

    expect(speakVoiceText).not.toHaveBeenCalled();
  });

  it("ignores malformed payloads", async () => {
    vi.mocked(speakVoiceText).mockResolvedValue(new Blob(["audio"]));
    render(<AutomationVoiceHost />);

    act(() => {
      announce({ text: "" });
      announce({ providerId: undefined });
    });
    await flush();

    expect(speakVoiceText).not.toHaveBeenCalled();
  });

  it("queues announcements FIFO and drops failures silently", async () => {
    const spoken: string[] = [];
    vi.mocked(speakVoiceText).mockImplementation((text: string) => {
      spoken.push(text);
      if (text === "second.") {
        return Promise.reject(new Error("voice unavailable"));
      }
      return Promise.resolve(new Blob(["audio"]));
    });
    render(<AutomationVoiceHost />);

    act(() => {
      announce({ text: "first." });
    });
    await flush();
    act(() => {
      audioInstances[0]?.onended?.();
    });
    act(() => {
      announce({ text: "second." });
      announce({ text: "third." });
    });
    await flush();
    act(() => {
      audioInstances[0]?.onended?.();
    });
    await flush();

    expect(spoken).toEqual(["first.", "second.", "third."]);
  });

  it("stops playback and clears the queue when voice is disabled mid-play", async () => {
    vi.mocked(speakVoiceText).mockResolvedValue(new Blob(["audio"]));
    const { rerender } = render(<AutomationVoiceHost />);

    act(() => {
      announce({ text: "first." });
    });
    await flush();
    expect(audioInstances[0]?.paused).toBe(false);

    voiceEnabled = false;
    rerender(<AutomationVoiceHost />);
    await flush();

    expect(audioInstances[0]?.paused).toBe(true);

    act(() => {
      announce({ text: "while off" });
    });
    await flush();
    expect(vi.mocked(speakVoiceText).mock.calls.map((call) => call[0])).toEqual(
      ["first."],
    );

    voiceEnabled = true;
    rerender(<AutomationVoiceHost />);
    act(() => {
      announce({ text: "after re-enable" });
    });
    await flush();
    expect(vi.mocked(speakVoiceText).mock.calls.map((call) => call[0])).toEqual([
      "first.",
      "after re-enable",
    ]);
  });

  it("a cross-owner steal cancels queued announcements", async () => {
    vi.mocked(speakVoiceText).mockImplementation((text: string) =>
      Promise.resolve(new Blob([text])),
    );
    render(<AutomationVoiceHost />);

    act(() => {
      announce({ text: "first." });
    });
    await flush();
    act(() => {
      announce({ text: "second." });
      announce({ text: "third." });
    });

    const stopMessageSpeech = vi.fn();
    const unregister = registerSpeechPlaybackOwner(
      "message-speech",
      stopMessageSpeech,
    );
    act(() => {
      requestSpeechPlayback("message-speech");
    });
    unregister();
    await flush();

    expect(stopMessageSpeech).not.toHaveBeenCalled();
    expect(audioInstances[0]?.paused).toBe(true);

    act(() => {
      announce({ text: "fourth." });
    });
    await flush();

    expect(vi.mocked(speakVoiceText).mock.calls.map((call) => call[0])).toEqual(
      ["first.", "fourth."],
    );
  });
});
