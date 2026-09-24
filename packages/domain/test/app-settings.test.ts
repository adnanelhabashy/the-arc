import { describe, expect, it } from "vitest";
import {
  appSettingsSchema,
  defaultAppSettings,
  managedBranchPrefixSchema,
  MANAGED_BRANCH_PREFIX_MAX_LENGTH,
} from "../src/app-settings.js";

describe("managedBranchPrefixSchema", () => {
  it("accepts prefixes that start a valid branch name", () => {
    for (const prefix of ["bb/", "", "sawyer/wt-", "team/bb/", "wip_"]) {
      expect(managedBranchPrefixSchema.safeParse(prefix).success).toBe(true);
    }
  });

  it("rejects prefixes that cannot start a valid branch name", () => {
    for (const prefix of [
      " bb/",
      "bb //",
      "-bb/",
      "/bb/",
      "bb//",
      "bb../",
      "bb:",
      "bb~",
      "bb\\",
      "bb@{",
      ".bb/",
      "a".repeat(MANAGED_BRANCH_PREFIX_MAX_LENGTH + 1),
    ]) {
      expect(managedBranchPrefixSchema.safeParse(prefix).success).toBe(false);
    }
  });

  it("defaults to the bb namespace", () => {
    expect(defaultAppSettings.managedBranchPrefix).toBe("bb/");
    expect(appSettingsSchema.parse(defaultAppSettings)).toEqual(
      defaultAppSettings,
    );
  });
});

describe("voiceSettingsSchema", () => {
  it("defaults to whisper-base STT and the kokoro af_heart preset", () => {
    expect(defaultAppSettings.voice).toEqual({
      enabled: true,
      stt: { model: "whisper-base", language: "auto" },
      tts: {
        engine: "kokoro",
        voiceKind: "preset",
        presetEngine: "kokoro",
        presetVoiceId: "af_heart",
        profileId: null,
        playbackSpeed: 1,
      },
      agentVoices: { codex: null, "claude-code": null, omp: null },
      input: { reduceBackgroundNoise: true },
      behavior: {
        showMicrophone: true,
        autoSpeakReplies: false,
        keepWarm: false,
        releaseModelsAfterUse: true,
      },
    });
    expect(appSettingsSchema.parse(defaultAppSettings)).toEqual(
      defaultAppSettings,
    );
  });

  it("fills V5 fields when parsing a pre-V5 voice blob", () => {
    const preV5Voice = {
      stt: { model: "whisper-base", language: "auto" },
      tts: {
        engine: "kokoro",
        voiceKind: "preset",
        presetEngine: "kokoro",
        presetVoiceId: "af_heart",
        profileId: null,
        playbackSpeed: 1,
      },
      input: { reduceBackgroundNoise: true },
      behavior: { showMicrophone: true, autoSpeakReplies: false, keepWarm: false },
    };
    const parsed = appSettingsSchema.parse({
      ...defaultAppSettings,
      voice: preV5Voice,
    });
    expect(parsed.voice.enabled).toBe(true);
    expect(parsed.voice.agentVoices).toEqual({
      codex: null,
      "claude-code": null,
      omp: null,
    });
    expect(parsed.voice.behavior.releaseModelsAfterUse).toBe(true);
  });

  it("round-trips per-agent voice selections", () => {
    const parsed = appSettingsSchema.parse({
      ...defaultAppSettings,
      voice: {
        ...defaultAppSettings.voice,
        enabled: false,
        agentVoices: {
          codex: {
            engine: "kokoro",
            voiceKind: "preset",
            presetEngine: "kokoro",
            presetVoiceId: "am_adam",
            profileId: null,
          },
          "claude-code": {
            engine: "qwen",
            voiceKind: "profile",
            presetEngine: "qwen",
            presetVoiceId: null,
            profileId: "p-1",
          },
          omp: null,
        },
      },
    });
    expect(parsed.voice.enabled).toBe(false);
    expect(parsed.voice.agentVoices.codex?.presetVoiceId).toBe("am_adam");
    expect(parsed.voice.agentVoices["claude-code"]?.profileId).toBe("p-1");
  });

  it("rejects agent voice entries for unknown agents or engines", () => {
    const base = defaultAppSettings.voice;
    expect(
      appSettingsSchema.safeParse({
        ...defaultAppSettings,
        voice: {
          ...base,
          agentVoices: {
            codex: null,
            "claude-code": null,
            omp: null,
            gemini: null,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      appSettingsSchema.safeParse({
        ...defaultAppSettings,
        voice: {
          ...base,
          agentVoices: {
            ...base.agentVoices,
            codex: {
              engine: "luxtts",
              voiceKind: "preset",
              presetEngine: "luxtts",
              presetVoiceId: "x",
              profileId: null,
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown engines, models, and extra fields", () => {
    const base = defaultAppSettings.voice;
    expect(
      appSettingsSchema.safeParse({
        ...defaultAppSettings,
        voice: { ...base, tts: { ...base.tts, engine: "luxtts" } },
      }).success,
    ).toBe(false);
    expect(
      appSettingsSchema.safeParse({
        ...defaultAppSettings,
        voice: { ...base, stt: { ...base.stt, model: "whisper-huge" } },
      }).success,
    ).toBe(false);
    expect(
      appSettingsSchema.safeParse({
        ...defaultAppSettings,
        voice: { ...base, vadThreshold: 0.5 },
      }).success,
    ).toBe(false);
  });

  it("accepts a cloned-profile qwen selection and clamps nothing silently", () => {
    const parsed = appSettingsSchema.parse({
      ...defaultAppSettings,
      voice: {
        ...defaultAppSettings.voice,
        tts: {
          engine: "qwen",
          voiceKind: "profile",
          presetEngine: "kokoro",
          presetVoiceId: "af_heart",
          profileId: "9f1c2d",
          playbackSpeed: 1.5,
        },
      },
    });
    expect(parsed.voice.tts.profileId).toBe("9f1c2d");
    expect(parsed.voice.tts.playbackSpeed).toBe(1.5);
  });
});
