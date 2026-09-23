import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARC_VOICEBOX_RELEASE,
  stageArcVoiceboxSeed,
} from "bb-arc-voice-host";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultStagedResourcesRoot = resolve(
  scriptDirectory,
  "..",
  "resources",
  "arc-runtimes",
);

export interface ArcVoiceSeedArgs {
  stagedResourcesRoot: string;
  artifactPath: string | null;
}

export function parseVoiceSeedArgs(argv: readonly string[]): ArcVoiceSeedArgs {
  const parsed: { stagedResourcesRoot?: string; artifactPath?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--resources" && value !== undefined) {
      parsed.stagedResourcesRoot = resolve(value);
      index += 1;
    } else if (flag === "--artifact" && value !== undefined) {
      parsed.artifactPath = resolve(value);
      index += 1;
    } else if (flag !== undefined && flag.startsWith("--")) {
      throw new Error(`unknown argument ${flag}`);
    }
  }
  return {
    stagedResourcesRoot:
      parsed.stagedResourcesRoot ?? defaultStagedResourcesRoot,
    artifactPath: parsed.artifactPath ?? null,
  };
}

export async function main(
  args: ArcVoiceSeedArgs = {
    stagedResourcesRoot: defaultStagedResourcesRoot,
    artifactPath: null,
  },
): Promise<void> {
  if (args.artifactPath === null) {
    console.log(
      `[arc-voice] no --artifact supplied; skipping the voicebox ${ARC_VOICEBOX_RELEASE.version} seed (Arc packages only a pinned, verified component)`,
    );
    return;
  }
  const result = await stageArcVoiceboxSeed({
    release: ARC_VOICEBOX_RELEASE,
    artifactPath: args.artifactPath,
    stagedResourcesRoot: args.stagedResourcesRoot,
  });
  if (result.kind === "skipped") {
    console.log(
      `[arc-voice] skipping voicebox ${ARC_VOICEBOX_RELEASE.version}: ${result.reason}`,
    );
    return;
  }
  if (result.kind === "complete") {
    console.log(
      `[arc-voice] voicebox ${ARC_VOICEBOX_RELEASE.version} seed already staged and verified (${ARC_VOICEBOX_RELEASE.componentFileName}); skipping`,
    );
    return;
  }
  console.log(
    `[arc-voice] staged verified voicebox ${result.version} component at ${result.seedPath} (digest ${result.digest})`,
  );
}

const invokedPath =
  process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && import.meta.url === `file://${invokedPath}`) {
  await main(parseVoiceSeedArgs(process.argv.slice(2))).catch(
    (error: unknown) => {
      console.error(
        `[arc-voice] FAILED: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    },
  );
}
