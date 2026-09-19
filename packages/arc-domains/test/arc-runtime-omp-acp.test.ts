import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ARC_OMP_RELEASE } from "../src/arc-runtime/releases.js";

const stagedOmpSeedPath = resolve(
  process.cwd(),
  "resources",
  "arc-runtimes",
  "omp",
  ARC_OMP_RELEASE.version,
  "omp",
);

const ompSeedAvailable = existsSync(stagedOmpSeedPath);

// Integration test against the real external OMP process: the timeout guard
// must use the platform clock because the awaited signal comes from that
// process, not from in-process timers.
const ACP_SMOKE_TIMEOUT_MS = 30_000;

interface AcpMessage {
  jsonrpc: string;
  id?: number;
  result?: {
    protocolVersion?: number;
    agentInfo?: { name?: string; version?: string };
  };
}

function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
}

describe.skipIf(!ompSeedAvailable)("real pinned OMP ACP startup", () => {
  let child: ChildProcess | null = null;

  afterEach(() => {
    if (child !== null) {
      terminate(child);
      child = null;
    }
  });

  it(
    "answers an ACP initialize handshake without any AI account",
    async () => {
      child = spawn(stagedOmpSeedPath, ["acp"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: "/usr/bin:/bin",
          HOME: "/tmp/arc-acp-smoke-home",
        },
      });

      let resolveResponse!: (message: AcpMessage) => void;
      let rejectResponse!: (error: Error) => void;
      const responsePromise = new Promise<AcpMessage>(
        (resolvePromise, rejectPromise) => {
          resolveResponse = resolvePromise;
          rejectResponse = rejectPromise;
        },
      );
      child.once("exit", (code, signal) => {
        rejectResponse(
          new Error(`omp acp exited before initialize response (code ${code}, signal ${signal})`),
        );
      });
      child.once("error", (error) => {
        rejectResponse(error);
      });

      let buffered = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        buffered += chunk;
        let newlineIndex = buffered.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffered.slice(0, newlineIndex).trim();
          buffered = buffered.slice(newlineIndex + 1);
          newlineIndex = buffered.indexOf("\n");
          if (line.length === 0) {
            continue;
          }
          try {
            const message = JSON.parse(line) as AcpMessage;
            if (message.id === 0 && message.result !== undefined) {
              resolveResponse(message);
            }
          } catch {
            // ignore non-JSON lines (startup banners)
          }
        }
      });

      const initialize = {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
      };
      child.stdin?.write(`${JSON.stringify(initialize)}\n`);

      const response = await responsePromise;
      expect(response.result?.protocolVersion).toBe(1);
      expect(response.result?.agentInfo?.name).toBe("oh-my-pi");
      expect(response.result?.agentInfo?.version).toBe(
        ARC_OMP_RELEASE.expectedExecutableVersion,
      );
    },
    ACP_SMOKE_TIMEOUT_MS + 5_000,
  );
});
