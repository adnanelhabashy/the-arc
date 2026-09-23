import { describe, expect, it } from "vitest";
import {
  ArcVoiceLoopbackViolationError,
  assertArcVoicePort,
  assertLoopbackHost,
  assertLoopbackUrl,
  buildArcVoiceBaseUrl,
  isLoopbackHost,
} from "../src/binding.js";

describe("voice runtime loopback binding", () => {
  it("accepts only literal loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(false);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.20")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
  });

  it("refuses to bind a non-loopback host", () => {
    expect(() => assertLoopbackHost("0.0.0.0")).toThrow(
      ArcVoiceLoopbackViolationError,
    );
    expect(assertLoopbackHost("127.0.0.1")).toBe("127.0.0.1");
  });

  it("builds loopback base urls and rejects LAN urls", () => {
    expect(buildArcVoiceBaseUrl({ host: "127.0.0.1", port: 8787 })).toBe(
      "http://127.0.0.1:8787",
    );
    expect(buildArcVoiceBaseUrl({ host: "::1", port: 8787 })).toBe(
      "http://[::1]:8787",
    );
    expect(() => buildArcVoiceBaseUrl({ host: "0.0.0.0", port: 8787 })).toThrow(
      ArcVoiceLoopbackViolationError,
    );
    expect(() =>
      buildArcVoiceBaseUrl({ host: "127.0.0.1", port: 70_000 }),
    ).toThrow(RangeError);

    expect(assertLoopbackUrl("http://127.0.0.1:8787")).toBe(
      "http://127.0.0.1:8787",
    );
    expect(() => assertLoopbackUrl("http://10.0.0.5:8787")).toThrow(
      ArcVoiceLoopbackViolationError,
    );
    expect(() => assertLoopbackUrl("not a url")).toThrow(
      ArcVoiceLoopbackViolationError,
    );
  });

  it("validates the port range", () => {
    expect(assertArcVoicePort(1)).toBe(1);
    expect(assertArcVoicePort(65535)).toBe(65535);
    expect(() => assertArcVoicePort(0)).toThrow(RangeError);
    expect(() => assertArcVoicePort(1.5)).toThrow(RangeError);
  });
});
