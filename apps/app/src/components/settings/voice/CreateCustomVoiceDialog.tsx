import { useEffect, useMemo, useState } from "react";
import { Button } from "@bb/shared-ui/button";
import { Checkbox } from "@bb/shared-ui/checkbox";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { Textarea } from "@bb/shared-ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import type {
  SystemVoiceCapabilitiesResponse,
  SystemVoiceProfile,
} from "@bb/server-contract";
import {
  canAdvanceFromStep,
  useCustomVoiceWizard,
} from "./custom-voice-wizard";
import { useVoiceSampleRecorder } from "./use-voice-sample-recorder";
import {
  CLONED_VOICE_ENGINE,
  findClonedVoiceEngineCaps,
  resolveClonedVoiceModel,
} from "./voice-models";
import { VoiceModelDownloadControl } from "./VoiceModelDownloadControl";
import { VOICE_PREVIEW_PHRASE, type VoicePreviewApi } from "./use-voice-preview";

const MAX_SAMPLE_BYTES = 25 * 1024 * 1024;

const STEP_ORDER = ["consent", "sample", "reference", "create"] as const;

function stepIndex(step: string): number {
  return STEP_ORDER.indexOf(step as (typeof STEP_ORDER)[number]);
}

interface CreateCustomVoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  capabilities: SystemVoiceCapabilitiesResponse;
  preview: VoicePreviewApi;
  playbackSpeed: number;
  onComplete: (profile: SystemVoiceProfile) => void;
  onDownloadModel: (modelName: string) => void;
  onCancelModel: (modelName: string) => void;
}

export function CreateCustomVoiceDialog({
  open,
  onOpenChange,
  capabilities,
  preview,
  playbackSpeed,
  onComplete,
  onDownloadModel,
  onCancelModel,
}: CreateCustomVoiceDialogProps) {
  const { state, dispatch, advance, goBack, submit } = useCustomVoiceWizard();
  const recorder = useVoiceSampleRecorder();
  const [uploadError, setUploadError] = useState<string | null>(null);

  const clonedCaps = findClonedVoiceEngineCaps(capabilities);
  const clonedModel =
    clonedCaps === undefined ? null : (resolveClonedVoiceModel(clonedCaps) ?? null);
  const qwenReady =
    clonedCaps === undefined || (clonedModel?.downloaded ?? false);
  const qwenModel =
    clonedCaps === undefined || clonedModel === undefined ? null : clonedModel;

  useEffect(() => {
    if (!open) {
      dispatch({ type: "reset" });
      recorder.reset();
      setUploadError(null);
    }
  }, [open, dispatch, recorder]);

  useEffect(() => {
    if (recorder.file !== null) {
      dispatch({ type: "setSample", file: recorder.file });
    }
  }, [recorder.file, dispatch]);

  const sampleObjectUrl = useMemo(() => {
    if (state.sample === null) {
      return null;
    }
    return URL.createObjectURL(state.sample);
  }, [state.sample]);

  useEffect(
    () => () => {
      if (sampleObjectUrl !== null) {
        URL.revokeObjectURL(sampleObjectUrl);
      }
    },
    [sampleObjectUrl],
  );

  const createdKey =
    state.createdProfile !== null ? `created:${state.createdProfile.id}` : null;
  const createdPreviewing =
    createdKey !== null &&
    preview.activeKey === createdKey &&
    preview.phase !== "idle";

  const title =
    state.step === "consent"
      ? "Create custom voice"
      : state.step === "sample"
        ? "Add a voice sample"
        : state.step === "reference"
          ? "Review reference text"
          : "Name and create";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Step {stepIndex(state.step) + 1} of {STEP_ORDER.length}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {state.step === "consent" ? (
            <div className="space-y-3">
              <label className="flex items-start gap-3">
                <Checkbox
                  checked={state.consented}
                  onCheckedChange={(value) =>
                    dispatch({ type: "setConsented", value: value === true })
                  }
                />
                <span className="text-sm leading-snug text-foreground">
                  I own this voice or have permission to use this voice sample.
                </span>
              </label>
              <p className="text-xs text-subtle-foreground">
                Your sample stays local on this device.
              </p>
            </div>
          ) : null}

          {state.step === "sample" ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Button
                    variant={recorder.isRecording ? "destructive" : "outline"}
                    size="sm"
                    onClick={() => {
                      if (recorder.isRecording) {
                        recorder.stop();
                      } else {
                        void recorder.start();
                      }
                    }}
                    disabled={recorder.isProcessing}
                  >
                    <Icon name="Mic" className="size-3.5" />
                    {recorder.isRecording ? "Stop recording" : "Record"}
                  </Button>
                  {recorder.isProcessing ? (
                    <span className="text-xs text-subtle-foreground">
                      Converting…
                    </span>
                  ) : null}
                  {recorder.errorMessage !== null ? (
                    <span className="text-xs text-destructive">
                      {recorder.errorMessage}
                    </span>
                  ) : null}
                </div>
                <p className="text-xs text-subtle-foreground">
                  Record 10–30 seconds of clear speech in a quiet room.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs text-subtle-foreground">or</span>
                <input
                  type="file"
                  accept="audio/wav,.wav"
                  onChange={(event) => {
                    const selected = event.target.files?.[0] ?? null;
                    setUploadError(null);
                    if (selected === null) {
                      return;
                    }
                    if (selected.size > MAX_SAMPLE_BYTES) {
                      setUploadError(
                        "Voice sample must be 25 MB or smaller.",
                      );
                      return;
                    }
                    recorder.reset();
                    dispatch({ type: "setSample", file: selected });
                  }}
                />
                <span className="text-xs text-subtle-foreground">.wav</span>
              </div>
              {uploadError !== null ? (
                <p className="text-xs text-destructive">{uploadError}</p>
              ) : null}

              {state.sample !== null && sampleObjectUrl !== null ? (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-foreground">
                    Captured sample
                  </p>
                  <audio controls src={sampleObjectUrl} className="w-full" />
                </div>
              ) : null}
            </div>
          ) : null}

          {state.step === "reference" ? (
            <div className="space-y-2">
              <p className="text-xs text-subtle-foreground">
                Review and correct the transcript of your sample. This is the
                text the voice reads during cloning.
              </p>
              {state.transcriptState === "loading" ? (
                <p className="text-xs text-subtle-foreground">
                  Transcribing sample…
                </p>
              ) : null}
              <Textarea
                value={state.referenceText}
                onChange={(event) =>
                  dispatch({ type: "setReference", value: event.target.value })
                }
                placeholder="Reference text"
                rows={5}
              />
            </div>
          ) : null}

          {state.step === "create" ? (
            <div className="space-y-3">
              <Input
                value={state.name}
                onChange={(event) =>
                  dispatch({ type: "setName", value: event.target.value })
                }
                placeholder="Voice name"
                aria-label="Voice name"
              />
              {state.error !== null ? (
                <p className="text-xs text-destructive">{state.error}</p>
              ) : null}
              {state.createdProfile === null ? (
                <Button
                  disabled={!state.name.trim() || state.submitting}
                  onClick={() => void submit()}
                >
                  {state.submitting ? "Creating…" : "Create voice"}
                </Button>
              ) : !qwenReady && qwenModel !== null ? (
                <div className="space-y-2">
                  <p className="text-xs text-subtle-foreground">
                    {qwenModel.displayName} is required to use this voice.
                  </p>
                  <VoiceModelDownloadControl
                    modelName={qwenModel.name}
                    downloading={qwenModel.downloading}
                    downloadPercent={qwenModel.downloadPercent}
                    onDownload={() => onDownloadModel(qwenModel.name)}
                    onCancel={() => onCancelModel(qwenModel.name)}
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  {state.error !== null ? (
                    <div className="flex items-center gap-2">
                      <p className="text-xs text-destructive">
                        The voice was created, but the sample could not be
                        added.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={state.submitting}
                        onClick={() => void submit()}
                      >
                        {state.submitting ? "Retrying…" : "Retry add sample"}
                      </Button>
                    </div>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!qwenReady}
                      onClick={() => {
                        if (state.createdProfile === null) {
                          return;
                        }
                        if (createdPreviewing) {
                          preview.stop();
                          return;
                        }
                        preview.start(
                          {
                            key: createdKey ?? "",
                            text: VOICE_PREVIEW_PHRASE,
                            engine: CLONED_VOICE_ENGINE,
                            profile: state.createdProfile.name,
                          },
                          playbackSpeed,
                        );
                      }}
                    >
                      <Icon
                        name={createdPreviewing ? "Square" : "Play"}
                        className="size-3.5"
                      />
                      {createdPreviewing ? "Stop" : "Preview"}
                    </Button>
                    <Button
                      disabled={!qwenReady || state.error !== null}
                      onClick={() => {
                        if (state.createdProfile !== null) {
                          onComplete(state.createdProfile);
                        }
                      }}
                    >
                      Save voice
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          {state.step !== "consent" && state.createdProfile === null ? (
            <Button variant="ghost" onClick={goBack}>
              Back
            </Button>
          ) : null}
          {state.step !== "create" ? (
            <Button disabled={!canAdvanceFromStep(state)} onClick={advance}>
              {state.step === "consent" ? "Next" : "Continue"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
