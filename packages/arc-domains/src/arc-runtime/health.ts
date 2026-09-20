import { execFile, spawn, type ChildProcess } from "node:child_process";
import { probeArcRuntimeVersion } from "./probe.js";
import type { ArcRuntimeId } from "./types.js";

export type ArcRuntimeHealthProbeResult =
  | { kind: "healthy"; detail: string }
  | { kind: "unhealthy"; detail: string };

export interface ProbeArcRuntimeHealthArgs {
  runtimeId: ArcRuntimeId;
  executablePath: string;
  expectedVersion: string;
  timeoutMs?: number;
  // Test seams: real spawns are exercised by the *-real-binary suites; unit
  // tests inject fakes to cover the decision logic without a real
  // Codex/OMP/Claude binary on disk.
  runProcess?: (
    executablePath: string,
    args: string[],
    timeoutMs: number,
  ) => Promise<{ stdout: string; ok: boolean }>;
  runAcpHandshake?: (
    executablePath: string,
    timeoutMs: number,
  ) => Promise<{ ok: boolean; detail: string }>;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;

function defaultRunProcess(
  executablePath: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; ok: boolean }> {
  return new Promise((resolvePromise) => {
    execFile(
      executablePath,
      args,
      { timeout: timeoutMs, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        resolvePromise({ stdout: String(stdout), ok: error === null });
      },
    );
  });
}

function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
}

// A real (but account-free, offline) ACP `initialize` handshake — the same
// proof Phase 4 used live: OMP answers with protocolVersion/agentInfo before
// any credential is involved, so "ACP mode starts" is demonstrated rather
// than assumed from a bare `--help` exit code.
export function defaultRunOmpAcpHandshake(
  executablePath: string,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(executablePath, ["acp"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", HOME: "/tmp/arc-runtime-health-home" },
    });

    let settled = false;
    const settle = (result: { ok: boolean; detail: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminate(child);
      resolvePromise(result);
    };

    const timer = setTimeout(() => {
      settle({ ok: false, detail: "omp acp did not respond in time" });
    }, timeoutMs);

    child.once("error", (error) => {
      settle({ ok: false, detail: `omp acp failed to start: ${error.message}` });
    });
    child.once("exit", (code, signal) => {
      settle({
        ok: false,
        detail: `omp acp exited before responding (code ${String(code)}, signal ${String(signal)})`,
      });
    });

    let buffered = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      const newlineIndex = buffered.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = buffered.slice(0, newlineIndex);
      try {
        const message = JSON.parse(line) as {
          result?: { protocolVersion?: unknown };
        };
        if (message.result?.protocolVersion !== undefined) {
          settle({ ok: true, detail: "acp initialize handshake answered" });
        }
      } catch {
        // Not a complete/valid JSON-RPC line yet; keep buffering.
      }
    });

    child.stdin?.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1 },
      })}\n`,
    );
  });
}

// Local/offline only: no account, no network call that could reach a paid
// model endpoint. Each runtime's check proves the binary can do the minimum
// real thing Arc depends on, not merely that the file exists — a valid
// checksum is not enough (plan 2.9).
export async function probeArcRuntimeHealth(
  args: ProbeArcRuntimeHealthArgs,
): Promise<ArcRuntimeHealthProbeResult> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const runProcess = args.runProcess ?? defaultRunProcess;
  const runAcpHandshake = args.runAcpHandshake ?? defaultRunOmpAcpHandshake;

  const versionProbe = await probeArcRuntimeVersion({
    executablePath: args.executablePath,
    timeoutMs,
  });
  if (versionProbe.kind === "failed") {
    return {
      kind: "unhealthy",
      detail: `version probe failed: ${versionProbe.reason}`,
    };
  }
  if (versionProbe.version !== args.expectedVersion) {
    return {
      kind: "unhealthy",
      detail: `reports version ${versionProbe.version}, expected ${args.expectedVersion}`,
    };
  }

  if (args.runtimeId === "codex") {
    const doctor = await runProcess(
      args.executablePath,
      ["doctor", "--json"],
      timeoutMs,
    );
    if (!doctor.ok) {
      return {
        kind: "unhealthy",
        detail: "codex doctor did not complete successfully",
      };
    }
    return {
      kind: "healthy",
      detail: `codex ${versionProbe.version}: version verified, doctor completed`,
    };
  }

  if (args.runtimeId === "claude-code") {
    const doctor = await runProcess(args.executablePath, ["doctor"], timeoutMs);
    if (!doctor.ok) {
      return {
        kind: "unhealthy",
        detail: "claude doctor did not complete successfully",
      };
    }
    return {
      kind: "healthy",
      detail: `claude-code ${versionProbe.version}: version verified, doctor completed`,
    };
  }

  const handshake = await runAcpHandshake(args.executablePath, timeoutMs);
  if (!handshake.ok) {
    return { kind: "unhealthy", detail: handshake.detail };
  }
  return {
    kind: "healthy",
    detail: `omp ${versionProbe.version}: version verified, ${handshake.detail}`,
  };
}
