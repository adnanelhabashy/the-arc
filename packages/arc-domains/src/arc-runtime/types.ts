export type ArcRuntimeId = "codex" | "claude-code" | "omp";

export const ARC_RUNTIME_IDS: readonly ArcRuntimeId[] = [
  "codex",
  "claude-code",
  "omp",
];

export type ArcRuntimeSource =
  | "arc-bundled"
  | "arc-managed-download"
  | "official-managed-install"
  | "external-override";

export type ArcRuntimeCompatibility = "supported" | "untested" | "blocked";

export interface ArcActiveRuntime {
  id: ArcRuntimeId;
  executablePath: string;
}
