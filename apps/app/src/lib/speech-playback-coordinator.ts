export type SpeechPlaybackOwner =
  | "message-speech"
  | "automation-voice"
  | "voice-preview"
  | "voice-mode";

type StopFn = () => void;

let currentOwner: SpeechPlaybackOwner | null = null;
const stopFnsByOwner = new Map<SpeechPlaybackOwner, Set<StopFn>>();

export function registerSpeechPlaybackOwner(
  owner: SpeechPlaybackOwner,
  stop: StopFn,
): () => void {
  let stops = stopFnsByOwner.get(owner);
  if (stops === undefined) {
    stops = new Set();
    stopFnsByOwner.set(owner, stops);
  }
  stops.add(stop);
  return () => {
    stops.delete(stop);
    if (stops.size === 0) {
      stopFnsByOwner.delete(owner);
    }
  };
}

export function requestSpeechPlayback(owner: SpeechPlaybackOwner): void {
  if (currentOwner !== null && currentOwner !== owner) {
    const stops = stopFnsByOwner.get(currentOwner);
    if (stops !== undefined) {
      for (const stop of [...stops]) {
        stop();
      }
    }
  }
  currentOwner = owner;
}

export function releaseSpeechPlayback(owner: SpeechPlaybackOwner): void {
  if (currentOwner === owner) {
    currentOwner = null;
  }
}
