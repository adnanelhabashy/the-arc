import type {
  SystemVoiceCapabilitiesResponse,
  SystemVoiceEngineCapabilities,
  SystemVoiceModelState,
} from "@bb/server-contract";

export function engineHasDownloadedModel(
  caps: SystemVoiceEngineCapabilities,
): boolean {
  return caps.models.some((model) => model.downloaded);
}

export function resolveEngineDownloadModel(
  caps: SystemVoiceEngineCapabilities,
): SystemVoiceModelState | null {
  return (
    caps.models.find((model) => model.downloading) ??
    caps.models.find((model) => !model.downloaded) ??
    null
  );
}

export function findSpeechModel(
  caps: SystemVoiceCapabilitiesResponse | undefined,
  name: string,
): SystemVoiceModelState | undefined {
  return caps?.speechModels.find((model) => model.name === name);
}

export const CLONED_VOICE_ENGINE = "qwen";
export const CLONED_VOICE_SPEAK_MODEL = "qwen-tts-1.7B";

export function findClonedVoiceEngineCaps(
  caps: SystemVoiceCapabilitiesResponse,
): SystemVoiceEngineCapabilities | undefined {
  return caps.engines.find((engine) => engine.engine === CLONED_VOICE_ENGINE);
}

export function resolveClonedVoiceModel(
  caps: SystemVoiceEngineCapabilities,
): SystemVoiceModelState | undefined {
  return caps.models.find((model) => model.name === CLONED_VOICE_SPEAK_MODEL);
}
