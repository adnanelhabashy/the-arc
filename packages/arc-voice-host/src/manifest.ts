import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

export const VOICE_RUNTIME_MANIFEST_SCHEMA_VERSION = 1;

export const ARC_VOICEBOX_HEALTH_STATES = [
  "unknown",
  "healthy",
  "unhealthy",
] as const;

export type ArcVoiceboxHealthState =
  (typeof ARC_VOICEBOX_HEALTH_STATES)[number];

export const ARC_VOICE_RUNTIME_SOURCES = [
  "arc-bundled",
  "arc-managed-download",
  "official-managed-install",
  "external-override",
] as const;

export type ArcVoiceRuntimeSource =
  (typeof ARC_VOICE_RUNTIME_SOURCES)[number];

export const voiceRuntimeManifestSchema = z.object({
  schemaVersion: z.literal(VOICE_RUNTIME_MANIFEST_SCHEMA_VERSION),
  runtimeId: z.literal("voicebox"),
  createdByArcVersion: z.string().min(1),
  platform: z.string().min(1),
  arch: z.string().min(1),
  activeVersion: z.string().min(1).nullable(),
  previousVersion: z.string().min(1).nullable(),
  knownGoodVersion: z.string().min(1).nullable(),
  source: z.enum(ARC_VOICE_RUNTIME_SOURCES).nullable(),
  installPath: z.string().min(1).nullable(),
  digest: z.string().min(1).nullable(),
  digestsByVersion: z.record(z.string().min(1), z.string().min(1)),
  installedAt: z.number().int().nonnegative().nullable(),
  healthState: z.enum(ARC_VOICEBOX_HEALTH_STATES),
});

export type VoiceRuntimeManifest = z.infer<typeof voiceRuntimeManifestSchema>;

export type VoiceRuntimeManifestSource = NonNullable<
  VoiceRuntimeManifest["source"]
>;

export interface CreateEmptyVoiceRuntimeManifestArgs {
  createdByArcVersion: string;
  platform: string;
  arch: string;
}

export function createEmptyVoiceRuntimeManifest(
  args: CreateEmptyVoiceRuntimeManifestArgs,
): VoiceRuntimeManifest {
  return {
    schemaVersion: VOICE_RUNTIME_MANIFEST_SCHEMA_VERSION,
    runtimeId: "voicebox",
    createdByArcVersion: args.createdByArcVersion,
    platform: args.platform,
    arch: args.arch,
    activeVersion: null,
    previousVersion: null,
    knownGoodVersion: null,
    source: null,
    installPath: null,
    digest: null,
    digestsByVersion: {},
    installedAt: null,
    healthState: "unknown",
  };
}

export type VoiceRuntimeManifestReadResult =
  | { kind: "ok"; manifest: VoiceRuntimeManifest }
  | { kind: "missing" }
  | { kind: "invalid"; problem: string };

export interface ReadVoiceRuntimeManifestArgs {
  manifestPath: string;
  createdByArcVersion: string;
  platform: string;
  arch: string;
}

export async function readVoiceRuntimeManifest(
  args: ReadVoiceRuntimeManifestArgs,
): Promise<VoiceRuntimeManifestReadResult> {
  let raw: string;
  try {
    raw = await readFile(args.manifestPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { kind: "missing" };
    }
    return {
      kind: "invalid",
      problem: `voice runtime manifest could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    return {
      kind: "invalid",
      problem: `voice runtime manifest is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const parsed = voiceRuntimeManifestSchema.safeParse(parsedJson);
  return parsed.success
    ? { kind: "ok", manifest: parsed.data }
    : {
        kind: "invalid",
        problem: `voice runtime manifest does not match schema ${VOICE_RUNTIME_MANIFEST_SCHEMA_VERSION}: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
      };
}

export interface WriteVoiceRuntimeManifestArgs {
  manifestPath: string;
  manifest: VoiceRuntimeManifest;
}

export async function writeVoiceRuntimeManifest(
  args: WriteVoiceRuntimeManifestArgs,
): Promise<void> {
  await mkdir(dirname(args.manifestPath), { recursive: true });
  const temporaryPath = `${args.manifestPath}.tmp-${process.pid}`;
  await rm(temporaryPath, { force: true });
  await writeFile(
    temporaryPath,
    `${JSON.stringify(args.manifest, null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryPath, args.manifestPath);
}

export type VoiceRuntimeManifestMutator = (
  manifest: VoiceRuntimeManifest,
) => Promise<VoiceRuntimeManifest> | VoiceRuntimeManifest;

export interface MutateVoiceRuntimeManifestArgs extends ReadVoiceRuntimeManifestArgs {
  mutate: VoiceRuntimeManifestMutator;
}

const manifestMutationChains = new Map<string, Promise<unknown>>();

export async function mutateVoiceRuntimeManifest(
  args: MutateVoiceRuntimeManifestArgs,
): Promise<VoiceRuntimeManifest> {
  const previous =
    manifestMutationChains.get(args.manifestPath) ?? Promise.resolve();
  const run = previous.then(async () => {
    const read = await readVoiceRuntimeManifest(args);
    const current =
      read.kind === "ok"
        ? read.manifest
        : createEmptyVoiceRuntimeManifest({
            createdByArcVersion: args.createdByArcVersion,
            platform: args.platform,
            arch: args.arch,
          });
    const next = await args.mutate(current);
    await writeVoiceRuntimeManifest({
      manifestPath: args.manifestPath,
      manifest: next,
    });
    return next;
  });
  manifestMutationChains.set(
    args.manifestPath,
    run.catch(() => undefined),
  );
  return run;
}
