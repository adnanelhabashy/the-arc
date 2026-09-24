import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildAudioInputConstraints,
  useAudioInputDevicePreferenceValue,
} from "@/lib/audio-input-device-preference";

const TEST_MAX_MS = 3000;

export type MicrophoneTestState = "idle" | "testing" | "playing";

export function useMicrophoneTest() {
  const preferredDeviceId = useAudioInputDevicePreferenceValue();
  const [state, setState] = useState<MicrophoneTestState>("idle");
  const [level, setLevel] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const cleanup = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const context = audioContextRef.current;
    if (context !== null) {
      audioContextRef.current = null;
      void context.close().catch(() => undefined);
    }
    const stream = streamRef.current;
    if (stream !== null) {
      streamRef.current = null;
      stream.getTracks().forEach((track) => track.stop());
    }
    recorderRef.current = null;
    chunksRef.current = [];
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder !== null && recorder.state === "recording") {
      recorder.stop();
      return;
    }
    cleanup();
    setState("idle");
    setLevel(0);
  }, [cleanup]);

  const start = useCallback(async () => {
    setErrorMessage(null);
    cleanup();
    try {
      const stream = await navigator.mediaDevices.getUserMedia(
        buildAudioInputConstraints(preferredDeviceId),
      );
      streamRef.current = stream;

      const AudioContextConstructor = window.AudioContext;
      if (AudioContextConstructor !== undefined) {
        const context = new AudioContextConstructor();
        audioContextRef.current = context;
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const loop = () => {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i += 1) {
            const sample = (data[i] - 128) / 128;
            sum += sample * sample;
          }
          setLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
          rafRef.current = requestAnimationFrame(loop);
        };
        rafRef.current = requestAnimationFrame(loop);
      }

      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        chunksRef.current = [];
        const stream = streamRef.current;
        if (stream !== null) {
          streamRef.current = null;
          stream.getTracks().forEach((track) => track.stop());
        }
        if (blob.size === 0) {
          setState("idle");
          setLevel(0);
          return;
        }
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => {
          URL.revokeObjectURL(url);
          setState("idle");
          setLevel(0);
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          setState("idle");
          setLevel(0);
        };
        setState("playing");
        void audio.play().catch(() => {
          URL.revokeObjectURL(url);
          setState("idle");
          setLevel(0);
        });
      };

      recorder.start();
      setState("testing");
      window.setTimeout(() => {
        const recorder = recorderRef.current;
        if (recorder !== null && recorder.state === "recording") {
          recorder.stop();
        }
      }, TEST_MAX_MS);
    } catch (error) {
      cleanup();
      setState("idle");
      setErrorMessage(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Microphone permission denied"
          : "Failed to test microphone",
      );
    }
  }, [cleanup, preferredDeviceId]);

  return { state, level, errorMessage, start, stop };
}
