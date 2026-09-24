import { z } from "zod";

export const VOICE_STT_MODELS = [
  "whisper-base",
  "whisper-small",
  "whisper-medium",
  "whisper-large",
  "whisper-turbo",
] as const;

export const VOICE_TTS_ENGINES = [
  "kokoro",
  "qwen",
  "qwen_custom_voice",
] as const;

export const VOICE_LANGUAGES = [
  "auto",
  "zh",
  "en",
  "ja",
  "ko",
  "de",
  "fr",
  "ru",
  "pt",
  "es",
  "it",
  "he",
  "ar",
  "da",
  "el",
  "fi",
  "hi",
  "ms",
  "nl",
  "no",
  "pl",
  "sv",
  "sw",
  "tr",
] as const;

export const VOICE_PLAYBACK_SPEED_MIN = 0.5;
export const VOICE_PLAYBACK_SPEED_MAX = 2;

export const VOICE_AGENT_KEYS = ["codex", "claude-code", "omp"] as const;
export type VoiceAgentKey = (typeof VOICE_AGENT_KEYS)[number];

export const voiceAgentSelectionSchema = z
  .object({
    engine: z.enum(VOICE_TTS_ENGINES),
    voiceKind: z.enum(["preset", "profile"]),
    presetEngine: z.string().min(1),
    presetVoiceId: z.string().min(1).nullable(),
    profileId: z.string().min(1).nullable(),
  })
  .strict();
export type VoiceAgentSelection = z.infer<typeof voiceAgentSelectionSchema>;

export const voiceAgentVoicesSchema = z
  .object({
    codex: voiceAgentSelectionSchema.nullable(),
    "claude-code": voiceAgentSelectionSchema.nullable(),
    omp: voiceAgentSelectionSchema.nullable(),
  })
  .strict();

export const DEFAULT_VOICE_AGENT_VOICES: VoiceAgentVoices = {
  codex: null,
  "claude-code": null,
  omp: null,
};

export type VoiceAgentVoices = z.infer<typeof voiceAgentVoicesSchema>;

export const voiceSettingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    stt: z
      .object({
        model: z.enum(VOICE_STT_MODELS),
        language: z.enum(VOICE_LANGUAGES),
      })
      .strict(),
    tts: z
      .object({
        engine: z.enum(VOICE_TTS_ENGINES),
        voiceKind: z.enum(["preset", "profile"]),
        presetEngine: z.string().min(1),
        presetVoiceId: z.string().min(1),
        profileId: z.string().min(1).nullable(),
        playbackSpeed: z
          .number()
          .min(VOICE_PLAYBACK_SPEED_MIN)
          .max(VOICE_PLAYBACK_SPEED_MAX),
      })
      .strict(),
    agentVoices: voiceAgentVoicesSchema.default(DEFAULT_VOICE_AGENT_VOICES),
    input: z
      .object({
        reduceBackgroundNoise: z.boolean(),
      })
      .strict(),
    behavior: z
      .object({
        showMicrophone: z.boolean(),
        autoSpeakReplies: z.boolean(),
        keepWarm: z.boolean(),
        releaseModelsAfterUse: z.boolean().default(true),
      })
      .strict(),
  })
  .strict();

export type VoiceSettings = z.infer<typeof voiceSettingsSchema>;

export const defaultVoiceSettings: VoiceSettings = {
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
  agentVoices: DEFAULT_VOICE_AGENT_VOICES,
  input: { reduceBackgroundNoise: true },
  behavior: {
    showMicrophone: true,
    autoSpeakReplies: false,
    keepWarm: false,
    releaseModelsAfterUse: true,
  },
};
