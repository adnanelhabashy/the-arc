import { useCallback, useEffect, useRef, useState } from "react";
import { appToast } from "@/components/ui/app-toast";
import { normalizeVoiceRecordingToWavWithAnalysis } from "@/lib/voice-audio-normalization";
import { isPathologicalRepetition } from "@/lib/voice-transcript-guard";
import {
  buildAudioInputConstraints,
  useAudioInputDevicePreferenceValue,
} from "@/lib/audio-input-device-preference";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import {
  isDocumentVisible,
  subscribeToDocumentVisibility,
} from "@/lib/document-visibility";
import { readVoiceStatus } from "@/lib/api";
import {
  readVoiceSupportEnvironment,
  resolveVoiceSupport,
  voiceUnsupportedMessage,
  type VoiceUnsupportedReason,
} from "./voice-input-support";

type VoiceInputState =
  | "idle"
  | "recording"
  | "transcribing"
  | "preparing"
  | "error";

const STATUS_POLL_INTERVAL_MS = 400;

interface UseVoiceInputOptions {
  onTranscript: (transcript: string) => void;
  onTranscribe: (args: {
    file: File;
    promptContext?: string;
    signal?: AbortSignal;
  }) => Promise<string>;
  getPromptContext?: () => string | undefined;
  scopeKey?: string | number;
}

const MIN_RECORDING_DURATION_MS = 1_000;
const MAX_RECORDING_DURATION_MS = 10 * 60 * 1_000;
const CHUNK_TIMESLICE_MS = 250;

const NO_CLEAR_SPEECH_MESSAGE = "No clear speech detected. Try again.";

const HTML_DOCUMENT_PATTERN = /<!doctype html|<html[\s>]/i;

function normalizeTranscript(rawText: string): string {
  return rawText.replace(/\s+/g, " ").trim();
}

function sanitizeErrorMessage(raw: string): string | null {
  let normalized = raw.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return null;
  }

  const htmlDocumentMatch = normalized.search(HTML_DOCUMENT_PATTERN);
  if (htmlDocumentMatch >= 0) {
    normalized = normalized.slice(0, htmlDocumentMatch).trim();
  }
  if (normalized.length === 0) {
    return null;
  }

  normalized = normalized.replace(/^HTTP\s+\d{3}:\s*/i, "").trim();
  if (normalized.length === 0) {
    return null;
  }

  return normalized;
}

function resolveRecordingErrorMessage(
  error: unknown,
  hasPreferredAudioInput = false,
): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Microphone permission denied";
      case "NotFoundError":
      case "DevicesNotFoundError":
        return hasPreferredAudioInput
          ? "Selected microphone was not found"
          : "No microphone was found";
      case "NotReadableError":
      case "TrackStartError":
        return "Microphone is already in use";
      case "AbortError":
        return "Voice capture was aborted";
      default:
        return "Failed to start voice recording";
    }
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    const message = sanitizeErrorMessage(error.message);
    if (message) {
      return message;
    }
  }
  return "Voice input failed";
}

function resolvePreferredAudioMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = ["audio/webm", "audio/mp4", "audio/ogg"];
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function useVoiceInput(options: UseVoiceInputOptions) {
  const preferredAudioInputDeviceId = useAudioInputDevicePreferenceValue();
  const reduceBackgroundNoise =
    useSystemConfig().data?.generalSettings.voice.input.reduceBackgroundNoise ??
    true;
  const voiceEnabled =
    useSystemConfig().data?.generalSettings.voice?.enabled ?? true;
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtMsRef = useRef<number | null>(null);
  const promptContextRef = useRef<string | undefined>(undefined);
  const shouldTranscribeRef = useRef(true);
  const transcriptionAbortRef = useRef<AbortController | null>(null);
  const statusPollTimerRef = useRef<number | null>(null);
  const wakeLockSentinelRef = useRef<WakeLockSentinel | null>(null);
  const wakeLockRequestRef = useRef<Promise<void> | null>(null);
  const shouldHoldWakeLockRef = useRef(false);
  const scopeKeyRef = useRef(options.scopeKey);

  const [state, setState] = useState<VoiceInputState>("idle");
  const [isSupported, setIsSupported] = useState(false);
  const [unsupportedReason, setUnsupportedReason] =
    useState<VoiceUnsupportedReason | null>("unsupported-browser");
  const [stream, setStream] = useState<MediaStream | null>(null);

  const showError = useCallback((message: string) => {
    setState("error");
    appToast.error("Voice input failed", { description: message });
  }, []);

  const stopMediaStream = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    stream.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  const stopStatusPolling = useCallback(() => {
    if (statusPollTimerRef.current !== null) {
      window.clearInterval(statusPollTimerRef.current);
      statusPollTimerRef.current = null;
    }
  }, []);

  const requestRecordingWakeLock = useCallback(() => {
    if (
      typeof window === "undefined" ||
      typeof navigator === "undefined" ||
      typeof document === "undefined" ||
      !("wakeLock" in navigator) ||
      window.isSecureContext === false ||
      document.visibilityState !== "visible"
    ) {
      return;
    }

    const wakeLock = navigator.wakeLock;
    if (!wakeLock) {
      return;
    }

    const currentSentinel = wakeLockSentinelRef.current;
    if (currentSentinel && !currentSentinel.released) {
      return;
    }
    if (wakeLockRequestRef.current) {
      return;
    }

    wakeLockRequestRef.current = wakeLock
      .request("screen")
      .then((sentinel) => {
        if (!shouldHoldWakeLockRef.current) {
          if (!sentinel.released) {
            void sentinel.release().catch(() => {});
          }
          return;
        }

        wakeLockSentinelRef.current = sentinel;
        sentinel.addEventListener("release", () => {
          if (wakeLockSentinelRef.current === sentinel) {
            wakeLockSentinelRef.current = null;
          }
        });
      })
      .catch(() => {})
      .finally(() => {
        wakeLockRequestRef.current = null;
      });
  }, []);

  const releaseRecordingWakeLock = useCallback(() => {
    shouldHoldWakeLockRef.current = false;

    const sentinel = wakeLockSentinelRef.current;
    wakeLockSentinelRef.current = null;
    if (!sentinel || sentinel.released) {
      return;
    }

    void sentinel.release().catch(() => {});
  }, []);

  useEffect(() => {
    const support = resolveVoiceSupport(readVoiceSupportEnvironment());
    setIsSupported(support.isSupported);
    setUnsupportedReason(support.reason);
  }, []);

  useEffect(() => {
    return () => {
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state === "recording") {
        try {
          recorder.stop();
        } catch {}
      }
      mediaRecorderRef.current = null;
      chunksRef.current = [];
      startedAtMsRef.current = null;
      promptContextRef.current = undefined;
      shouldTranscribeRef.current = false;
      releaseRecordingWakeLock();
      if (transcriptionAbortRef.current) {
        transcriptionAbortRef.current.abort();
        transcriptionAbortRef.current = null;
      }
      stopStatusPolling();
      stopMediaStream();
    };
  }, [releaseRecordingWakeLock, stopMediaStream, stopStatusPolling]);

  useEffect(() => {
    return subscribeToDocumentVisibility(() => {
      if (isDocumentVisible() && shouldHoldWakeLockRef.current) {
        requestRecordingWakeLock();
      }
    });
  }, [requestRecordingWakeLock]);

  useEffect(() => {
    if (scopeKeyRef.current === options.scopeKey) return;
    scopeKeyRef.current = options.scopeKey;

    shouldTranscribeRef.current = false;
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === "recording") {
      try {
        recorder.stop();
      } catch {}
    }
    if (transcriptionAbortRef.current) {
      transcriptionAbortRef.current.abort();
      transcriptionAbortRef.current = null;
    }
    stopStatusPolling();
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    startedAtMsRef.current = null;
    promptContextRef.current = undefined;
    releaseRecordingWakeLock();
    stopMediaStream();
    setState("idle");
  }, [
    options.scopeKey,
    releaseRecordingWakeLock,
    stopMediaStream,
    stopStatusPolling,
  ]);

  const start = useCallback(async () => {
    if (!voiceEnabled) {
      return;
    }
    if (!isSupported) {
      showError(voiceUnsupportedMessage(unsupportedReason));
      return;
    }
    if (state === "recording" || state === "transcribing" || state === "preparing") {
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia(
        buildAudioInputConstraints(preferredAudioInputDeviceId, {
          reduceBackgroundNoise,
        }),
      );
      streamRef.current = stream;
      setStream(stream);
      chunksRef.current = [];
      startedAtMsRef.current = Date.now();
      promptContextRef.current = options.getPromptContext?.();
      shouldTranscribeRef.current = true;
      shouldHoldWakeLockRef.current = true;
      requestRecordingWakeLock();

      const preferredMimeType = resolvePreferredAudioMimeType();
      const recorder = preferredMimeType
        ? new MediaRecorder(stream, { mimeType: preferredMimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.onstart = () => {
        setState("recording");
      };

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        showError("Voice recording failed");
      };

      recorder.onstop = async () => {
        releaseRecordingWakeLock();
        stopMediaStream();

        if (!shouldTranscribeRef.current) {
          shouldTranscribeRef.current = true;
          chunksRef.current = [];
          promptContextRef.current = undefined;
          setState("idle");
          return;
        }

        const startedAtMs = startedAtMsRef.current ?? Date.now();
        startedAtMsRef.current = null;
        const durationMs = Date.now() - startedAtMs;

        if (durationMs < MIN_RECORDING_DURATION_MS) {
          showError("Recording too short (minimum 1 second)");
          chunksRef.current = [];
          promptContextRef.current = undefined;
          return;
        }

        if (durationMs > MAX_RECORDING_DURATION_MS) {
          showError("Recording too long (maximum 10 minutes)");
          chunksRef.current = [];
          promptContextRef.current = undefined;
          return;
        }

        const chunks = chunksRef.current;
        chunksRef.current = [];
        if (chunks.length === 0) {
          showError("No audio was captured");
          promptContextRef.current = undefined;
          return;
        }

        const recordedMimeType =
          recorder.mimeType || preferredMimeType || "audio/webm";
        const audioBlob = new Blob(chunks, { type: recordedMimeType });
        chunks.length = 0;
        const promptContext = promptContextRef.current;
        promptContextRef.current = undefined;

        const abortController = new AbortController();
        transcriptionAbortRef.current = abortController;

        let transcriptionPhase: "preparing" | "transcribing" = "transcribing";
        try {
          const status = await readVoiceStatus(abortController.signal);
          const speech = status.speech;
          if (
            status.transcriptionEnabled === false ||
            speech.runtimeState !== "ready" ||
            !speech.speechModelLoaded
          ) {
            transcriptionPhase = "preparing";
          }
        } catch {
          transcriptionPhase = "transcribing";
        }

        if (
          !shouldTranscribeRef.current ||
          abortController.signal.aborted ||
          transcriptionAbortRef.current !== abortController
        ) {
          if (transcriptionAbortRef.current === abortController) {
            transcriptionAbortRef.current = null;
          }
          chunksRef.current = [];
          promptContextRef.current = undefined;
          setState("idle");
          return;
        }

        setState(transcriptionPhase);
        const abandonTranscription = (): void => {
          if (transcriptionAbortRef.current === abortController) {
            stopStatusPolling();
            setState("idle");
          }
        };

        if (transcriptionPhase === "preparing") {
          statusPollTimerRef.current = window.setInterval(() => {
            if (transcriptionAbortRef.current !== abortController) return;
            void readVoiceStatus(abortController.signal)
              .then((status) => {
                if (transcriptionAbortRef.current !== abortController) return;
                if (
                  status.speech.runtimeState === "ready" &&
                  status.speech.speechModelLoaded
                ) {
                  stopStatusPolling();
                  setState("transcribing");
                }
              })
              .catch(() => {});
          }, STATUS_POLL_INTERVAL_MS);
        }

        try {
          const { file: audioFile, analysis } =
            await normalizeVoiceRecordingToWavWithAnalysis({
              blob: audioBlob,
              sourceMimeType: recordedMimeType,
              signal: abortController.signal,
            });
          if (analysis.isNearSilence) {
            if (abortController.signal.aborted) {
              abandonTranscription();
              return;
            }
            stopStatusPolling();
            setState("idle");
            appToast.error(NO_CLEAR_SPEECH_MESSAGE);
            return;
          }
          const transcript = await options.onTranscribe({
            file: audioFile,
            promptContext,
            signal: abortController.signal,
          });
          if (abortController.signal.aborted) {
            abandonTranscription();
            return;
          }
          const normalized = normalizeTranscript(transcript);
          if (normalized.length === 0) {
            throw new Error("Voice transcription returned an empty result.");
          }
          if (isPathologicalRepetition(normalized)) {
            stopStatusPolling();
            setState("idle");
            appToast.error(NO_CLEAR_SPEECH_MESSAGE);
            return;
          }
          options.onTranscript(normalized);
          stopStatusPolling();
          setState("idle");
        } catch (error) {
          if (
            (error instanceof DOMException && error.name === "AbortError") ||
            abortController.signal.aborted
          ) {
            abandonTranscription();
            return;
          }
          stopStatusPolling();
          setState("error");
          appToast.error("Voice input failed", {
            description: resolveRecordingErrorMessage(error),
          });
        } finally {
          if (transcriptionAbortRef.current === abortController) {
            transcriptionAbortRef.current = null;
          }
        }
      };

      recorder.start(CHUNK_TIMESLICE_MS);
    } catch (error) {
      stopMediaStream();
      mediaRecorderRef.current = null;
      chunksRef.current = [];
      startedAtMsRef.current = null;
      promptContextRef.current = undefined;
      shouldTranscribeRef.current = true;
      transcriptionAbortRef.current = null;
      releaseRecordingWakeLock();
      showError(
        resolveRecordingErrorMessage(
          error,
          preferredAudioInputDeviceId !== null,
        ),
      );
    }
  }, [
    isSupported,
    options,
    unsupportedReason,
    preferredAudioInputDeviceId,
    reduceBackgroundNoise,
    releaseRecordingWakeLock,
    requestRecordingWakeLock,
    showError,
    state,
    stopMediaStream,
    stopStatusPolling,
    voiceEnabled,
  ]);

  const stop = useCallback(() => {
    if (state !== "recording") {
      return;
    }

    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") {
      return;
    }
    shouldTranscribeRef.current = true;
    try {
      recorder.stop();
    } catch (error) {
      showError(resolveRecordingErrorMessage(error));
    }
  }, [showError, state]);

  const cancel = useCallback(() => {
    if (state === "recording") {
      shouldTranscribeRef.current = false;
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state === "recording") {
        try {
          recorder.stop();
        } catch (error) {
          showError(resolveRecordingErrorMessage(error));
        }
      }
      return;
    }

    if (state === "transcribing" || state === "preparing") {
      const abortController = transcriptionAbortRef.current;
      if (abortController) {
        abortController.abort();
        transcriptionAbortRef.current = null;
      }
      stopStatusPolling();
      setState("idle");
    }
  }, [showError, state, stopStatusPolling]);

  useEffect(() => {
    if (!voiceEnabled && state !== "idle") {
      cancel();
    }
  }, [voiceEnabled, state, cancel]);

  return {
    state,
    isSupported,
    unsupportedReason,
    stream,
    isRecording: state === "recording",
    isProcessing: state === "preparing" || state === "transcribing",
    isListening:
      state === "recording" ||
      state === "preparing" ||
      state === "transcribing",
    start,
    stop,
    cancel,
  };
}
