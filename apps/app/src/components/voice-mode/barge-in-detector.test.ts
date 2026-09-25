import { describe, expect, it, vi } from "vitest";
import {
  BargeInTracker,
  startBargeInDetection,
  type BargeInDetectorDeps,
} from "./barge-in-detector";

function trackerWithClock(start = 1000) {
  let t = start;
  return {
    tracker: new BargeInTracker({
      threshold: 0.05,
      minWindows: 3,
      cooldownMs: 600,
      now: () => t,
    }),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("BargeInTracker", () => {
  it("stays silent on quiet input", () => {
    const { tracker, advance } = trackerWithClock();
    advance(700);
    for (let i = 0; i < 40; i += 1) {
      expect(tracker.update(0.005)).toBe(false);
    }
  });

  it("ignores a short moderate spike (single-window energy)", () => {
    const { tracker, advance } = trackerWithClock();
    advance(700);
    // A distant cough decays below the gate within two smoothed windows.
    expect(tracker.update(0.12)).toBe(false);
    for (let i = 0; i < 6; i += 1) {
      expect(tracker.update(0.004)).toBe(false);
    }
  });

  it("fires once after sustained energy and never again", () => {
    const { tracker, advance } = trackerWithClock();
    advance(700);
    expect(tracker.update(0.3)).toBe(false);
    expect(tracker.update(0.3)).toBe(false);
    expect(tracker.update(0.3)).toBe(true);
    for (let i = 0; i < 10; i += 1) {
      expect(tracker.update(0.3)).toBe(false);
    }
  });

  it("suppresses detection during the post-arm cooldown (residual echo)", () => {
    const { tracker } = trackerWithClock();
    // 600ms cooldown: loud energy inside the window must not fire.
    expect(tracker.update(0.4)).toBe(false);
    expect(tracker.update(0.4)).toBe(false);
    expect(tracker.update(0.4)).toBe(false);
  });

  it("adapts the threshold above a loud noise floor", () => {
    const { tracker, advance } = trackerWithClock();
    advance(700);
    // Sustained ambient noise at 0.04: under the fixed 0.05 threshold, never fires.
    for (let i = 0; i < 60; i += 1) {
      expect(tracker.update(0.04)).toBe(false);
    }
    // Speech well above the adaptive floor (0.04 * 2.2 = 0.088) fires.
    expect(tracker.update(0.3)).toBe(false);
    expect(tracker.update(0.3)).toBe(false);
    expect(tracker.update(0.3)).toBe(true);
  });

  it("reset re-arms the tracker for a new utterance", () => {
    const { tracker, advance } = trackerWithClock();
    advance(700);
    for (let i = 0; i < 3; i += 1) tracker.update(0.3);
    expect(tracker.update(0.3)).toBe(false);
    tracker.reset();
    advance(700);
    expect(tracker.update(0.3)).toBe(false);
    expect(tracker.update(0.3)).toBe(false);
    expect(tracker.update(0.3)).toBe(true);
  });
});

describe("startBargeInDetection", () => {
  it("stops sampling and releases the stream on stop", async () => {
    vi.useFakeTimers();
    try {
      const track = { stop: vi.fn() };
      const deps: BargeInDetectorDeps = {
        getUserMedia: vi.fn(
          async () => ({ getTracks: () => [track] }) as never,
        ),
        createAnalyser: () => ({ analyser: {} as AnalyserNode, sample: () => 0 }),
      };
      const onBargeIn = vi.fn();
      const handle = await startBargeInDetection({ deps, onBargeIn });
      handle.stop();
      expect(track.stop).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1000);
      expect(onBargeIn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
