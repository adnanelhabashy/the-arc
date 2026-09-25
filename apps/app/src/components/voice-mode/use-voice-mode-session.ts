import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { speakVoiceText, transcribeVoiceInput } from "@/lib/api";
import { chunkSpeechText } from "@/lib/speech-chunks";
import {
  registerSpeechPlaybackOwner,
  releaseSpeechPlayback,
  requestSpeechPlayback,
} from "@/lib/speech-playback-coordinator";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { useSendThreadMessage } from "@/hooks/mutations/thread-runtime-mutations";
import { useThread } from "@/hooks/queries/thread-queries";
import { useThreadTimeline } from "@/hooks/queries/thread-queries";
import {
  startBargeInDetection,
  type BargeInDetectionHandle,
} from "./barge-in-detector";
import { UtteranceEndDetector } from "./utterance-end-detector";
import {
  VoiceModeSession,
  type VoiceModeEffects,
  type VoiceModeState,
} from "./voice-mode-state";
import type { VoiceRingLevelSource } from "./voice-ring-canvas";

export type VoiceResponseDetail = "brief" | "balanced" | "full";

export interface VoiceModeSessionController {
  state: VoiceModeState;
  micLevel: VoiceRingLevelSource;
  ttsLevel: VoiceRingLevelSource;
  begin: () => void;
  endUtterance: () => void;
  acknowledgeError: () => void;
  exit: () => void;
}

const REPLY_POLL_INTERVAL_MS = 600;
const REPLY_TIMEOUT_MS = 5 * 60 * 1_000;
const LEVEL_SAMPLE_INTERVAL_MS = 64;
const MAX_SPEAK_INPUT_CHARS = 8000;

interface TranscriptBridge {
  resolve: (text: string | null) => void;
  delivered: boolean;
}

function rmsOf(analyser: AnalyserNode): number {
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) {
    const v = (data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / data.length) * 3;
}

export function useVoiceModeSession(args: {
  threadId: string;
  agentId: "codex" | "claude-code" | "omp" | null;
  detail: VoiceResponseDetail;
}): VoiceModeSessionController {
  const { threadId, agentId, detail } = args;
  const [state, setState] = useState<VoiceModeState>({ kind: "idle" });
  const micLevel = useRef<VoiceRingLevelSource>({ level: 0 }).current;
  const ttsLevel = useRef<VoiceRingLevelSource>({ level: 0 }).current;

  const sessionRef = useRef<VoiceModeSession | null>(null);
  const transcriptBridgeRef = useRef<TranscriptBridge | null>(null);
  const speakAbortRef = useRef<AbortController | null>(null);
  const bargeInHandleRef = useRef<BargeInDetectionHandle | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const ttsAnalyserRef = useRef<AnalyserNode | null>(null);
  const levelTimerRef = useRef<number | null>(null);
  const micSourceRef = useRef<{
    stream: MediaStream;
    cleanup: () => void;
  } | null>(null);
  const assistantBaselineRef = useRef(0);
  const disposedRef = useRef(false);
  const detailRef = useRef(detail);
  detailRef.current = detail;

  const sendThreadMessage = useSendThreadMessage();
  const threadQuery = useThread(threadId);
  const timelineQuery = useThreadTimeline(threadId);
  const timelineRowsRef = useRef(timelineQuery.data?.rows ?? []);
  timelineRowsRef.current = timelineQuery.data?.rows ?? [];
  const threadStatusRef = useRef(threadQuery.data?.status ?? "idle");
  threadStatusRef.current = threadQuery.data?.status ?? "idle";

  const voiceEnabled =
    useSystemConfig().data?.generalSettings?.voice?.enabled ?? true;

  const ensureAudioGraph = useCallback((): {
    element: HTMLAudioElement;
    analyser: AnalyserNode;
  } => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
    }
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
    }
    // The mic-level effect may have created the context first; the analyser
    // must be set up whenever it is missing, not only on context creation,
    // otherwise the first turn throws "TTS analyser unavailable".
    if (ttsAnalyserRef.current === null) {
      const source = audioCtxRef.current.createMediaElementSource(
        audioRef.current,
      );
      const analyser = audioCtxRef.current.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      analyser.connect(audioCtxRef.current.destination);
      ttsAnalyserRef.current = analyser;
    }
    void audioCtxRef.current.resume().catch(() => {});
    return { element: audioRef.current, analyser: ttsAnalyserRef.current };
  }, []);

  const stopLevelSampling = useCallback(() => {
    if (levelTimerRef.current !== null) {
      window.clearInterval(levelTimerRef.current);
      levelTimerRef.current = null;
    }
    ttsLevel.level = 0;
    micLevel.level = 0;
  }, [micLevel, ttsLevel]);

  const stopSpeaking = useCallback(() => {
    speakAbortRef.current?.abort();
    speakAbortRef.current = null;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.onended = null;
      audio.onerror = null;
      audio.removeAttribute("src");
      audio.load();
    }
    stopLevelSampling();
    releaseSpeechPlayback("voice-mode");
  }, [stopLevelSampling]);

  const effectsRef = useRef<VoiceModeEffects | null>(null);

  const voiceInput = useVoiceInput({
    scopeKey: `voice-mode:${threadId}`,
    onTranscript: useCallback((text: string) => {
      const bridge = transcriptBridgeRef.current;
      if (bridge) {
        bridge.delivered = true;
        transcriptBridgeRef.current = null;
        bridge.resolve(text);
      }
    }, []),
    onTranscribe: useCallback(
      async ({
        file,
        promptContext,
        signal,
      }: {
        file: File;
        promptContext?: string;
        signal?: AbortSignal;
      }) => {
        const transcription = await transcribeVoiceInput(
          file,
          promptContext,
          signal,
        );
        return transcription.text;
      },
      [],
    ),
  });
  const voiceInputRef = useRef(voiceInput);
  voiceInputRef.current = voiceInput;
  const sendRef = useRef(sendThreadMessage);
  sendRef.current = sendThreadMessage;

  if (effectsRef.current === null) {
    let captureStarting = false;
    effectsRef.current = {
      startCapture: () => {
        const input = voiceInputRef.current;
        if (
          captureStarting ||
          input.state === "recording" ||
          input.state === "preparing" ||
          input.state === "transcribing"
        ) {
          return;
        }
        captureStarting = true;
        void input.start().finally(() => {
          captureStarting = false;
        });
      },
      cancelCapture: () => {
        voiceInputRef.current.cancel();
      },
      transcribe: () => {
        if (voiceInputRef.current.state !== "recording") {
          return Promise.resolve(null);
        }
        voiceInputRef.current.stop();
        return new Promise<string | null>((resolve) => {
          transcriptBridgeRef.current = { resolve, delivered: false };
        });
      },
      send: async (text) => {
        const rows = timelineRowsRef.current;
        assistantBaselineRef.current = Math.max(
          0,
          ...rows
            .filter(
              (row) => row.kind === "conversation" && row.role === "assistant",
            )
            .map((row) => row.sourceSeqStart),
        );
        await sendRef.current.mutateAsync({
          id: threadId,
          input: [{ type: "text", text, mentions: [] }],
          mode: "queue-if-active",
        });
      },
      awaitAssistantReply: () =>
        new Promise<{ messageId: string; text: string } | null>((resolve) => {
          const startedAt = Date.now();
          const poll = (): void => {
            if (disposedRef.current) {
              resolve(null);
              return;
            }
            const reply = [...timelineRowsRef.current]
              .flatMap((row) =>
                row.kind === "conversation" &&
                row.role === "assistant" &&
                "text" in row &&
                typeof row.text === "string" &&
                row.text.trim().length > 0 &&
                row.sourceSeqStart > assistantBaselineRef.current
                  ? [
                      {
                        id: row.id,
                        text: row.text,
                        sourceSeqStart: row.sourceSeqStart,
                      },
                    ]
                  : [],
              )
              .sort((a, b) => a.sourceSeqStart - b.sourceSeqStart)
              .at(-1);
            const settled =
              threadStatusRef.current === "idle" ||
              threadStatusRef.current === "error";
            if (reply !== undefined && settled) {
              resolve({ messageId: reply.id, text: reply.text });
              return;
            }
            if (Date.now() - startedAt > REPLY_TIMEOUT_MS) {
              resolve(null);
              return;
            }
            window.setTimeout(poll, REPLY_POLL_INTERVAL_MS);
          };
          poll();
        }),
      speak: async (messageId, text) => {
        requestSpeechPlayback("voice-mode");
        const { element, analyser } = ensureAudioGraph();
        const controller = new AbortController();
        speakAbortRef.current = controller;
        const currentDetail = detailRef.current;
        const speakableInput =
          text.length > MAX_SPEAK_INPUT_CHARS
            ? text.slice(0, MAX_SPEAK_INPUT_CHARS)
            : text;
        const chunks =
          currentDetail === "balanced"
            ? chunkSpeechText(speakableInput)
            : [speakableInput];
        levelTimerRef.current = window.setInterval(() => {
          ttsLevel.level = Math.min(1, rmsOf(analyser));
        }, LEVEL_SAMPLE_INTERVAL_MS);

        const playBlob = (blob: Blob): Promise<void> =>
          new Promise<void>((resolve, reject) => {
            if (controller.signal.aborted) {
              resolve();
              return;
            }
            const url = URL.createObjectURL(blob);
            const cleanup = (): void => {
              element.onended = null;
              element.onerror = null;
              controller.signal.removeEventListener("abort", onAbort);
              URL.revokeObjectURL(url);
            };
            const onAbort = (): void => {
              cleanup();
              resolve();
            };
            element.onended = () => {
              cleanup();
              resolve();
            };
            element.onerror = () => {
              cleanup();
              reject(new Error("Voice playback failed"));
            };
            controller.signal.addEventListener("abort", onAbort);
            element.src = url;
            void element.play().catch((error: unknown) => {
              cleanup();
              reject(error instanceof Error ? error : new Error(String(error)));
            });
          });

        try {
          let prefetch: Promise<Blob> | null = null;
          for (let index = 0; index < chunks.length; index += 1) {
            if (controller.signal.aborted) return;
            let blob: Blob;
            if (prefetch !== null) {
              blob = await prefetch;
              prefetch = null;
            } else {
              blob = await speakVoiceText(chunks[index], {
                signal: controller.signal,
                agentId: agentId ?? undefined,
                ...(currentDetail === "balanced"
                  ? {}
                  : { detail: currentDetail }),
              });
            }
            if (controller.signal.aborted) return;
            if (index + 1 < chunks.length) {
              prefetch = speakVoiceText(chunks[index + 1], {
                signal: controller.signal,
                agentId: agentId ?? undefined,
              }).catch((error: unknown) => {
                if (controller.signal.aborted) return new Blob();
                throw error;
              });
            }
            await playBlob(blob);
            if (controller.signal.aborted) return;
          }
        } finally {
          stopLevelSampling();
          releaseSpeechPlayback("voice-mode");
        }
        void messageId;
      },
      stopSpeaking,
      startBargeInDetection: (onBargeIn) => {
        void (async () => {
          try {
            const handle = await startBargeInDetection({
              deps: {
                getUserMedia: (constraints) =>
                  navigator.mediaDevices.getUserMedia(constraints),
                createAnalyser: (stream) => {
                  ensureAudioGraph();
                  const ctx = audioCtxRef.current;
                  if (ctx === null) {
                    throw new Error("Audio context unavailable");
                  }
                  const source = ctx.createMediaStreamSource(stream);
                  const micAnalyser = ctx.createAnalyser();
                  micAnalyser.fftSize = 512;
                  source.connect(micAnalyser);
                  return {
                    analyser: micAnalyser,
                    sample: () => Math.min(1, rmsOf(micAnalyser)),
                  };
                },
              },
              onBargeIn,
            });
            bargeInHandleRef.current = handle;
          } catch {
            // Barge-in detection is best-effort: without a second mic stream
            // the conversation still works, just without interruption.
          }
        })();
      },
      stopBargeInDetection: () => {
        bargeInHandleRef.current?.stop();
        bargeInHandleRef.current = null;
      },
    };
  }

  if (sessionRef.current === null) {
    sessionRef.current = new VoiceModeSession(effectsRef.current);
    sessionRef.current.subscribe(setState);
  }

  const session = sessionRef.current;

  // Mic amplitude for the ring while the capture stream is live. The mic
  // analyser is deliberately NOT connected to the destination: it only feeds
  // the ring, never the speakers.
  useEffect(() => {
    if (!voiceEnabled) return;
    if (voiceInput.state !== "recording" || !voiceInput.stream) {
      micSourceRef.current?.cleanup();
      micSourceRef.current = null;
      return;
    }
    if (micSourceRef.current?.stream === voiceInput.stream) return;
    micSourceRef.current?.cleanup();
    const ctx = audioCtxRef.current ?? new AudioContext();
    audioCtxRef.current = ctx;
    void ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(voiceInput.stream);
    const micAnalyser = ctx.createAnalyser();
    micAnalyser.fftSize = 512;
    source.connect(micAnalyser);
    micSourceRef.current = {
      stream: voiceInput.stream,
      cleanup: () => {
        source.disconnect();
        micAnalyser.disconnect();
      },
    };
    const vad = new UtteranceEndDetector();
    const timer = window.setInterval(() => {
      const level = Math.min(1, rmsOf(micAnalyser));
      micLevel.level = level;
      if (vad.update(level)) {
        sessionRef.current?.utteranceEnded();
      }
    }, LEVEL_SAMPLE_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      micLevel.level = 0;
    };
  }, [voiceEnabled, voiceInput.state, voiceInput.stream, micLevel]);

  // A transcription guard failure returns the hook to idle without ever
  // calling onTranscript; resolve the pending bridge as "no speech". A hook
  // error outside a pending bridge is an async capture failure the machine
  // cannot observe (e.g. getUserMedia denied mid-session).
  useEffect(() => {
    if (voiceInput.state !== "idle" && voiceInput.state !== "error") return;
    const bridge = transcriptBridgeRef.current;
    if (bridge && !bridge.delivered) {
      transcriptBridgeRef.current = null;
      bridge.resolve(null);
      return;
    }
    if (voiceInput.state === "error") {
      sessionRef.current?.externalError(
        voiceInput.errorMessage
          ? `Voice capture failed: ${voiceInput.errorMessage}`
          : "Voice capture failed.",
      );
    }
  }, [voiceInput.state, voiceInput.errorMessage]);

  useEffect(() => {
    if (!voiceEnabled) {
      sessionRef.current?.cancel();
    }
  }, [voiceEnabled]);

  useEffect(() => {
    const current = sessionRef.current;
    return () => {
      disposedRef.current = true;
      current?.cancel();
      bargeInHandleRef.current?.stop();
      micSourceRef.current?.cleanup();
      stopLevelSampling();
      if (audioCtxRef.current) {
        void audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
        ttsAnalyserRef.current = null;
        audioRef.current = null;
      }
    };
  }, [stopLevelSampling]);

  useEffect(
    () => registerSpeechPlaybackOwner("voice-mode", stopSpeaking),
    [stopSpeaking],
  );

  return useMemo(
    () => ({
      state,
      micLevel,
      ttsLevel,
      begin: () => {
        session.start();
      },
      endUtterance: () => {
        session.utteranceEnded();
      },
      acknowledgeError: () => {
        session.acknowledgeError();
      },
      exit: () => {
        session.cancel();
      },
    }),
    [state, micLevel, ttsLevel, session],
  );
}
