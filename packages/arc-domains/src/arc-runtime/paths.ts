import { join } from "node:path";
import type { ArcRuntimeId } from "./types.js";

const ARC_RUNTIME_ROOT_DIR_NAME = "arc-runtimes";
const RUNTIME_MANIFEST_FILE_NAME = "runtime-manifest.json";
const RUNTIME_STAGING_DIR_NAME = "staging";
const RUNTIME_FAMILIES_DIR_NAME = "runtimes";

const ARC_RUNTIME_EXECUTABLE_NAMES: Record<ArcRuntimeId, string> = {
  codex: "codex",
  "claude-code": "claude",
  omp: "omp",
};

export function arcRuntimeExecutableName(id: ArcRuntimeId): string {
  return ARC_RUNTIME_EXECUTABLE_NAMES[id];
}

export interface CreateArcRuntimePathsArgs {
  userDataPath: string;
}

export interface ArcRuntimePaths {
  root: string;
  manifestPath: string;
  stagingRoot: string;
  runtimeRoot: (id: ArcRuntimeId) => string;
  versionRoot: (id: ArcRuntimeId, version: string) => string;
  executablePath: (id: ArcRuntimeId, version: string) => string;
}

export function createArcRuntimePaths(
  args: CreateArcRuntimePathsArgs,
): ArcRuntimePaths {
  const root = join(args.userDataPath, ARC_RUNTIME_ROOT_DIR_NAME);
  const familiesRoot = join(root, RUNTIME_FAMILIES_DIR_NAME);

  return {
    root,
    manifestPath: join(root, RUNTIME_MANIFEST_FILE_NAME),
    stagingRoot: join(root, RUNTIME_STAGING_DIR_NAME),
    runtimeRoot: (id) => join(familiesRoot, id),
    versionRoot: (id, version) => join(familiesRoot, id, version),
    executablePath: (id, version) =>
      join(familiesRoot, id, version, arcRuntimeExecutableName(id)),
  };
}
