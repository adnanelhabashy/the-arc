import { describe, expect, it } from "vitest";
import {
  AUTOMATION_VOICE_ANNOUNCE_CHANNEL,
  readAutomationVoiceAnnounce,
} from "./automation-voice";

const ANNOUNCE = {
  text: "Build finished with two failures.",
  threadId: "thr_1",
  automationId: "auto_1",
  providerId: "codex",
};

describe("automation voice announce wire contract", () => {
  it("pins the channel the arc-core plugin publishes on", () => {
    expect(AUTOMATION_VOICE_ANNOUNCE_CHANNEL).toBe("arc-voice-announce");
  });

  it("accepts the published payload shape", () => {
    expect(readAutomationVoiceAnnounce(ANNOUNCE)).toEqual(ANNOUNCE);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty text", { ...ANNOUNCE, text: "" }],
    ["oversized text", { ...ANNOUNCE, text: "x".repeat(1201) }],
    ["missing threadId", { text: "hi", automationId: "a", providerId: "p" }],
    ["missing providerId", { text: "hi", threadId: "t", automationId: "a" }],
    ["non-string automationId", { ...ANNOUNCE, automationId: 7 }],
  ])("rejects %s", (_name, value) => {
    expect(readAutomationVoiceAnnounce(value)).toBeNull();
  });
});
