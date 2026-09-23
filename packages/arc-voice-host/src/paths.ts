import { join } from "node:path";

export const VOICEBOX_RUNTIME_DIR_NAME = "voicebox";
export const VOICEBOX_EXECUTABLE_NAME = "voicebox-server";

const ARC_RUNTIME_ROOT_DIR_NAME = "arc-runtimes";
const VOICE_DIR_NAME = "voice";

export interface CreateArcVoicePathsArgs {
  userDataPath: string;
}

export interface ArcVoicePaths {
  runtimeRoot: string;
  activeRoot: string;
  previousRoot: string;
  stagingRoot: string;
  stagingVersionRoot: (version: string) => string;
  rolledBackStagingPath: (version: string) => string;
  manifestPath: string;
  executablePath: string;
  voiceRoot: string;
  modelsRoot: string;
  profilesRoot: string;
  capturesRoot: string;
  tempRoot: string;
  stateRoot: string;
  dataDir: string;
}

export function createArcVoicePaths(
  args: CreateArcVoicePathsArgs,
): ArcVoicePaths {
  const runtimeRoot = join(
    args.userDataPath,
    ARC_RUNTIME_ROOT_DIR_NAME,
    VOICEBOX_RUNTIME_DIR_NAME,
  );
  const voiceRoot = join(args.userDataPath, VOICE_DIR_NAME);
  const stagingRoot = join(runtimeRoot, "staging");
  return {
    runtimeRoot,
    activeRoot: join(runtimeRoot, "active"),
    previousRoot: join(runtimeRoot, "previous"),
    stagingRoot,
    stagingVersionRoot: (version) => join(stagingRoot, version),
    rolledBackStagingPath: (version) =>
      join(stagingRoot, `rolled-back-${version}`),
    manifestPath: join(runtimeRoot, "runtime-manifest.json"),
    executablePath: join(runtimeRoot, "active", VOICEBOX_EXECUTABLE_NAME),
    voiceRoot,
    modelsRoot: join(voiceRoot, "models"),
    profilesRoot: join(voiceRoot, "profiles"),
    capturesRoot: join(voiceRoot, "captures"),
    tempRoot: join(voiceRoot, "temp"),
    stateRoot: join(voiceRoot, "state"),
    dataDir: join(voiceRoot, "state", VOICEBOX_RUNTIME_DIR_NAME),
  };
}
