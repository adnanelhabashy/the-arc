import { spawn as spawnNodeChild } from "node:child_process";
import type { OmpChildProcess, OmpSpawn } from "@bb/arc-domains/arc-account";

// node:child_process backing for the domain's injectable OmpSpawn seam. The
// Arc-managed OMP executable is a fixed artifact resolved from the runtime
// manifest — never a caller-supplied path — so this spawn is not an
// arbitrary-command surface.
export function createNodeOmpSpawn(): OmpSpawn {
  return ({ executablePath, env, argv }) => {
    const child = spawnNodeChild(executablePath, argv, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.setDefaultEncoding("utf8");

    const stdoutListeners = new Set<(chunk: string) => void>();
    const stderrListeners = new Set<(chunk: string) => void>();
    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const listener of stdoutListeners) listener(text);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const listener of stderrListeners) listener(text);
    });

    const process: OmpChildProcess = {
      pid: child.pid ?? null,
      writeLine(line: string): void {
        child.stdin.write(`${line}\n`);
      },
      kill(signal?: NodeJS.Signals): void {
        child.kill(signal);
      },
      onStdoutData(listener: (chunk: string) => void): void {
        stdoutListeners.add(listener);
      },
      onStderrData(listener: (chunk: string) => void): void {
        stderrListeners.add(listener);
      },
      wait(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
        return new Promise((resolve) => {
          child.once("exit", (code, signal) => {
            resolve({ code, signal: signal as NodeJS.Signals | null });
          });
          child.once("error", () => {
            resolve({ code: null, signal: "SIGTERM" });
          });
        });
      },
    };
    return process;
  };
}
