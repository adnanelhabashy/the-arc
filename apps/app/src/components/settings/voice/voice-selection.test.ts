import { describe, expect, it } from "vitest";
import type { SystemVoiceEngineCapabilities } from "@bb/server-contract";
import {
  DEFAULT_TTS_SETTINGS,
  clampPlaybackSpeed,
  isKnownTtsEngine,
  isPresetSelected,
  isProfileSelected,
  reduceTtsSelection,
  resolveTtsAfterProfileDelete,
  type VoiceTtsSettings,
} from "./voice-selection";

function engineCaps(
  engine: string,
  presets: { voiceId: string; name: string; gender: string; language: string }[] | null,
): SystemVoiceEngineCapabilities {
  return {
    engine,
    requiresClonedProfile: presets === null,
    presets,
    models: [],
  };
}

const KOKORO = engineCaps("kokoro", [
  { voiceId: "af_heart", name: "Heart", gender: "female", language: "en" },
  { voiceId: "am_adam", name: "Adam", gender: "male", language: "en" },
]);
const QWEN_CUSTOM = engineCaps("qwen_custom_voice", [
  { voiceId: "Vivian", name: "Vivian", gender: "female", language: "zh" },
]);
const QWEN = engineCaps("qwen", null);

describe("reduceTtsSelection", () => {
  it("switches engine to a preset engine and selects its first preset", () => {
    const next = reduceTtsSelection(DEFAULT_TTS_SETTINGS, {
      type: "engine",
      engine: "qwen_custom_voice",
      caps: QWEN_CUSTOM,
    });
    expect(next).toEqual({
      ...DEFAULT_TTS_SETTINGS,
      engine: "qwen_custom_voice",
      voiceKind: "preset",
      presetEngine: "qwen_custom_voice",
      presetVoiceId: "Vivian",
      profileId: null,
    });
  });

  it("switching to an engine without presets resets to a profile selection", () => {
    const next = reduceTtsSelection(DEFAULT_TTS_SETTINGS, {
      type: "engine",
      engine: "qwen",
      caps: QWEN,
    });
    expect(next.engine).toBe("qwen");
    expect(next.voiceKind).toBe("profile");
    expect(next.profileId).toBeNull();
  });

  it("does not mutate when selecting the current engine", () => {
    const next = reduceTtsSelection(DEFAULT_TTS_SETTINGS, {
      type: "engine",
      engine: "kokoro",
      caps: KOKORO,
    });
    expect(next).toBe(DEFAULT_TTS_SETTINGS);
  });

  it("selecting a preset drops any profile selection", () => {
    const withProfile: VoiceTtsSettings = {
      ...DEFAULT_TTS_SETTINGS,
      engine: "qwen_custom_voice",
      voiceKind: "profile",
      profileId: "p1",
    };
    const next = reduceTtsSelection(withProfile, {
      type: "preset",
      engine: "kokoro",
      presetVoiceId: "am_adam",
    });
    expect(next).toEqual({
      ...withProfile,
      engine: "kokoro",
      voiceKind: "preset",
      presetEngine: "kokoro",
      presetVoiceId: "am_adam",
      profileId: null,
    });
  });

  it("selecting a profile always uses the clone engine", () => {
    const next = reduceTtsSelection(DEFAULT_TTS_SETTINGS, {
      type: "profile",
      profileId: "p2",
    });
    expect(next.engine).toBe("qwen");
    expect(next.voiceKind).toBe("profile");
    expect(next.profileId).toBe("p2");
  });
});

describe("clampPlaybackSpeed", () => {
  it("clamps to the 0.5–2.0 range", () => {
    expect(clampPlaybackSpeed(0.2)).toBe(0.5);
    expect(clampPlaybackSpeed(3)).toBe(2);
    expect(clampPlaybackSpeed(1.25)).toBe(1.25);
    expect(clampPlaybackSpeed(Number.NaN)).toBe(1);
  });
});

describe("selection predicates", () => {
  it("reflects the persisted preset selection", () => {
    expect(isPresetSelected(DEFAULT_TTS_SETTINGS, "kokoro", "af_heart")).toBe(
      true,
    );
    expect(isPresetSelected(DEFAULT_TTS_SETTINGS, "kokoro", "am_adam")).toBe(
      false,
    );
    expect(
      isPresetSelected(DEFAULT_TTS_SETTINGS, "qwen_custom_voice", "af_heart"),
    ).toBe(false);
  });

  it("reflects the persisted profile selection", () => {
    const tts: VoiceTtsSettings = {
      ...DEFAULT_TTS_SETTINGS,
      voiceKind: "profile",
      profileId: "p3",
    };
    expect(isProfileSelected(tts, "p3")).toBe(true);
    expect(isProfileSelected(tts, "p4")).toBe(false);
  });
});

describe("resolveTtsAfterProfileDelete", () => {
  it("resets to the Kokoro default only when the deleted profile was selected", () => {
    const withProfile: VoiceTtsSettings = {
      ...DEFAULT_TTS_SETTINGS,
      engine: "qwen_custom_voice",
      voiceKind: "profile",
      profileId: "p1",
      playbackSpeed: 1.5,
    };
    const reset = resolveTtsAfterProfileDelete(withProfile, "p1");
    expect(reset).toEqual({
      engine: "kokoro",
      voiceKind: "preset",
      presetEngine: "kokoro",
      presetVoiceId: "af_heart",
      profileId: null,
      playbackSpeed: 1.5,
    });

    expect(resolveTtsAfterProfileDelete(withProfile, "other")).toBe(withProfile);
  });
});

describe("isKnownTtsEngine", () => {
  it("accepts the verified engine set and rejects unverified engines", () => {
    expect(isKnownTtsEngine("kokoro")).toBe(true);
    expect(isKnownTtsEngine("qwen_custom_voice")).toBe(true);
    expect(isKnownTtsEngine("chatterbox")).toBe(false);
  });
});
