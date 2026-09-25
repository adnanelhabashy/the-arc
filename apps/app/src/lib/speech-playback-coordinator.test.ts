import { describe, expect, it, vi } from "vitest";
import {
  registerSpeechPlaybackOwner,
  releaseSpeechPlayback,
  requestSpeechPlayback,
  type SpeechPlaybackOwner,
} from "./speech-playback-coordinator";

function ownerHarness(owner: SpeechPlaybackOwner) {
  const stop = vi.fn();
  const unregister = registerSpeechPlaybackOwner(owner, stop);
  return { stop, unregister };
}

describe("speech-playback-coordinator", () => {
  it("lets a new owner stop the current one", () => {
    const first = ownerHarness("message-speech");
    const second = ownerHarness("automation-voice");

    requestSpeechPlayback("message-speech");
    requestSpeechPlayback("automation-voice");

    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(second.stop).not.toHaveBeenCalled();
    first.unregister();
    second.unregister();
  });

  it("re-requesting the same owner does not stop it", () => {
    const first = ownerHarness("message-speech");

    requestSpeechPlayback("message-speech");
    requestSpeechPlayback("message-speech");

    expect(first.stop).not.toHaveBeenCalled();
    first.unregister();
  });

  it("stops every registered instance of the displaced owner", () => {
    const surfaceA = ownerHarness("message-speech");
    const surfaceB = ownerHarness("message-speech");
    const automation = ownerHarness("automation-voice");

    requestSpeechPlayback("message-speech");
    requestSpeechPlayback("automation-voice");

    expect(surfaceA.stop).toHaveBeenCalledTimes(1);
    expect(surfaceB.stop).toHaveBeenCalledTimes(1);
    automation.unregister();
    surfaceA.unregister();
    surfaceB.unregister();
  });

  it("a stopped owner that released the slot does not clobber the new owner", () => {
    const messageSpeech = ownerHarness("message-speech");
    const automation = ownerHarness("automation-voice");

    requestSpeechPlayback("message-speech");
    requestSpeechPlayback("automation-voice");
    // The displaced owner releases as part of its stop; the coordinator has
    // already handed the slot to the requester.
    releaseSpeechPlayback("message-speech");
    releaseSpeechPlayback("automation-voice");

    requestSpeechPlayback("message-speech");
    expect(automation.stop).toHaveBeenCalledTimes(1);
    expect(messageSpeech.stop).toHaveBeenCalledTimes(1);
    messageSpeech.unregister();
    automation.unregister();
  });

  it("unregistered owners are not stopped", () => {
    const preview = ownerHarness("voice-preview");
    preview.unregister();
    const automation = ownerHarness("automation-voice");

    requestSpeechPlayback("voice-preview");
    requestSpeechPlayback("automation-voice");

    expect(preview.stop).not.toHaveBeenCalled();
    automation.unregister();
  });
});
