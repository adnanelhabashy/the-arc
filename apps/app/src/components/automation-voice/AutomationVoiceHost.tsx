import { useCallback, useEffect, useRef } from "react";
import { speakVoiceText } from "@/lib/api";
import { wsManager } from "@/lib/ws";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import {
  registerSpeechPlaybackOwner,
  releaseSpeechPlayback,
  requestSpeechPlayback,
} from "@/lib/speech-playback-coordinator";
import { providerIdToAgentId } from "@/components/thread/timeline/ProviderUsageSection";
import type { MessageSpeechAgentId } from "@/components/thread/timeline/message-speech";
import {
  AUTOMATION_VOICE_ANNOUNCE_CHANNEL,
  readAutomationVoiceAnnounce,
} from "./automation-voice";

interface QueuedAnnouncement {
  text: string;
  agentId: MessageSpeechAgentId | null;
  abortController: AbortController;
}

export function AutomationVoiceHost() {
  const queueRef = useRef<QueuedAnnouncement[]>([]);
  const drainingRef = useRef(false);
  const currentAbortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const voiceEnabledRef = useRef(true);

  const voiceEnabled =
    useSystemConfig().data?.generalSettings?.voice?.enabled ?? true;

  const ensureAudio = useCallback((): HTMLAudioElement => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
    }
    return audioRef.current;
  }, []);

  const stopCurrent = useCallback(() => {
    currentAbortRef.current?.abort();
    currentAbortRef.current = null;
    for (const queued of queueRef.current) {
      queued.abortController.abort();
    }
    queueRef.current = [];
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.onended = null;
      audio.onerror = null;
      audio.removeAttribute("src");
      audio.load();
    }
  }, []);

  const playBlob = useCallback(
    (blob: Blob, signal: AbortSignal): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const audio = ensureAudio();
        const url = URL.createObjectURL(blob);
        const cleanup = () => {
          audio.onended = null;
          audio.onerror = null;
          signal.removeEventListener("abort", onAbort);
          URL.revokeObjectURL(url);
        };
        const onAbort = () => {
          cleanup();
          resolve();
        };
        audio.onended = () => {
          cleanup();
          resolve();
        };
        audio.onerror = () => {
          cleanup();
          reject(new Error("Automation voice playback failed"));
        };
        signal.addEventListener("abort", onAbort);
        audio.src = url;
        audio.play().catch((error: unknown) => {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      }),
    [ensureAudio],
  );

  const drain = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      for (;;) {
        const next = queueRef.current.shift();
        if (next === undefined) return;
        if (next.abortController.signal.aborted) return;
        requestSpeechPlayback("automation-voice");
        currentAbortRef.current = next.abortController;
        try {
          const blob = await speakVoiceText(next.text, {
            signal: next.abortController.signal,
            agentId: next.agentId ?? undefined,
          });
          if (next.abortController.signal.aborted) return;
          await playBlob(blob, next.abortController.signal);
        } catch {
          // Automation alerts are ambient: a failed speak or a stopped
          // playback is dropped, never toasted.
        } finally {
          currentAbortRef.current = null;
        }
        if (next.abortController.signal.aborted) return;
      }
    } finally {
      drainingRef.current = false;
      releaseSpeechPlayback("automation-voice");
    }
  }, [playBlob]);

  useEffect(
    () => registerSpeechPlaybackOwner("automation-voice", stopCurrent),
    [stopCurrent],
  );

  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
    if (voiceEnabled) return;
    stopCurrent();
  }, [voiceEnabled, stopCurrent]);

  useEffect(() => {
    const unsubscribe = wsManager.onPluginSignal((signal) => {
      if (signal.channel !== AUTOMATION_VOICE_ANNOUNCE_CHANNEL) return;
      const announce = readAutomationVoiceAnnounce(signal.payload);
      if (announce === null || !voiceEnabledRef.current) return;
      queueRef.current.push({
        text: announce.text,
        agentId: providerIdToAgentId(announce.providerId),
        abortController: new AbortController(),
      });
      void drain();
    });
    return () => {
      unsubscribe();
      stopCurrent();
    };
  }, [drain, stopCurrent]);

  return null;
}
