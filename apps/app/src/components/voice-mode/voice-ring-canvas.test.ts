// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  VoiceRingAnimator,
  type VoiceRingLevelSource,
} from "./voice-ring-canvas";

function fakeCanvas() {
  const ops: string[] = [];
  const ctx = {
    lineWidth: 0,
    globalAlpha: 1,
    clearRect: (...args: number[]) => ops.push(`clear:${args.join(",")}`),
    beginPath: () => ops.push("begin"),
    arc: (...args: number[]) => ops.push(`arc:${args.slice(0, 3).join(",")}`),
    moveTo: () => ops.push("move"),
    lineTo: () => ops.push("line"),
    closePath: () => ops.push("close"),
    stroke: () => ops.push("stroke"),
  };
  const canvas = {
    width: 400,
    height: 400,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
  return { canvas, ops };
}

// Test seam: draw() is private; frame access from tests is a deliberate,
// in-process drive with a fake canvas, not external input.
const drawFrame = (animator: VoiceRingAnimator): void => {
  (animator as unknown as { draw(): void }).draw();
};

describe("VoiceRingAnimator", () => {
  it("listening draws an amplitude-deformed waveform ring from the level source", () => {
    const { canvas, ops } = fakeCanvas();
    const level: VoiceRingLevelSource = { level: 0 };
    const animator = new VoiceRingAnimator(canvas, { reducedMotion: false });
    animator.attachLevelSource(level);
    animator.setState("listening");

    for (let i = 0; i < 12; i += 1) {
      level.level = 0.9;
      drawFrame(animator);
    }
    const loudLines = ops.filter((op) => op === "line").length;
    expect(loudLines).toBeGreaterThan(90);

    ops.length = 0;
    for (let i = 0; i < 12; i += 1) {
      level.level = 0;
      drawFrame(animator);
    }
    const quietLines = ops.filter((op) => op === "line").length;
    expect(quietLines).toBe(loudLines);
  });

  it("spawns extra propagation rings on rising energy and fades them", () => {
    const { canvas, ops } = fakeCanvas();
    const level: VoiceRingLevelSource = { level: 0 };
    const animator = new VoiceRingAnimator(canvas, { reducedMotion: false });
    animator.attachLevelSource(level);
    animator.setState("speaking");

    ops.length = 0;
    for (let i = 0; i < 30; i += 1) {
      level.level = 0.9;
      drawFrame(animator);
    }
    const energeticArcs = ops.filter((op) => op.startsWith("arc:")).length;

    ops.length = 0;
    for (let i = 0; i < 30; i += 1) {
      level.level = 0;
      drawFrame(animator);
    }
    const settledArcs = ops.filter((op) => op.startsWith("arc:")).length;

    // Energetic frames carry propagation rings on top of the waveform/core;
    // after the fade only the waveform ring and core remain.
    expect(energeticArcs).toBeGreaterThan(settledArcs + 20);
    expect(settledArcs).toBeLessThanOrEqual(60);
  });

  it("reduced motion renders a static ring regardless of level", () => {
    const { canvas, ops } = fakeCanvas();
    const level: VoiceRingLevelSource = { level: 1 };
    const animator = new VoiceRingAnimator(canvas, { reducedMotion: true });
    animator.attachLevelSource(level);
    animator.setState("listening");

    for (let i = 0; i < 6; i += 1) {
      level.level = 1;
      drawFrame(animator);
    }
    const withLevel = ops.filter((op) => op === "stroke").length;
    ops.length = 0;
    for (let i = 0; i < 6; i += 1) {
      level.level = 0;
      drawFrame(animator);
    }
    const quiet = ops.filter((op) => op === "stroke").length;
    expect(withLevel).toBe(quiet);
    expect(withLevel).toBe(6);
  });

  it("thinking uses procedural segments (no amplitude lines)", () => {
    const { canvas, ops } = fakeCanvas();
    const level: VoiceRingLevelSource = { level: 0.8 };
    const animator = new VoiceRingAnimator(canvas, { reducedMotion: false });
    animator.attachLevelSource(level);
    animator.setState("thinking");

    for (let i = 0; i < 4; i += 1) {
      drawFrame(animator);
    }
    expect(ops.filter((op) => op === "line").length).toBe(0);
    expect(ops.filter((op) => op.startsWith("arc:")).length).toBeGreaterThan(0);
  });

  it("start/stop control the frame loop", () => {
    vi.useFakeTimers();
    try {
      const rafCallbacks: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
        rafCallbacks.push(cb);
        return rafCallbacks.length;
      });
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      const { canvas } = fakeCanvas();
      const animator = new VoiceRingAnimator(canvas, { reducedMotion: false });
      animator.start();
      animator.start();
      expect(rafCallbacks.length).toBe(1);
      animator.stop();
      animator.stop();
      expect(vi.mocked(cancelAnimationFrame)).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
