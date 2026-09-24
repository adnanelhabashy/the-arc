import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { WaveformVisualizer } from "./WaveformVisualizer.js";

interface VoiceRecordingBarProps {
  state: "recording" | "transcribing" | "preparing";
  stream: MediaStream | null;
  onConfirm: () => void;
  onCancel: () => void;
}

const CONTROL_BUTTON_CLASS =
  "size-8 rounded-full p-0 max-md:pointer-coarse:size-10";

export function VoiceRecordingBar({
  state,
  stream,
  onConfirm,
  onCancel,
}: VoiceRecordingBarProps) {
  const isRecording = state === "recording";
  const isPreparing = state === "preparing";
  const isTranscribing = state === "transcribing";
  const isProcessing = isPreparing || isTranscribing;
  const processingLabel = isPreparing
    ? "Preparing speech model…"
    : "Transcribing locally…";

  return (
    <div className="flex flex-row items-center gap-2 px-2 py-1.5">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={isProcessing ? "Cancel transcription" : "Cancel recording"}
        onClick={onCancel}
        className={CONTROL_BUTTON_CLASS}
      >
        <Icon name="X" className="size-4" />
      </Button>
      <div className="relative flex min-w-0 flex-1 items-center">
        <div
          className={cn("h-7 w-full", isProcessing && "animate-shine-icon")}
        >
          <WaveformVisualizer stream={stream} active={isRecording} />
        </div>
        <span className="sr-only" aria-live="polite">
          {isProcessing ? processingLabel : "Recording"}
        </span>
      </div>
      {isProcessing ? (
        <span
          className="shrink-0 text-2xs text-muted-foreground"
          aria-hidden="true"
        >
          {processingLabel}
        </span>
      ) : null}
      <Button
        type="button"
        size="icon"
        variant="default"
        aria-label={
          isProcessing ? processingLabel : "Stop and transcribe recording"
        }
        disabled={isProcessing}
        onClick={onConfirm}
        className={CONTROL_BUTTON_CLASS}
      >
        {isProcessing ? (
          <Icon name="Spinner" className="size-4 animate-spin" />
        ) : (
          <Icon name="Check" className="size-4" />
        )}
      </Button>
    </div>
  );
}
