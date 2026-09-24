import { describe, expect, it } from "vitest";
import { chunkSpeechText } from "./speech-chunks";

describe("chunkSpeechText", () => {
  it("returns an empty list for blank input", () => {
    expect(chunkSpeechText("")).toEqual([]);
    expect(chunkSpeechText("   \n\t  ")).toEqual([]);
  });

  it("keeps a single short sentence in one chunk", () => {
    expect(chunkSpeechText("Hello world.")).toEqual(["Hello world."]);
  });

  it("groups sentences that fit within the limit into one chunk", () => {
    expect(chunkSpeechText("One. Two. Three.", 100)).toEqual([
      "One.\nTwo.\nThree.",
    ]);
  });

  it("keeps a fenced block whole so the spoken-text filter can strip it", () => {
    const source = [
      "Here is the fix.",
      "",
      "```ts",
      "const answer = 42;",
      "```",
      "",
      "Please review it.",
    ].join("\n");
    const chunks = chunkSpeechText(source, 600);
    const containingFence = chunks.filter((chunk) =>
      chunk.includes("```ts\nconst answer = 42;\n```"),
    );
    expect(containingFence).toHaveLength(1);
    expect(chunks.join("\n")).toContain("Here is the fix.");
    expect(chunks.join("\n")).toContain("Please review it.");
  });

  it("splits at sentence boundaries when the limit is exceeded", () => {
    expect(
      chunkSpeechText("Short one. Short two. Short three.", 12),
    ).toEqual(["Short one.", "Short two.", "Short three."]);
  });

  it("splits an over-long sentence at word boundaries", () => {
    expect(chunkSpeechText("aa bb cc dd ee ff", 5)).toEqual([
      "aa bb",
      "cc dd",
      "ee ff",
    ]);
  });

  it("treats a newline as a sentence boundary", () => {
    expect(chunkSpeechText("First line\nSecond line", 11)).toEqual([
      "First line",
      "Second line",
    ]);
  });

  it("never drops content across chunk boundaries", () => {
    const source =
      "This is a longer passage. It contains several sentences. Some of them are short. Others stretch on a little more.";
    const chunks = chunkSpeechText(source, 40);
    expect(chunks.join(" ")).toBe(source);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(40);
    }
  });
});
