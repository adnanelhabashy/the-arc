import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "@bb/shared-ui/hooks/use-media-query";
import { Icon } from "@bb/shared-ui/icon";
import { Button } from "@bb/shared-ui/button";
import { cn } from "@bb/shared-ui/lib/utils";
import { useThread, useThreadTimeline } from "@/hooks/queries/thread-queries";
import { useVoiceEnabled } from "@/components/thread/timeline/voice-enabled";
import { ThreadTimelineSurface } from "@/components/thread/timeline/ThreadTimelineSurface";
import { providerIdToAgentId } from "@/components/thread/timeline/ProviderUsageSection";
import { useDesktopWindowState } from "@/hooks/useDesktopWindowState";
import {
  CHROME_ROW_HEIGHT_CLASS,
  getBbDesktopInfo,
  MACOS_APP_REGION_NO_DRAG_CLASS,
  MACOS_CHROME_CONTROL_AXIS_CLASS,
  MACOS_COLLAPSED_TOP_LEFT_RESERVE_CLASS,
  MACOS_WINDOW_DRAG_CLASS,
  shouldReserveMacosTrafficLights,
  shouldUseMacosDesktopChrome,
} from "@/lib/bb-desktop";
import { VoiceRingAnimator, type VoiceRingLevelSource } from "./voice-ring-canvas";
import {
  useVoiceModeSession,
  type VoiceResponseDetail,
} from "./use-voice-mode-session";

const STATE_LABELS: Record<string, string> = {
  idle: "Arc Voice",
  listening: "Listening…",
  transcribing: "Transcribing…",
  thinking: "Thinking…",
  speaking: "Speaking…",
  interrupted: "Interrupted",
  error: "Something went wrong",
};

const DETAIL_OPTIONS: Array<{ value: VoiceResponseDetail; label: string }> = [
  { value: "brief", label: "Brief" },
  { value: "balanced", label: "Balanced" },
  { value: "full", label: "Read full" },
];

export function VoiceModeView(args: {
  threadId: string;
  projectId: string;
  onExit: () => void;
}) {
  const { threadId, projectId, onExit } = args;
  const voiceEnabled = useVoiceEnabled();
  const reducedMotion = usePrefersReducedMotion();
  const [desktopInfo] = useState(getBbDesktopInfo);
  const desktopWindowState = useDesktopWindowState();
  const usesDesktopChrome = shouldUseMacosDesktopChrome(desktopInfo);
  const reserveMacosTrafficLights = shouldReserveMacosTrafficLights({
    desktopInfo,
    windowState: desktopWindowState,
  });
  const thread = useThread(threadId).data;
  const agentId = providerIdToAgentId(thread?.providerId);
  const agentLabel =
    agentId === null
      ? (thread?.providerId ?? "Agent")
      : agentId === "claude-code"
        ? "Claude Code"
        : agentId === "omp"
          ? "OMP"
          : "Codex";
  const [detail, setDetail] = useState<VoiceResponseDetail>("balanced");
  const { state, micLevel, ttsLevel, begin, endUtterance, acknowledgeError, exit } =
    useVoiceModeSession({ threadId, agentId, detail });

  const timeline = useThreadTimeline(threadId);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animatorRef = useRef<VoiceRingAnimator | null>(null);

  useEffect(() => {
    if (!voiceEnabled) return;
    begin();
    // The session is created once per mount; begin starts the loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceEnabled]);

  useEffect(() => {
    if (!voiceEnabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let animator: VoiceRingAnimator;
    try {
      animator = new VoiceRingAnimator(canvas, {
        reducedMotion,
      });
    } catch {
      // Canvas 2D unavailable (test environments, exotic embeds): the state
      // text still carries the session state.
      return;
    }
    animatorRef.current = animator;
    animator.start();
    return () => {
      animator.stop();
      animatorRef.current = null;
    };
  }, [reducedMotion, voiceEnabled]);

  useEffect(() => {
    const animator = animatorRef.current;
    if (!animator) return;
    animator.setState(state.kind);
    const source: VoiceRingLevelSource | null =
      state.kind === "listening" || state.kind === "transcribing"
        ? micLevel
        : state.kind === "speaking"
          ? ttsLevel
          : null;
    animator.attachLevelSource(source);
  }, [state, micLevel, ttsLevel]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        exit();
        onExit();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [exit, onExit]);

  const handleExit = (): void => {
    exit();
    onExit();
  };

  if (!voiceEnabled) {
    return (
      <div
        data-voice-mode="disabled"
        className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-background"
      >
        <Icon name="Mic" className="size-8 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">
          Voice is disabled. Enable Arc Voice in Settings → Voice.
        </p>
        <Button type="button" variant="outline" size="sm" onClick={handleExit}>
          Exit
        </Button>
      </div>
    );
  }

  return (
    <div
      data-voice-mode="active"
      className="fixed inset-0 z-50 flex flex-col bg-background"
    >
      <header
        className={cn(
          "flex items-center justify-between border-b border-border px-4",
          CHROME_ROW_HEIGHT_CLASS,
          usesDesktopChrome && reserveMacosTrafficLights && [
            MACOS_COLLAPSED_TOP_LEFT_RESERVE_CLASS,
            MACOS_WINDOW_DRAG_CLASS,
            MACOS_CHROME_CONTROL_AXIS_CLASS,
          ],
        )}
      >
        <div
          className={cn(
            "flex items-center gap-3",
            usesDesktopChrome && MACOS_APP_REGION_NO_DRAG_CLASS,
          )}
        >
          <span className="text-sm font-medium">Arc Voice</span>
          <span
            data-voice-mode-agent=""
            className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
          >
            <Icon name="Bot" className="size-3" aria-hidden />
            {agentLabel}
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Exit voice mode"
          onClick={handleExit}
          className={usesDesktopChrome ? MACOS_APP_REGION_NO_DRAG_CLASS : undefined}
        >
          <Icon name="Close" className="size-4" aria-hidden />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 lg:flex-row">
        <div
          data-voice-mode-stage=""
          className="flex shrink-0 flex-col items-center justify-center gap-3 lg:w-96"
        >
          <canvas
            ref={canvasRef}
            width={320}
            height={320}
            data-voice-mode-ring=""
            className="size-72 max-h-[40vh]"
            aria-hidden
          />
          <p
            data-voice-mode-state=""
            className="text-sm text-muted-foreground"
            role="status"
          >
            {STATE_LABELS[state.kind] ?? state.kind}
          </p>
          {state.kind === "error" ? (
            <div className="flex flex-col items-center gap-2">
              <p className="max-w-64 text-center text-xs text-destructive">
                {state.message}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  acknowledgeError();
                  begin();
                }}
              >
                Dismiss
              </Button>
            </div>
          ) : null}
          <div
            data-voice-mode-controls=""
            className="flex items-center gap-3 pt-2"
          >
            {state.kind === "listening" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label="End utterance"
                onClick={endUtterance}
              >
                <Icon name="Mic" className="size-3.5" aria-hidden />
                Done
              </Button>
            ) : null}
            <select
              aria-label="Voice response detail"
              value={detail}
              onChange={(event) => {
                setDetail(event.target.value as VoiceResponseDetail);
              }}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
              hidden={state.kind === "error"}
            >
              {DETAIL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleExit}
            >
              Stop / Exit
            </Button>
          </div>
        </div>

        <div
          data-voice-mode-answers=""
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain rounded-xl border border-border bg-background"
        >
          <ThreadTimelineSurface
            threadId={threadId}
            projectId={projectId}
            timelineRows={timeline.data?.rows ?? []}
            isThreadTimelinePending={timeline.isPending}
            timelineError={timeline.isError}
            threadRuntimeDisplayStatus={
              thread?.runtime?.displayStatus ?? "idle"
            }
            activeThinking={null}
            contextBoundarySeq={null}
            workspaceRootPath={undefined}
            autoSpeakRepliesOverride={false}
            showOngoingIndicator
          />
        </div>
      </div>
    </div>
  );
}
