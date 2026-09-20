import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeArcRuntimeHealth } from "../src/arc-runtime/health.js";

const tempDirs: string[] = [];

async function fakeExecutable(version: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arc-health-test-"));
  tempDirs.push(dir);
  const path = join(dir, "bin");
  await writeFile(
    path,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; else exit 0; fi\n`,
    "utf8",
  );
  await chmod(path, 0o755);
  return path;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("probeArcRuntimeHealth", () => {
  it("reports unhealthy when the version probe fails", async () => {
    const executablePath = await fakeExecutable("not-a-version");

    const result = await probeArcRuntimeHealth({
      runtimeId: "codex",
      executablePath,
      expectedVersion: "0.156.0",
    });

    expect(result.kind).toBe("unhealthy");
  });

  it("reports unhealthy when the reported version does not match the candidate", async () => {
    const executablePath = await fakeExecutable("0.155.1");

    const result = await probeArcRuntimeHealth({
      runtimeId: "codex",
      executablePath,
      expectedVersion: "0.156.0",
    });

    expect(result.kind).toBe("unhealthy");
    if (result.kind === "unhealthy") {
      expect(result.detail).toContain("0.155.1");
    }
  });

  it("runs codex doctor as the liveness check and reports healthy on success", async () => {
    const executablePath = await fakeExecutable("0.156.0");

    const result = await probeArcRuntimeHealth({
      runtimeId: "codex",
      executablePath,
      expectedVersion: "0.156.0",
      runProcess: async (_path, args) => ({
        stdout: "",
        ok: args[0] === "doctor",
      }),
    });

    expect(result.kind).toBe("healthy");
  });

  it("reports unhealthy when codex doctor fails even though the version matches", async () => {
    const executablePath = await fakeExecutable("0.156.0");

    const result = await probeArcRuntimeHealth({
      runtimeId: "codex",
      executablePath,
      expectedVersion: "0.156.0",
      runProcess: async () => ({ stdout: "", ok: false }),
    });

    expect(result.kind).toBe("unhealthy");
  });

  it("runs claude doctor for claude-code", async () => {
    const executablePath = await fakeExecutable("2.1.276");
    let ranDoctor = false;

    const result = await probeArcRuntimeHealth({
      runtimeId: "claude-code",
      executablePath,
      expectedVersion: "2.1.276",
      runProcess: async (_path, args) => {
        ranDoctor = args[0] === "doctor";
        return { stdout: "", ok: true };
      },
    });

    expect(ranDoctor).toBe(true);
    expect(result.kind).toBe("healthy");
  });

  it("runs the ACP handshake for omp and reports healthy on success", async () => {
    const executablePath = await fakeExecutable("18.3.0");

    const result = await probeArcRuntimeHealth({
      runtimeId: "omp",
      executablePath,
      expectedVersion: "18.3.0",
      runAcpHandshake: async () => ({
        ok: true,
        detail: "acp initialize handshake answered",
      }),
    });

    expect(result.kind).toBe("healthy");
  });

  it("reports unhealthy when the omp ACP handshake never answers", async () => {
    const executablePath = await fakeExecutable("18.3.0");

    const result = await probeArcRuntimeHealth({
      runtimeId: "omp",
      executablePath,
      expectedVersion: "18.3.0",
      runAcpHandshake: async () => ({
        ok: false,
        detail: "omp acp did not respond in time",
      }),
    });

    expect(result.kind).toBe("unhealthy");
  });

  it("never invokes any network-reaching model call (only local process checks)", async () => {
    const executablePath = await fakeExecutable("0.156.0");
    let calls = 0;

    await probeArcRuntimeHealth({
      runtimeId: "codex",
      executablePath,
      expectedVersion: "0.156.0",
      runProcess: async () => {
        calls += 1;
        return { stdout: "", ok: true };
      },
    });

    expect(calls).toBe(1);
  });
});
