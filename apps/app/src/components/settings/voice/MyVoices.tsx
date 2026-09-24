import { useMemo, useState } from "react";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { Textarea } from "@bb/shared-ui/textarea";
import { cn } from "@bb/shared-ui/lib/utils";
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
import { SettingsSection } from "@/components/ui/settings-section";
import { isProfileSelected, type VoiceTtsSettings } from "./voice-selection";
import { voiceLanguageLabel } from "./voice-language";
import {
  findClonedVoiceEngineCaps,
  resolveClonedVoiceModel,
} from "./voice-models";
import { VoiceModelDownloadControl } from "./VoiceModelDownloadControl";
import { VOICE_PREVIEW_PHRASE, type VoicePreviewApi } from "./use-voice-preview";

const MAX_SAMPLE_BYTES = 25 * 1024 * 1024;

interface MyVoicesProps {
  capabilities: SystemVoiceCapabilitiesResponse;
  profiles: SystemVoiceProfile[];
  tts: VoiceTtsSettings;
  preview: VoicePreviewApi;
  playbackSpeed: number;
  onCreate: () => void;
  onSelectProfile: (profileId: string) => void;
  onRename: (profileId: string, name: string) => void;
  onAddSample: (profileId: string, file: File, referenceText: string) => void;
  onDelete: (profileId: string) => void;
  onDownloadModel: (modelName: string) => void;
  onCancelModel: (modelName: string) => void;
}

function qwenCustomEngineCaps(
  capabilities: SystemVoiceCapabilitiesResponse,
) {
  return findClonedVoiceEngineCaps(capabilities);
}

function AddSampleDialog({
  open,
  onOpenChange,
  onAddSample,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddSample: (file: File, referenceText: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [referenceText, setReferenceText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const canSubmit = file !== null && referenceText.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add voice sample</DialogTitle>
          <DialogDescription>
            Choose a WAV recording of the voice (up to 25 MB).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <input
            type="file"
            accept="audio/wav,.wav"
            onChange={(event) => {
              const selected = event.target.files?.[0] ?? null;
              setError(null);
              if (selected === null) {
                setFile(null);
                return;
              }
              if (selected.size > MAX_SAMPLE_BYTES) {
                setError("Voice sample must be 25 MB or smaller.");
                setFile(null);
                return;
              }
              setFile(selected);
            }}
          />
          {error !== null ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : null}
          <Textarea
            value={referenceText}
            onChange={(event) => setReferenceText(event.target.value)}
            placeholder="Reference text (what is spoken in this sample)"
            rows={4}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!canSubmit}
            onClick={() => {
              if (file !== null) {
                onAddSample(file, referenceText.trim());
              }
            }}
          >
            Add sample
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MyVoices({
  capabilities,
  profiles,
  tts,
  preview,
  playbackSpeed,
  onCreate,
  onSelectProfile,
  onRename,
  onAddSample,
  onDelete,
  onDownloadModel,
  onCancelModel,
}: MyVoicesProps) {
  const cloned = useMemo(
    () => profiles.filter((profile) => profile.voiceType === "cloned"),
    [profiles],
  );
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [addingSampleId, setAddingSampleId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const qwenCaps = qwenCustomEngineCaps(capabilities);
  const qwenModel =
    qwenCaps === undefined ? null : (resolveClonedVoiceModel(qwenCaps) ?? null);
  const qwenReady =
    qwenCaps === undefined || (qwenModel?.downloaded ?? false);

  return (
    <SettingsSection
      title="My Voices"
      description="Custom voices cloned from your own recordings."
      action={
        <Button variant="outline" size="sm" onClick={onCreate}>
          <Icon name="Plus" className="size-3.5" />
          Create custom voice
        </Button>
      }
    >
      <div className="space-y-3">
        {!qwenReady && qwenModel !== null ? (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface-recessed px-3 py-2">
            <span className="text-xs text-subtle-foreground">
              {qwenModel.displayName} is required to use custom voices.
            </span>
            <VoiceModelDownloadControl
              modelName={qwenModel.name}
              downloading={qwenModel.downloading}
              downloadPercent={qwenModel.downloadPercent}
              onDownload={() => onDownloadModel(qwenModel.name)}
              onCancel={() => onCancelModel(qwenModel.name)}
            />
          </div>
        ) : null}
        {cloned.length === 0 ? (
          <p className="text-sm text-subtle-foreground">
            No custom voices yet. Create one to clone your own voice.
          </p>
        ) : (
          cloned.map((profile) => {
            const key = `profile:${profile.id}`;
            const previewing =
              preview.activeKey === key && preview.phase !== "idle";
            const selected = isProfileSelected(tts, profile.id);
            const renaming = renamingId === profile.id;
            return (
              <div
                key={profile.id}
                className={cn(
                  "flex flex-col gap-2 rounded-lg border p-3",
                  selected
                    ? "border-foreground/40 bg-surface"
                    : "border-border bg-surface-recessed",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    {renaming ? (
                      <form
                        className="flex items-center gap-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const next = renameValue.trim();
                          if (next.length > 0) {
                            onRename(profile.id, next);
                          }
                          setRenamingId(null);
                        }}
                      >
                        <Input
                          autoFocus
                          value={renameValue}
                          onChange={(event) => setRenameValue(event.target.value)}
                          aria-label="Voice name"
                          className="h-7 text-sm"
                        />
                        <Button type="submit" size="sm">
                          Save
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setRenamingId(null)}
                        >
                          Cancel
                        </Button>
                      </form>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onSelectProfile(profile.id)}
                        className="flex items-center gap-2 text-left"
                        aria-pressed={selected}
                      >
                        <span className="truncate text-sm font-medium text-foreground">
                          {profile.name}
                        </span>
                        <span className="shrink-0 rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-2xs leading-none text-subtle-foreground">
                          Custom Voice
                        </span>
                        <Icon
                          name="Check"
                          className={cn(
                            "size-4 text-foreground",
                            !selected && "opacity-0",
                          )}
                        />
                      </button>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!qwenReady}
                      onClick={() => {
                        if (previewing) {
                          preview.stop();
                          return;
                        }
                        preview.start(
                          {
                            key,
                            text: VOICE_PREVIEW_PHRASE,
                            engine: "qwen",
                            profile: profile.name,
                          },
                          playbackSpeed,
                        );
                      }}
                    >
                      <Icon
                        name={previewing ? "Square" : "Play"}
                        className="size-3.5"
                      />
                      {previewing ? "Stop" : "Preview"}
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-subtle-foreground">
                  <span className="rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-2xs leading-none">
                    {voiceLanguageLabel(profile.language)}
                  </span>
                  <span>{profile.sampleCount} samples</span>
                  {selected ? (
                    <span className="text-foreground">Default voice</span>
                  ) : (
                    <button
                      type="button"
                      className="text-foreground underline-offset-4 hover:underline"
                      onClick={() => onSelectProfile(profile.id)}
                    >
                      Set as default
                    </button>
                  )}
                  <button
                    type="button"
                    className="text-foreground underline-offset-4 hover:underline"
                    onClick={() => {
                      setRenamingId(profile.id);
                      setRenameValue(profile.name);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="text-foreground underline-offset-4 hover:underline"
                    onClick={() => setAddingSampleId(profile.id)}
                  >
                    Add sample
                  </button>
                  <button
                    type="button"
                    className="text-destructive underline-offset-4 hover:underline"
                    onClick={() => setDeletingId(profile.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <AddSampleDialog
        open={addingSampleId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAddingSampleId(null);
          }
        }}
        onAddSample={(file, referenceText) => {
          const profileId = addingSampleId;
          if (profileId === null) {
            return;
          }
          onAddSample(profileId, file, referenceText);
          setAddingSampleId(null);
        }}
      />

      <Dialog
        open={deletingId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeletingId(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete custom voice?</DialogTitle>
            <DialogDescription>
              This removes the voice and its samples from this device. This
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deletingId !== null) {
                  onDelete(deletingId);
                }
                setDeletingId(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}
