import { describe, expect, it, vi } from "vitest";
import {
  waitForArcVoiceReady,
  type ArcVoiceHealthResult,
} from "../src/health.js";

function fakeClock(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  elapsed: () => number;
} {
  let clock = 0;
  return {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    elapsed: () => clock,
  };
}

describe("waitForArcVoiceReady", () => {
  it("resolves as soon as the injected health check reports healthy", async () => {
    const clock = fakeClock();
    const check = vi
      .fn<() => Promise<ArcVoiceHealthResult>>()
      .mockResolvedValue({
        kind: "healthy",
        detail: "/health returned HTTP 200",
      });

    const result = await waitForArcVoiceReady({
      check,
      timeoutMs: 5_000,
      intervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result).toEqual({
      kind: "ready",
      detail: "/health returned HTTP 200",
    });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("keeps polling until a later check succeeds", async () => {
    const clock = fakeClock();
    const check = vi
      .fn<() => Promise<ArcVoiceHealthResult>>()
      .mockResolvedValueOnce({
        kind: "unhealthy",
        detail: "connection refused",
      })
      .mockResolvedValueOnce({
        kind: "unhealthy",
        detail: "connection refused",
      })
      .mockResolvedValue({ kind: "healthy", detail: "ready" });

    const result = await waitForArcVoiceReady({
      check,
      timeoutMs: 5_000,
      intervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.kind).toBe("ready");
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("times out and reports the last observed detail", async () => {
    const clock = fakeClock();
    const check = vi
      .fn<() => Promise<ArcVoiceHealthResult>>()
      .mockResolvedValue({ kind: "unhealthy", detail: "still starting" });

    const result = await waitForArcVoiceReady({
      check,
      timeoutMs: 1_000,
      intervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result).toEqual({ kind: "timeout", detail: "still starting" });
    expect(clock.elapsed()).toBe(1_000);
  });

  it("treats a throwing health check as unhealthy instead of aborting", async () => {
    const clock = fakeClock();
    const check = vi
      .fn<() => Promise<ArcVoiceHealthResult>>()
      .mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await waitForArcVoiceReady({
      check,
      timeoutMs: 500,
      intervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result).toEqual({ kind: "timeout", detail: "ECONNREFUSED" });
  });

  it("performs at least one check even with a zero timeout", async () => {
    const clock = fakeClock();
    const check = vi
      .fn<() => Promise<ArcVoiceHealthResult>>()
      .mockResolvedValue({ kind: "unhealthy", detail: "nope" });

    const result = await waitForArcVoiceReady({
      check,
      timeoutMs: 0,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.kind).toBe("timeout");
    expect(check).toHaveBeenCalledTimes(1);
  });
});
