import { describe, expect, it, vi } from "vitest";
import {
  VoiceModeSession,
  type VoiceModeEffects,
  type VoiceModeState,
} from "./voice-mode-state";

function createSession(
  effects: VoiceModeEffects,
  deferQueue: Array<() => void>,
) {
  return new VoiceModeSession(effects, { defer: (fn) => deferQueue.push(fn) });
}

function createEffects(overrides: Partial<VoiceModeEffects> = {}) {
  const effects: VoiceModeEffects = {
    startCapture: vi.fn(),
    cancelCapture: vi.fn(),
    transcribe: vi.fn(async () => "hello arc"),
    send: vi.fn(async () => {}),
    awaitAssistantReply: vi.fn(async () => ({
      messageId: "msg_1",
      text: "The answer is forty two.",
    })),
    speak: vi.fn(async () => {}),
    stopSpeaking: vi.fn(),
    startBargeInDetection: vi.fn(),
    stopBargeInDetection: vi.fn(),
    ...overrides,
  };
  return effects;
}

function collectStates(session: VoiceModeSession): VoiceModeState[] {
  const states: VoiceModeState[] = [session.getState()];
  session.subscribe((state) => {
    states.push(state);
  });
  return states;
}

const kinds = (states: VoiceModeState[]) =>
  states.map((state) => state.kind);

describe("VoiceModeSession", () => {
  it("runs the full loop idle → listening → transcribing → thinking → speaking → listening", async () => {
    const effects = createEffects();
    const session = new VoiceModeSession(effects);
    const states = collectStates(session);

    session.start();
    expect(effects.startCapture).toHaveBeenCalledTimes(1);
    session.utteranceEnded();
    await vi.waitFor(() => {
      expect(session.getState().kind).toBe("listening");
    });

    expect(effects.transcribe).toHaveBeenCalledTimes(1);
    expect(effects.send).toHaveBeenCalledWith("hello arc");
    expect(effects.awaitAssistantReply).toHaveBeenCalledTimes(1);
    expect(effects.speak).toHaveBeenCalledWith(
      "msg_1",
      "The answer is forty two.",
    );
    expect(effects.startBargeInDetection).toHaveBeenCalledTimes(1);
    expect(kinds(states)).toEqual([
      "idle",
      "listening",
      "transcribing",
      "thinking",
      "speaking",
      "listening",
    ]);
  });

  it("loops back to listening when the transcript is empty", async () => {
    const effects = createEffects({
      transcribe: vi.fn(async () => null),
    });
    const session = new VoiceModeSession(effects);
    session.start();
    session.utteranceEnded();
    await vi.waitFor(() => {
      expect(session.getState().kind).toBe("listening");
    });
    expect(effects.send).not.toHaveBeenCalled();
    expect(effects.startCapture).toHaveBeenCalledTimes(2);
  });

  it("loops back to listening when the assistant produced nothing", async () => {
    const effects = createEffects({
      awaitAssistantReply: vi.fn(async () => null),
    });
    const session = new VoiceModeSession(effects);
    session.start();
    session.utteranceEnded();
    await vi.waitFor(() => {
      expect(session.getState().kind).toBe("listening");
    });
    expect(effects.speak).not.toHaveBeenCalled();
  });

  it("barge-in stops playback and immediately listens again", async () => {
    const resolvers: Array<() => void> = [];
    const deferQueue: Array<() => void> = [];
    const effects = createEffects({
      speak: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolvers.push(resolve);
          }),
      ),
    });
    const session = createSession(effects, deferQueue);
    const states = collectStates(session);
    session.start();
    session.utteranceEnded();
    await vi.waitFor(() => {
      expect(session.getState().kind).toBe("speaking");
    });

    session.handleBargeIn();

    expect(effects.stopSpeaking).toHaveBeenCalledTimes(1);
    expect(effects.stopBargeInDetection).toHaveBeenCalledTimes(1);
    expect(session.getState().kind).toBe("interrupted");
    // The contraction gets one frame before capture restarts.
    expect(deferQueue).toHaveLength(1);
    deferQueue.shift()?.();
    expect(session.getState().kind).toBe("listening");
    expect(effects.startCapture).toHaveBeenCalledTimes(2);

    resolvers.shift()?.();
    await Promise.resolve();
    // The stale speak completion must not advance the new listening state.
    expect(session.getState().kind).toBe("listening");
    expect(kinds(states)).toEqual([
      "idle",
      "listening",
      "transcribing",
      "thinking",
      "speaking",
      "interrupted",
      "listening",
    ]);
  });

  it("barge-in only fires while speaking", () => {
    const effects = createEffects();
    const session = new VoiceModeSession(effects);
    session.handleBargeIn();
    expect(effects.stopSpeaking).not.toHaveBeenCalled();
    expect(session.getState().kind).toBe("idle");
  });

  it("a transcribe failure lands on error and acknowledges to idle", async () => {
    const effects = createEffects({
      transcribe: vi.fn(async () => {
        throw new Error("mic vanished");
      }),
    });
    const session = new VoiceModeSession(effects);
    session.start();
    session.utteranceEnded();
    await vi.waitFor(() => {
      expect(session.getState().kind).toBe("error");
    });
    const state = session.getState();
    if (state.kind !== "error") throw new Error("expected error state");
    expect(state.message).toBe("mic vanished");

    session.acknowledgeError();
    expect(session.getState().kind).toBe("idle");
    session.start();
    expect(session.getState().kind).toBe("listening");
  });

  it("cancel tears down everything from any state", async () => {
    const resolvers: Array<() => void> = [];
    const effects = createEffects({
      speak: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolvers.push(resolve);
          }),
      ),
    });
    const session = new VoiceModeSession(effects);
    session.start();
    session.utteranceEnded();
    await vi.waitFor(() => {
      expect(session.getState().kind).toBe("speaking");
    });
    session.cancel();
    expect(session.getState().kind).toBe("idle");
    expect(effects.stopSpeaking).toHaveBeenCalledTimes(1);
    expect(effects.cancelCapture).toHaveBeenCalledTimes(1);
    expect(effects.stopBargeInDetection).toHaveBeenCalledTimes(1);
    resolvers.shift()?.();
    await Promise.resolve();
    expect(session.getState().kind).toBe("idle");
  });

  it("a stale speak completion cannot restart capture after cancel", async () => {
    const resolvers: Array<() => void> = [];
    const effects = createEffects({
      speak: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolvers.push(resolve);
          }),
      ),
    });
    const session = new VoiceModeSession(effects);
    session.start();
    session.utteranceEnded();
    await vi.waitFor(() => {
      expect(session.getState().kind).toBe("speaking");
    });
    session.cancel();
    const callsBefore = vi.mocked(effects.startCapture).mock.calls.length;
    resolvers.shift()?.();
    await Promise.resolve();
    expect(vi.mocked(effects.startCapture).mock.calls.length).toBe(
      callsBefore,
    );
  });

  it("a stale reply cannot start speaking after cancel", async () => {
    const replyResolvers: Array<
      (reply: { messageId: string; text: string } | null) => void
    > = [];
    const effects = createEffects({
      awaitAssistantReply: vi.fn(
        () =>
          new Promise<{ messageId: string; text: string } | null>(
            (resolve) => {
              replyResolvers.push(resolve);
            },
          ),
      ),
    });
    const session = new VoiceModeSession(effects);
    session.start();
    session.utteranceEnded();
    await vi.waitFor(() => {
      expect(effects.awaitAssistantReply).toHaveBeenCalled();
    });
    session.cancel();
    replyResolvers.shift()?.({ messageId: "msg_late", text: "too late" });
    await Promise.resolve();
    expect(effects.speak).not.toHaveBeenCalled();
    expect(session.getState().kind).toBe("idle");
  });

  it("externalError reports an asynchronous capture failure into the error state", () => {
    const effects = createEffects();
    const session = new VoiceModeSession(effects);
    session.start();
    expect(session.getState().kind).toBe("listening");

    session.externalError("Microphone permission denied");
    expect(session.getState().kind).toBe("error");
    const state = session.getState();
    if (state.kind !== "error") throw new Error("expected error state");
    expect(state.message).toBe("Microphone permission denied");
    expect(effects.cancelCapture).toHaveBeenCalledTimes(1);

    session.acknowledgeError();
    expect(session.getState().kind).toBe("idle");
  });

  it("externalError from idle is a no-op", () => {
    const effects = createEffects();
    const session = new VoiceModeSession(effects);
    session.externalError("late failure");
    expect(session.getState().kind).toBe("idle");
  });
});
