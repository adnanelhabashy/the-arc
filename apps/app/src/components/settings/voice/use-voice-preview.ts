import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { speakVoiceText } from "@/lib/api";

export const VOICE_PREVIEW_PHRASE =
  "This is how I will sound when I read Arc's replies.";

export type VoicePreviewPhase = "idle" | "loading" | "playing";

export interface VoicePreviewRequest {
  key: string;
  text: string;
  engine?: string;
  profile?: string;
  presetVoiceId?: string;
  language?: string;
}

interface VoicePreviewSnapshot {
  phase: VoicePreviewPhase;
  activeKey: string | null;
  playbackSpeed: number;
}

let audio: HTMLAudioElement | null = null;
let abortController: AbortController | null = null;
let objectUrl: string | null = null;
let activeKey: string | null = null;
let phase: VoicePreviewPhase = "idle";
let playbackSpeed = 1;
let snapshot: VoicePreviewSnapshot = {
  phase: "idle",
  activeKey: null,
  playbackSpeed: 1,
};
const listeners = new Set<() => void>();

function emit(): void {
  snapshot = { phase, activeKey, playbackSpeed };
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): VoicePreviewSnapshot {
  return snapshot;
}

function ensureAudio(): HTMLAudioElement {
  if (audio === null) {
    audio = new Audio();
    audio.preservesPitch = true;
  }
  return audio;
}

function revokeCurrentUrl(): void {
  if (objectUrl !== null) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
}

function settle(): void {
  if (abortController !== null) {
    abortController.abort();
    abortController = null;
  }
  if (audio !== null) {
    audio.pause();
    audio.onended = null;
    audio.onerror = null;
    audio.removeAttribute("src");
    audio.load();
  }
  revokeCurrentUrl();
  activeKey = null;
  phase = "idle";
  emit();
}

export function stopVoicePreview(): void {
  settle();
}

export function startVoicePreview(
  request: VoicePreviewRequest,
  speed: number,
): void {
  settle();

  activeKey = request.key;
  playbackSpeed = speed;
  phase = "loading";
  emit();

  const controller = new AbortController();
  abortController = controller;
  const el = ensureAudio();
  el.playbackRate = speed;

  void speakVoiceText(request.text, {
    signal: controller.signal,
    engine: request.engine,
    profile: request.profile ?? undefined,
    voiceId: request.presetVoiceId ?? undefined,
    language: request.language,
  })
    .then((blob) => {
      if (abortController !== controller || controller.signal.aborted) {
        return;
      }
      const url = URL.createObjectURL(blob);
      objectUrl = url;
      el.onended = () => {
        if (abortController === controller && objectUrl === url) {
          settle();
        }
      };
      el.onerror = () => {
        if (abortController === controller) {
          settle();
        }
      };
      el.src = url;
      return el.play().then(() => {
        if (abortController !== controller || controller.signal.aborted) {
          return;
        }
        phase = "playing";
        emit();
      });
    })
    .catch(() => {
      if (abortController !== controller) {
        return;
      }
      settle();
    });
}

export interface VoicePreviewApi {
  phase: VoicePreviewPhase;
  activeKey: string | null;
  start: (request: VoicePreviewRequest, speed: number) => void;
  stop: () => void;
}

export function useVoicePreview(): VoicePreviewApi {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const voiceEnabled =
    useSystemConfig().data?.generalSettings?.voice?.enabled ?? true;
  const start = useCallback(
    (request: VoicePreviewRequest, speed: number) => {
      if (!voiceEnabled) {
        return;
      }
      startVoicePreview(request, speed);
    },
    [voiceEnabled],
  );
  const stop = useCallback(() => {
    stopVoicePreview();
  }, []);
  useEffect(() => {
    if (!voiceEnabled && state.phase !== "idle") {
      stopVoicePreview();
    }
  }, [voiceEnabled, state.phase]);
  return { phase: state.phase, activeKey: state.activeKey, start, stop };
}
