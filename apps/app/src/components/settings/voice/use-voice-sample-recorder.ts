import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeVoiceRecordingToWav } from "@/lib/voice-audio-normalization";
import {
  buildAudioInputConstraints,
  useAudioInputDevicePreferenceValue,
} from "@/lib/audio-input-device-preference";

export type VoiceSampleRecorderStatus =
  | "idle"
  | "recording"
  | "processing"
  | "done"
  | "error";

const MIN_RECORDING_DURATION_MS = 1_000;
const MAX_RECORDING_DURATION_MS = 5 * 60 * 1_000;
const CHUNK_TIMESLICE_MS = 250;

function resolvePreferredAudioMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") {
    return null;
  }
  for (const candidate of ["audio/webm", "audio/mp4", "audio/ogg"]) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveRecordErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Microphone permission denied";
      case "NotFoundError":
      case "DevicesNotFoundError":
        return "No microphone was found";
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
    return error.message.trim();
  }
  return "Voice recording failed";
}

export function useVoiceSampleRecorder() {
  const preferredDeviceId = useAudioInputDevicePreferenceValue();
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number | null>(null);

  const [status, setStatus] = useState<VoiceSampleRecorderStatus>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);

  const stopStream = useCallback(() => {
    const stream = streamRef.current;
    if (stream !== null) {
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    stopStream();
    recorderRef.current = null;
    chunksRef.current = [];
    startedAtRef.current = null;
    setStatus("idle");
    setFile(null);
    setErrorMessage(null);
    setDurationMs(null);
  }, [stopStream]);

  useEffect(() => reset, [reset]);

  const start = useCallback(async () => {
    if (status === "recording" || status === "processing") {
      return;
    }
    setErrorMessage(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia(
        buildAudioInputConstraints(preferredDeviceId),
      );
      streamRef.current = stream;
      chunksRef.current = [];
      startedAtRef.current = Date.now();

      const preferredMimeType = resolvePreferredAudioMimeType();
      const recorder = preferredMimeType
        ? new MediaRecorder(stream, { mimeType: preferredMimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;

      recorder.onstart = () => {
        setStatus("recording");
      };
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => {
        setStatus("error");
        setErrorMessage("Voice recording failed");
        stopStream();
      };
      recorder.onstop = async () => {
        stopStream();
        const startedAt = startedAtRef.current ?? Date.now();
        startedAtRef.current = null;
        const duration = Date.now() - startedAt;

        if (duration < MIN_RECORDING_DURATION_MS) {
          setStatus("error");
          setErrorMessage("Recording too short (minimum 1 second)");
          return;
        }
        if (duration > MAX_RECORDING_DURATION_MS) {
          setStatus("error");
          setErrorMessage("Recording too long (maximum 5 minutes)");
          return;
        }

        const chunks = chunksRef.current;
        chunksRef.current = [];
        if (chunks.length === 0) {
          setStatus("error");
          setErrorMessage("No audio was captured");
          return;
        }

        setStatus("processing");
        const recordedMimeType = recorder.mimeType || "audio/webm";
        const audioBlob = new Blob(chunks, { type: recordedMimeType });
        try {
          const wavFile = await normalizeVoiceRecordingToWav({
            blob: audioBlob,
            sourceMimeType: recordedMimeType,
          });
          setFile(wavFile);
          setDurationMs(duration);
          setStatus("done");
        } catch (error) {
          setStatus("error");
          setErrorMessage(resolveRecordErrorMessage(error));
        }
      };

      recorder.start(CHUNK_TIMESLICE_MS);
    } catch (error) {
      stopStream();
      recorderRef.current = null;
      chunksRef.current = [];
      startedAtRef.current = null;
      setStatus("error");
      setErrorMessage(resolveRecordErrorMessage(error));
    }
  }, [preferredDeviceId, status, stopStream]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder === null || recorder.state !== "recording") {
      return;
    }
    try {
      recorder.stop();
    } catch (error) {
      setStatus("error");
      setErrorMessage(resolveRecordErrorMessage(error));
    }
  }, []);

  return {
    status,
    isRecording: status === "recording",
    isProcessing: status === "processing",
    file,
    errorMessage,
    durationMs,
    start,
    stop,
    reset,
  };
}
