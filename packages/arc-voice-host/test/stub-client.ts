import type { ArcVoiceCallResult, ArcVoiceClient } from "../src/client.js";

const unused = <T>(): Promise<ArcVoiceCallResult<T>> =>
  Promise.resolve({ kind: "error", code: "unavailable", message: "unused" });

export function createStubArcVoiceClient(): ArcVoiceClient {
  return {
    listProfiles: () => unused(),
    listProfileDetails: () => unused(),
    createProfile: () => unused(),
    updateProfile: () => unused(),
    deleteProfile: () => unused(),
    addProfileSample: () => unused(),
    removeProfileSample: () => unused(),
    listPresets: () => unused(),
    listModels: () => unused(),
    downloadModel: () => unused(),
    cancelModelDownload: () => unused(),
    transcribe: () => unused(),
    speak: () => unused(),
    modelStatus: () => unused(),
    loadVoiceModel: () => unused(),
    unloadModels: () => unused(),
    voiceModelProgress: () => unused(),
  };
}
