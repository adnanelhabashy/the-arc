import { describe, expect, it } from "vitest";
import { isPathologicalRepetition } from "./voice-transcript-guard";

describe("isPathologicalRepetition", () => {
  it("does not flag empty or silence-ish transcripts", () => {
    expect(isPathologicalRepetition("")).toBe(false);
    expect(isPathologicalRepetition("   ")).toBe(false);
    expect(isPathologicalRepetition("...")).toBe(false);
  });

  it("flags a repeated hallucinated laughter phrase", () => {
    expect(
      isPathologicalRepetition(
        "Hahahaha Hahahaha Hahahaha Hahahaha",
      ),
    ).toBe(true);
  });

  it("flags a short phrase repeated many times", () => {
    expect(
      isPathologicalRepetition(
        "thank you thank you thank you thank you thank you thank you",
      ),
    ).toBe(true);
  });

  it("flags a longer phrase repeated end to end", () => {
    expect(
      isPathologicalRepetition(
        "as you see on screen. as you see on screen. as you see on screen. as you see on screen.",
      ),
    ).toBe(true);
  });

  it("lets a genuine short laughter pass", () => {
    expect(isPathologicalRepetition("haha")).toBe(false);
  });

  it("lets a doubled short laughter pass", () => {
    expect(isPathologicalRepetition("haha haha")).toBe(false);
  });

  it("lets ordinary English prose pass", () => {
    expect(
      isPathologicalRepetition(
        "The quick brown fox jumps over the lazy dog and then it keeps running through the forest.",
      ),
    ).toBe(false);
  });

  it("lets mixed Arabic and English text pass", () => {
    expect(
      isPathologicalRepetition("مرحبا hello world هذا اختبار بسيط للنطق"),
    ).toBe(false);
  });

  it("lets technical terms with ordinary repeats pass", () => {
    expect(
      isPathologicalRepetition(
        "the server returns server errors when the server restarts",
      ),
    ).toBe(false);
  });

  it("lets a short dictation under the word guard pass", () => {
    expect(isPathologicalRepetition("please send the message now")).toBe(
      false,
    );
  });
});
