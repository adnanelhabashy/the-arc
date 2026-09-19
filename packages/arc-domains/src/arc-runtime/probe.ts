import { execFile } from "node:child_process";
import { valid } from "semver";

export const ARC_RUNTIME_PROBE_TIMEOUT_MS = 15_000;

export type ArcRuntimeVersionProbe =
  | { kind: "ok"; version: string }
  | { kind: "failed"; reason: string };

export interface ProbeArcRuntimeVersionArgs {
  executablePath: string;
  timeoutMs?: number;
}

export function parseRuntimeVersionOutput(output: string): string | null {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)/.exec(output);
  if (match === null) {
    return null;
  }
  return valid(match[1]);
}

export async function probeArcRuntimeVersion(
  args: ProbeArcRuntimeVersionArgs,
): Promise<ArcRuntimeVersionProbe> {
  const timeoutMs = args.timeoutMs ?? ARC_RUNTIME_PROBE_TIMEOUT_MS;
  let output: string;
  try {
    output = await new Promise<string>((resolvePromise, rejectPromise) => {
      const child = execFile(
        args.executablePath,
        ["--version"],
        { timeout: timeoutMs, maxBuffer: 64 * 1024 },
        (error, stdout, stderr) => {
          if (error !== null) {
            rejectPromise(
              new Error(
                `probe exited with ${error.code ?? "unknown code"}: ${String(stderr).slice(0, 200)}`,
              ),
            );
            return;
          }
          resolvePromise(String(stdout));
        },
      );
      if (child.pid === undefined) {
        rejectPromise(new Error("probe process failed to start"));
      }
    });
  } catch (error) {
    return {
      kind: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const version = parseRuntimeVersionOutput(output);
  if (version === null) {
    return {
      kind: "failed",
      reason: `probe output did not contain a semantic version: ${output.trim().slice(0, 100)}`,
    };
  }
  return { kind: "ok", version };
}
