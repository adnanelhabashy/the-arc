import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { sha256File } from "./digest.js";
import type { ArcVoiceboxRelease } from "./release.js";
import {
  validateArcVoiceboxRelease,
  voiceboxComponentPathInBundle,
} from "./release.js";

export const ARC_VOICEBOX_PROBE_TIMEOUT_MS = 30_000;

export type ArcVoiceboxVersionProbe =
  | { kind: "ok"; output: string }
  | { kind: "failed"; reason: string };

export type ArcVoiceboxStageResult =
  | {
      kind: "ok";
      executablePath: string;
      digest: string;
      version: string;
    }
  | { kind: "rejected"; reason: string };

export interface ArcVoiceboxProbe {
  (args: {
    executablePath: string;
    args: readonly string[];
    timeoutMs: number;
  }): Promise<
    { kind: "ok"; stdout: string } | { kind: "failed"; reason: string }
  >;
}

export const probeArcVoiceboxProcess: ArcVoiceboxProbe = (args) =>
  new Promise((resolve) => {
    execFile(
      args.executablePath,
      [...args.args],
      { timeout: args.timeoutMs, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          resolve({
            kind: "failed",
            reason: `probe exited with ${error.code ?? "unknown code"}: ${String(stderr).slice(0, 200)}`,
          });
          return;
        }
        resolve({ kind: "ok", stdout: String(stdout) });
      },
    );
  });

export async function probeArcVoiceboxRelease(args: {
  release: ArcVoiceboxRelease;
  executablePath: string;
  probe?: ArcVoiceboxProbe;
}): Promise<ArcVoiceboxVersionProbe> {
  const probe = args.probe ?? probeArcVoiceboxProcess;
  const result = await probe({
    executablePath: args.executablePath,
    args: args.release.versionArgs,
    timeoutMs: ARC_VOICEBOX_PROBE_TIMEOUT_MS,
  });
  if (result.kind === "failed") {
    return result;
  }
  const output = result.stdout.trim();
  if (output !== args.release.expectedVersionOutput) {
    return {
      kind: "failed",
      reason: `version probe reported ${JSON.stringify(output)}, expected ${JSON.stringify(args.release.expectedVersionOutput)}`,
    };
  }
  return { kind: "ok", output };
}

async function stageArcVoiceboxComponentFromSource(args: {
  release: ArcVoiceboxRelease;
  sourcePath: string;
  stagingDir: string;
  probe?: ArcVoiceboxProbe;
}): Promise<ArcVoiceboxStageResult> {
  const { release, sourcePath, stagingDir } = args;

  const validation = validateArcVoiceboxRelease(release);
  if (validation.kind === "invalid") {
    return {
      kind: "rejected",
      reason: `invalid release metadata: ${validation.problem}`,
    };
  }

  let sourceStat;
  try {
    sourceStat = await stat(sourcePath);
  } catch (error) {
    return {
      kind: "rejected",
      reason: `component source ${sourcePath} is unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (!sourceStat.isFile()) {
    return {
      kind: "rejected",
      reason: `component source ${sourcePath} is not a regular file`,
    };
  }

  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  const executablePath = join(stagingDir, release.componentFileName);

  try {
    await copyFile(sourcePath, executablePath);
    await chmod(executablePath, 0o755);

    const digest = await sha256File(executablePath);
    if (digest !== release.componentSha256) {
      return {
        kind: "rejected",
        reason: `staged ${release.componentFileName} digest mismatch: expected ${release.componentSha256}, got ${digest}`,
      };
    }

    const probe = await probeArcVoiceboxRelease({
      release,
      executablePath,
      ...(args.probe === undefined ? {} : { probe: args.probe }),
    });
    if (probe.kind === "failed") {
      return { kind: "rejected", reason: probe.reason };
    }

    return {
      kind: "ok",
      executablePath,
      digest,
      version: release.version,
    };
  } catch (error) {
    return {
      kind: "rejected",
      reason: `could not stage ${release.componentFileName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export async function stageArcVoiceboxComponentFromBundle(args: {
  release: ArcVoiceboxRelease;
  bundlePath: string;
  stagingDir: string;
  probe?: ArcVoiceboxProbe;
}): Promise<ArcVoiceboxStageResult> {
  const sourcePath = voiceboxComponentPathInBundle({
    bundlePath: args.bundlePath,
    release: args.release,
  });
  const bundleStat = await stat(args.bundlePath).catch(() => null);
  if (bundleStat === null || !bundleStat.isDirectory()) {
    return {
      kind: "rejected",
      reason: `${args.release.assetName} bundle ${args.bundlePath} is not a directory`,
    };
  }
  return stageArcVoiceboxComponentFromSource({ ...args, sourcePath });
}

export async function stageArcVoiceboxComponentFromFile(args: {
  release: ArcVoiceboxRelease;
  componentPath: string;
  stagingDir: string;
  probe?: ArcVoiceboxProbe;
}): Promise<ArcVoiceboxStageResult> {
  return stageArcVoiceboxComponentFromSource({
    ...args,
    sourcePath: args.componentPath,
  });
}
