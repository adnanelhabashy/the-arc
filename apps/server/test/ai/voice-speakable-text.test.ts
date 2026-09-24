import { describe, expect, it } from "vitest";
import {
  deriveSpeakableText,
  MAX_SPEAK_TEXT_CHARS,
} from "../../src/services/ai/voice-speakable-text.js";

describe("deriveSpeakableText", () => {
  it("keeps plain prose", () => {
    expect(deriveSpeakableText("The build is green.")).toEqual({
      text: "The build is green.",
      truncated: false,
    });
  });

  it("strips fenced code blocks and keeps surrounding words", () => {
    const result = deriveSpeakableText(
      "Here is the fix.\n\n```ts\nconst x = 1;\n```\n\nPlease review it.",
    );
    expect(result.text).toBe("Here is the fix. Please review it.");
  });

  it("strips unified diffs", () => {
    const result = deriveSpeakableText(
      "I changed the file.\n\ndiff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n\nShip it.",
    );
    expect(result.text).toBe("I changed the file. Ship it.");
  });

  it("strips stack traces", () => {
    const result = deriveSpeakableText(
      "It failed.\n\nTraceback (most recent call last):\n  File \"/app/main.py\", line 3, in run\nValueError: nope\n\nWe are fixing it.",
    );
    expect(result.text).toBe("It failed. We are fixing it.");
  });

  it("strips raw JSON blobs", () => {
    const result = deriveSpeakableText(
      'The result was:\n\n{"ok": true, "count": 3}\n\nThanks.',
    );
    expect(result.text).toBe("The result was: Thanks.");
  });

  it("strips markdown syntax while keeping words", () => {
    const result = deriveSpeakableText(
      "## Summary\n\nThis is **bold** and a [link](https://example.com) and `inline`.",
    );
    expect(result.text).toBe("Summary This is bold and a link and inline.");
  });

  it("strips internal markers", () => {
    const result = deriveSpeakableText(
      "The answer is 42. <system>internal note</system> ANALYSIS: hidden [tool: lookup] Done.",
    );
    expect(result.text).toBe("The answer is 42. Done.");
  });

  it("returns empty for code-only input", () => {
    expect(deriveSpeakableText("```ts\nconst a = 1;\n```")).toEqual({
      text: "",
      truncated: false,
    });
  });

  it("truncates at the last sentence boundary", () => {
    const long = `${"This is a spoken sentence. ".repeat(60)}Second sentence here.`;
    const result = deriveSpeakableText(long);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(MAX_SPEAK_TEXT_CHARS);
    expect(result.text.endsWith(".")).toBe(true);
  });

  it("does not truncate short text", () => {
    const result = deriveSpeakableText("Short answer.");
    expect(result.truncated).toBe(false);
  });
});
