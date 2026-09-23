export type ArcVoiceBackend =
  | "mlx"
  | "cuda"
  | "xpu"
  | "directml"
  | "rocm"
  | "cpu";

export const ARC_VOICE_BACKENDS: readonly ArcVoiceBackend[] = [
  "mlx",
  "cuda",
  "xpu",
  "directml",
  "rocm",
  "cpu",
];

export type ArcVoiceGpuVendor = "apple" | "nvidia" | "intel" | "amd" | "other";

export type ArcVoiceRuntimeState =
  | "not-installed"
  | "stopped"
  | "starting"
  | "ready"
  | "updating"
  | "repairing"
  | "failed";

export interface ArcVoiceRuntimeStatus {
  state: ArcVoiceRuntimeState;
  pid?: number;
  lastError?: string;
}
