import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { extractErrorMessage } from "@bb/core-ui";
import { appToast } from "@/components/ui/app-toast";
import { HttpError, readVoiceStatus, speakVoiceText } from "@/lib/api";
import { chunkSpeechText } from "@/lib/speech-chunks";
import {
  registerSpeechPlaybackOwner,
  releaseSpeechPlayback,
  requestSpeechPlayback,
} from "@/lib/speech-playback-coordinator";
import { useVoiceEnabled } from "./voice-enabled";

export type MessageSpeechPhase =
  | "idle"
  | "preparing"
  | "generating"
  | "speaking";

const STATUS_POLL_INTERVAL_MS = 400;

export type MessageSpeechAgentId = "codex" | "claude-code" | "omp";

export interface MessageSpeechContextValue {
  state: MessageSpeechPhase;
  activeMessageId: string | null;
  speak: (
    messageId: string,
    text: string,
    agentId?: MessageSpeechAgentId,
  ) => void;
  stop: () => void;
}

interface SpeechSession {
  cancelled: boolean;
  abortController: AbortController;
  objectUrls: string[];
}

const MessageSpeechContext =
  createContext<MessageSpeechContextValue | null>(null);

const NO_OP_SPEECH: MessageSpeechContextValue = {
  state: "idle",
  activeMessageId: null,
  speak: () => {},
  stop: () => {},
};

function resolveSpeakErrorMessage(error: unknown): string {
  if (error instanceof HttpError) {
    switch (error.code) {
      case "voice_speak_unavailable":
        return "Voice is unavailable right now.";
      case "voice_speak_timeout":
        return "Speech generation timed out.";
      case "voice_speak_cancelled":
        return "Speech generation was cancelled.";
      case "voice_speak_failed":
        return "Speech generation failed.";
      case "invalid_request":
        return "This message cannot be spoken.";
      default:
        break;
    }
  }
  const message = extractErrorMessage(error);
  return message ?? "Something went wrong while speaking.";
}

export function MessageSpeechProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<MessageSpeechPhase>("idle");
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const sessionRef = useRef<SpeechSession | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const ensureAudio = useCallback((): HTMLAudioElement => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
    }
    return audioRef.current;
  }, []);

  const clearSession = useCallback(() => {
    const session = sessionRef.current;
    if (session) {
      session.cancelled = true;
      session.abortController.abort();
      for (const url of session.objectUrls) {
        URL.revokeObjectURL(url);
      }
      session.objectUrls = [];
      sessionRef.current = null;
    }
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.onended = null;
      audio.onerror = null;
      audio.removeAttribute("src");
      audio.load();
    }
    releaseSpeechPlayback("message-speech");
  }, []);

  const stop = useCallback(() => {
    clearSession();
    setState("idle");
    setActiveMessageId(null);
  }, [clearSession]);

  const runSpeechSession = useCallback(
    async (
      session: SpeechSession,
      chunks: string[],
      agentId?: MessageSpeechAgentId,
    ) => {
      const audio = ensureAudio();
      let pollTimer: number | null = null;

      const isCurrent = () =>
        !session.cancelled && sessionRef.current === session;

      const setPhase = (phase: MessageSpeechPhase) => {
        if (isCurrent()) {
          setState(phase);
        }
      };

      const stopPolling = () => {
        if (pollTimer !== null) {
          window.clearInterval(pollTimer);
          pollTimer = null;
        }
      };

      const pollStatus = async () => {
        if (!isCurrent()) return;
        try {
          const status = await readVoiceStatus(session.abortController.signal);
          if (!isCurrent()) return;
          const voiceModel = status.speech.voiceModel;
          if (voiceModel !== null && voiceModel.loaded && !voiceModel.downloading) {
            stopPolling();
            setPhase("generating");
          } else {
            setPhase("preparing");
          }
        } catch {
          return;
        }
      };

      const startPolling = () => {
        void pollStatus();
        pollTimer = window.setInterval(
          () => void pollStatus(),
          STATUS_POLL_INTERVAL_MS,
        );
      };

      const playChunk = (blob: Blob): Promise<void> =>
        new Promise<void>((resolve, reject) => {
          if (!isCurrent()) {
            resolve();
            return;
          }
          const url = URL.createObjectURL(blob);
          session.objectUrls.push(url);
          const cleanup = () => {
            audio.onended = null;
            audio.onerror = null;
            session.abortController.signal.removeEventListener(
              "abort",
              onAbort,
            );
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
            reject(new Error("Audio playback failed"));
          };
          session.abortController.signal.addEventListener("abort", onAbort);
          audio.src = url;
          void audio.play().catch((error) => {
            cleanup();
            reject(error);
          });
        });

      try {
        startPolling();
        let prefetch: Promise<Blob> | null = null;
        for (let index = 0; index < chunks.length; index += 1) {
          if (!isCurrent()) return;
          let blob: Blob;
          if (prefetch !== null) {
            blob = await prefetch;
            prefetch = null;
          } else {
            blob = await speakVoiceText(chunks[index], {
              signal: session.abortController.signal,
              agentId,
            });
          }
          if (!isCurrent()) return;

          stopPolling();
          if (index + 1 < chunks.length) {
            prefetch = speakVoiceText(chunks[index + 1], {
              signal: session.abortController.signal,
              agentId,
            }).catch((error: unknown) => {
              if (!isCurrent()) {
                return new Blob();
              }
              throw error;
            });
          }

          setPhase("speaking");
          await playChunk(blob);
        }

        if (isCurrent()) {
          clearSession();
          setState("idle");
          setActiveMessageId(null);
        }
      } catch (error) {
        if (isCurrent()) {
          clearSession();
          setState("idle");
          setActiveMessageId(null);
          appToast.error("Speak failed", {
            description: resolveSpeakErrorMessage(error),
          });
        }
      }
    },
    [clearSession, ensureAudio],
  );

  const speak = useCallback(
    (messageId: string, text: string, agentId?: MessageSpeechAgentId) => {
      clearSession();
      const chunks = chunkSpeechText(text);
      if (chunks.length === 0) {
        setState("idle");
        setActiveMessageId(null);
        return;
      }
      requestSpeechPlayback("message-speech");

      const session: SpeechSession = {
        cancelled: false,
        abortController: new AbortController(),
        objectUrls: [],
      };
      sessionRef.current = session;
      setActiveMessageId(messageId);
      setState("generating");

      void runSpeechSession(session, chunks, agentId);
    },
    [clearSession, runSpeechSession],
  );

  useEffect(() => {
    return () => {
      clearSession();
    };
  }, [clearSession]);

  useEffect(() => registerSpeechPlaybackOwner("message-speech", stop), [stop]);

  const voiceEnabled = useVoiceEnabled();

  useEffect(() => {
    if (!voiceEnabled && state !== "idle") {
      stop();
    }
  }, [voiceEnabled, state, stop]);

  const value = useMemo<MessageSpeechContextValue>(
    () => ({ state, activeMessageId, speak, stop }),
    [state, activeMessageId, speak, stop],
  );

  return (
    <MessageSpeechContext.Provider value={value}>
      {children}
    </MessageSpeechContext.Provider>
  );
}

export function useMessageSpeech(): MessageSpeechContextValue {
  const context = useContext(MessageSpeechContext);
  return context ?? NO_OP_SPEECH;
}
