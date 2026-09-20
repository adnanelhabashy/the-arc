import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readArcRuntimeManifest } from "./manifest.js";
import type { ArcRuntimePaths } from "./paths.js";
import {
  ARC_RUNTIME_IDS,
  type ArcActiveRuntime,
  type ArcRuntimeId,
} from "./types.js";

export const BB_CLAUDE_CODE_EXECUTABLE_ENV = "BB_CLAUDE_CODE_EXECUTABLE";
export const BB_CODEX_APP_SERVER_COMMAND_ENV =
  "BB_CODEX_BRIDGE_APP_SERVER_COMMAND";
export const BB_OMP_EXECUTABLE_ENV = "BB_OMP_EXECUTABLE";

// Arc-mode declaration for the spawned bb server: the arc-core plugin reads
// these to host the Arc agents/accounts/usage services. Set only on the
// Arc-owned child environment; standalone bb servers never see them.
export const BB_ARC_RUNTIME_ROOT_ENV = "BB_ARC_RUNTIME_ROOT";
export const BB_ARC_APP_VERSION_ENV = "BB_ARC_APP_VERSION";
export const BB_ARC_SEED_ROOT_ENV = "BB_ARC_SEED_ROOT";

// Verified against oh-my-pi v18.2.6 packages/utils/src/dirs.ts:
// PI_CONFIG_DIR relocates the OMP user config root (joined under the process
// home directory); PI_CODING_AGENT_DIR absolutely overrides the OMP agent dir
// (settings, auth storage, sessions) for the default profile.
export const OMP_CONFIG_DIR_ENV = "PI_CONFIG_DIR";
export const OMP_CODING_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

// Verified against Anthropic's Claude Code installation docs: these env vars
// disable background auto-updates for the Claude process that sees them
// (`claude doctor` reports "disabled (set by env: DISABLE_UPDATES)"). They are
// set only on Arc's owned child environment; the user's independent Claude
// installations keep their own update policy.
export const CLAUDE_DISABLE_AUTOUPDATER_ENV = "DISABLE_AUTOUPDATER";
export const CLAUDE_DISABLE_UPDATES_ENV = "DISABLE_UPDATES";

const PATH_PRECEDENCE: readonly ArcRuntimeId[] = [
  "codex",
  "omp",
  "claude-code",
];

export interface ResolveActiveArcRuntimesArgs {
  createdByArcVersion: string;
  onDiagnostic?: (message: string) => void;
  platform: string;
  runtimePaths: ArcRuntimePaths;
}

export interface BuildArcManagedRuntimeEnvironmentArgs {
  env: NodeJS.ProcessEnv;
  homeDirectory?: string;
  platform: NodeJS.Platform;
  runtimePaths: ArcRuntimePaths;
  activeRuntimes: readonly ArcActiveRuntime[];
  // Arc-mode declaration for the spawned server (arc-core plugin). Omit for
  // non-Arc consumers of the managed runtime environment.
  arcAppVersion?: string;
  arcSeedRoot?: string;
}

async function isRunnableExecutable(
  path: string,
  isWindows: boolean,
): Promise<boolean> {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) {
      return false;
    }
    if (isWindows) {
      return true;
    }
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveActiveArcRuntimes(
  args: ResolveActiveArcRuntimesArgs,
): Promise<ArcActiveRuntime[]> {
  const manifestResult = await readArcRuntimeManifest({
    createdByArcVersion: args.createdByArcVersion,
    manifestPath: args.runtimePaths.manifestPath,
    platform: args.platform,
  });

  if (manifestResult.kind === "unsupported-version") {
    args.onDiagnostic?.(
      `[arc-runtime] manifest ${manifestResult.manifestPath} declares unsupported schema version ${manifestResult.schemaVersion}; ignoring Arc-managed runtimes`,
    );
    return [];
  }
  if (manifestResult.kind === "invalid") {
    args.onDiagnostic?.(
      `[arc-runtime] ${manifestResult.problem} at ${args.runtimePaths.manifestPath}; ignoring Arc-managed runtimes`,
    );
  }

  const isWindows = args.platform.startsWith("win32");
  const activeRuntimes: ArcActiveRuntime[] = [];
  for (const id of ARC_RUNTIME_IDS) {
    const activeVersion = manifestResult.manifest.runtimes[id].activeVersion;
    if (activeVersion === null) {
      continue;
    }
    const executablePath = args.runtimePaths.executablePath(
      id,
      activeVersion,
    );
    if (!(await isRunnableExecutable(executablePath, isWindows))) {
      args.onDiagnostic?.(
        `[arc-runtime] manifest activates ${id} ${activeVersion} but ${executablePath} is missing or not executable; treating as stale`,
      );
      continue;
    }
    activeRuntimes.push({ id, executablePath });
  }
  return activeRuntimes;
}

export function buildArcManagedRuntimeEnvironment(
  args: BuildArcManagedRuntimeEnvironmentArgs,
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...args.env };
  const delimiter = args.platform === "win32" ? ";" : ":";
  const pathKey = args.platform === "win32" ? "Path" : "PATH";

  const activeById = new Map<ArcRuntimeId, ArcActiveRuntime>();
  for (const runtime of args.activeRuntimes) {
    if (runtime.executablePath.trim().length === 0) {
      continue;
    }
    if (!activeById.has(runtime.id)) {
      activeById.set(runtime.id, runtime);
    }
  }

  const prependDirectories: string[] = [];
  const seenDirectories = new Set<string>();
  for (const id of PATH_PRECEDENCE) {
    const runtime = activeById.get(id);
    if (runtime === undefined) {
      continue;
    }
    const directory = dirname(resolve(runtime.executablePath));
    if (seenDirectories.has(directory)) {
      continue;
    }
    seenDirectories.add(directory);
    prependDirectories.push(directory);
  }

  if (prependDirectories.length > 0) {
    const originalPath = nextEnv[pathKey];
    const originalEntries =
      originalPath === undefined
        ? []
        : originalPath
            .split(delimiter)
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);
    const originalEntryKeys = new Set(
      originalEntries.map((entry) => entry),
    );
    const additions = prependDirectories.filter(
      (directory) => !originalEntryKeys.has(directory),
    );
    if (additions.length > 0) {
      nextEnv[pathKey] = [...additions, ...originalEntries].join(delimiter);
    }
  }

  const activeCodex = activeById.get("codex");
  if (activeCodex !== undefined) {
    nextEnv[BB_CODEX_APP_SERVER_COMMAND_ENV] = resolve(
      activeCodex.executablePath,
    );
  }

  const activeClaude = activeById.get("claude-code");
  if (activeClaude !== undefined) {
    nextEnv[BB_CLAUDE_CODE_EXECUTABLE_ENV] = resolve(
      activeClaude.executablePath,
    );
    // Arc decides when its managed Claude updates (Phase 11); the Arc-owned
    // provider process must not self-mutate underneath the manifest. The
    // user's independent Claude installs never see these variables.
    nextEnv[CLAUDE_DISABLE_AUTOUPDATER_ENV] = "1";
    nextEnv[CLAUDE_DISABLE_UPDATES_ENV] = "1";
  }

  const activeOmp = activeById.get("omp");
  if (activeOmp !== undefined) {
    nextEnv[BB_OMP_EXECUTABLE_ENV] = resolve(activeOmp.executablePath);
    applyArcOmpStateIsolation({
      env: nextEnv,
      homeDirectory: args.homeDirectory ?? homedir(),
      userDataPath: dirname(args.runtimePaths.root),
    });
  }

  // Arc-mode declaration for the spawned server. runtimePaths.root is
  // <userData>/arc-runtime, so its parent is the Arc runtime root the
  // arc-core plugin resolves managed runtimes from.
  nextEnv[BB_ARC_RUNTIME_ROOT_ENV] = dirname(args.runtimePaths.root);
  if (args.arcAppVersion !== undefined) {
    nextEnv[BB_ARC_APP_VERSION_ENV] = args.arcAppVersion;
  }
  if (args.arcSeedRoot !== undefined) {
    nextEnv[BB_ARC_SEED_ROOT_ENV] = args.arcSeedRoot;
  }

  return nextEnv;
}

// Give Arc's managed OMP a private state root (<userData>/omp) so it never
// reads or writes the user's standalone ~/.omp installation. The variables are
// set only on Arc's owned child environment; shells and external OMP are
// unaffected. Both names are verified overrides in oh-my-pi v18.2.6
// (packages/utils/src/dirs.ts); no invented OMP_* variables are used.
function applyArcOmpStateIsolation(args: {
  env: NodeJS.ProcessEnv;
  homeDirectory: string;
  userDataPath: string;
}): void {
  const ompStateRoot = join(args.userDataPath, "omp");
  args.env[OMP_CODING_AGENT_DIR_ENV] = join(ompStateRoot, "agent");
  const relativeConfigDir = relative(args.homeDirectory, ompStateRoot);
  if (
    relativeConfigDir.length > 0 &&
    !relativeConfigDir.startsWith("..") &&
    !isAbsolute(relativeConfigDir)
  ) {
    args.env[OMP_CONFIG_DIR_ENV] = relativeConfigDir;
  }
}
