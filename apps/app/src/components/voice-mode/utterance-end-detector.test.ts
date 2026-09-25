import { describe, expect, it } from "vitest";
import { UtteranceEndDetector } from "./utterance-end-detector";

function detector(start = 10_000) {
  let t = start;
  return {
    vad: new UtteranceEndDetector({
      speechThreshold: 0.1,
      silenceMs: 1_200,
      minSpeechMs: 500,
      now: () => t,
    }),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("UtteranceEndDetector", () => {
  it("never fires on silence", () => {
    const { vad, advance } = detector();
    for (let i = 0; i < 50; i += 1) {
      expect(vad.update(0.01)).toBe(false);
      advance(100);
    }
  });

  it("ends the utterance after sustained speech followed by silence", () => {
    const { vad, advance } = detector();
    // 1s of speech.
    for (let i = 0; i < 10; i += 1) {
      vad.update(0.4);
      advance(100);
    }
    // 1.1s of silence — not yet.
    for (let i = 0; i < 11; i += 1) {
      expect(vad.update(0.01)).toBe(false);
      advance(100);
    }
    // Past the 1.2s hangover: fires exactly once.
    expect(vad.update(0.01)).toBe(true);
    advance(100);
    expect(vad.update(0.01)).toBe(false);
  });

  it("discards short blips without ending the utterance", () => {
    const { vad, advance } = detector();
    // 200ms blip (under minSpeechMs).
    for (let i = 0; i < 2; i += 1) {
      vad.update(0.5);
      advance(100);
    }
    // 1.3s of silence clears the blip but must not fire.
    for (let i = 0; i < 13; i += 1) {
      expect(vad.update(0.01)).toBe(false);
      advance(100);
    }
    // Real utterance afterwards still works: 900ms speech, then the 1.2s
    // hangover completes on the 12th silence sample.
    for (let i = 0; i < 10; i += 1) {
      vad.update(0.4);
      advance(100);
    }
    for (let i = 0; i < 13; i += 1) {
      const ended = vad.update(0.01);
      advance(100);
      if (i === 11) {
        expect(ended).toBe(true);
      } else {
        expect(ended).toBe(false);
      }
    }
  });

  it("paused speech within the hangover does not end the utterance", () => {
    const { vad, advance } = detector();
    for (let i = 0; i < 8; i += 1) {
      vad.update(0.4);
      advance(100);
    }
    // 1.1s pause mid-sentence.
    for (let i = 0; i < 11; i += 1) {
      expect(vad.update(0.01)).toBe(false);
      advance(100);
    }
    // Sentence resumes.
    for (let i = 0; i < 8; i += 1) {
      vad.update(0.4);
      advance(100);
    }
    for (let i = 0; i < 12; i += 1) {
      const ended = vad.update(0.01);
      advance(100);
      if (i === 11) {
        expect(ended).toBe(true);
      } else {
        expect(ended).toBe(false);
      }
    }
  });

  it("reset re-arms after firing", () => {
    const { vad, advance } = detector();
    for (let i = 0; i < 10; i += 1) {
      vad.update(0.4);
      advance(100);
    }
    for (let i = 0; i < 13; i += 1) {
      vad.update(0.01);
      advance(100);
    }
    vad.reset();
    for (let i = 0; i < 10; i += 1) {
      vad.update(0.4);
      advance(100);
    }
    for (let i = 0; i < 11; i += 1) {
      expect(vad.update(0.01)).toBe(false);
      advance(100);
    }
  });
});
