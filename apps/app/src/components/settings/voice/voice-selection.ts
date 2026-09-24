import { VOICE_TTS_ENGINES, type VoiceSettings } from "@bb/domain";
import type { SystemVoiceEngineCapabilities } from "@bb/server-contract";

export type VoiceTtsSettings = VoiceSettings["tts"];
export type VoiceTtsEngine = VoiceTtsSettings["engine"];

export function isKnownTtsEngine(engine: string): engine is VoiceTtsEngine {
  return (VOICE_TTS_ENGINES as readonly string[]).includes(engine);
}

export const DEFAULT_TTS_SETTINGS: VoiceTtsSettings = {
  engine: "kokoro",
  voiceKind: "preset",
  presetEngine: "kokoro",
  presetVoiceId: "af_heart",
  profileId: null,
  playbackSpeed: 1,
};

export const VOICE_PLAYBACK_SPEED_MIN = 0.5;
export const VOICE_PLAYBACK_SPEED_MAX = 2;

export type TtsSelectionAction =
  | {
      type: "engine";
      engine: VoiceTtsEngine;
      caps: SystemVoiceEngineCapabilities | undefined;
    }
  | { type: "preset"; engine: VoiceTtsEngine; presetVoiceId: string }
  | { type: "profile"; profileId: string }
  | { type: "speed"; playbackSpeed: number };

export function clampPlaybackSpeed(speed: number): number {
  if (!Number.isFinite(speed)) {
    return 1;
  }
  return Math.min(
    VOICE_PLAYBACK_SPEED_MAX,
    Math.max(VOICE_PLAYBACK_SPEED_MIN, speed),
  );
}

export function reduceTtsSelection(
  tts: VoiceTtsSettings,
  action: TtsSelectionAction,
): VoiceTtsSettings {
  switch (action.type) {
    case "engine": {
      if (action.engine === tts.engine) {
        return tts;
      }
      const firstPreset = action.caps?.presets?.[0]?.voiceId ?? null;
      if (firstPreset !== null) {
        return {
          ...tts,
          engine: action.engine,
          voiceKind: "preset",
          presetEngine: action.engine,
          presetVoiceId: firstPreset,
          profileId: null,
        };
      }
      return {
        ...tts,
        engine: action.engine,
        voiceKind: "profile",
        profileId: null,
      };
    }
    case "preset":
      return {
        ...tts,
        engine: action.engine,
        voiceKind: "preset",
        presetEngine: action.engine,
        presetVoiceId: action.presetVoiceId,
        profileId: null,
      };
    case "profile":
      return {
        ...tts,
        engine: "qwen",
        voiceKind: "profile",
        profileId: action.profileId,
      };
    case "speed":
      return { ...tts, playbackSpeed: clampPlaybackSpeed(action.playbackSpeed) };
  }
}

export function isPresetSelected(
  tts: VoiceTtsSettings,
  engine: string,
  presetVoiceId: string,
): boolean {
  return (
    tts.voiceKind === "preset" &&
    tts.engine === engine &&
    tts.presetVoiceId === presetVoiceId
  );
}

export function isProfileSelected(
  tts: VoiceTtsSettings,
  profileId: string,
): boolean {
  return tts.voiceKind === "profile" && tts.profileId === profileId;
}

export interface ResolvedSpeakVoice {
  engine: string;
  profile?: string;
  presetVoiceId?: string;
  profileId?: string;
}

export function resolveTtsSpeakVoice(
  tts: VoiceTtsSettings,
  profileName: string | null,
): ResolvedSpeakVoice {
  if (tts.voiceKind === "profile") {
    return {
      engine: tts.engine,
      profile: profileName ?? undefined,
      profileId: tts.profileId ?? undefined,
    };
  }
  return {
    engine: tts.engine,
    presetVoiceId: tts.presetVoiceId,
  };
}

export function resolveTtsAfterProfileDelete(
  tts: VoiceTtsSettings,
  deletedProfileId: string,
): VoiceTtsSettings {
  if (tts.profileId !== deletedProfileId) {
    return tts;
  }
  return {
    engine: "kokoro",
    voiceKind: "preset",
    presetEngine: "kokoro",
    presetVoiceId: "af_heart",
    profileId: null,
    playbackSpeed: tts.playbackSpeed,
  };
}
