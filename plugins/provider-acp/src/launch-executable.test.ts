import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AcpAgentDefinition } from "./agents.js";
import { resolveAcpLaunchExecutable } from "./launch-executable.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "acp-managed-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function fakeExecutable(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(path, 0o755);
  return path;
}

function ompAgent(): AcpAgentDefinition {
  return {
    id: "acp-omp",
    displayName: "omp",
    launch: { displayName: "omp", command: "omp", args: ["acp"], env: {} },
  };
}

function cursorAgent(): AcpAgentDefinition {
  return {
    id: "acp-cursor",
    displayName: "Cursor",
    launch: { displayName: "cursor", command: "cursor-agent", args: ["acp"], env: {} },
  };
}

describe("ACP managed-runtime ownership", () => {
  it("launches the Arc-managed omp even when a global omp comes first on PATH", async () => {
    const root = await workspace();
    const globalBin = join(root, "global-bin");
    const managedDir = join(root, "arc-runtimes", "runtimes", "omp", "18.2.6");
    const globalOmp = await fakeExecutable(globalBin, "omp");
    const managedOmp = await fakeExecutable(managedDir, "omp");

    const resolution = resolveAcpLaunchExecutable({
      agent: ompAgent(),
      env: {
        PATH: `${globalBin}:${managedDir}`,
        BB_ARC_RUNTIME_ROOT: join(root, "arc-runtimes"),
        BB_OMP_EXECUTABLE: managedOmp,
      },
    });

    expect(resolution.kind).toBe("agent");
    if (resolution.kind !== "agent") return;
    expect(resolution.agent.launch.command).toBe(managedOmp);
    expect(resolution.agent.launch.command).not.toBe(globalOmp);
    expect(resolution.agent.launch.args).toEqual(["acp"]);
  });

  it("reports unavailability instead of falling back to PATH when Arc owns the runtime", () => {
    const resolution = resolveAcpLaunchExecutable({
      agent: ompAgent(),
      env: {
        PATH: "/global/bin",
        BB_ARC_RUNTIME_ROOT: "/arc/arc-runtimes",
      },
    });

    expect(resolution.kind).toBe("unavailable");
    if (resolution.kind !== "unavailable") return;
    expect(resolution.reason).toContain("managed omp runtime");
  });

  it("reports unavailability for a managed path that is not executable", () => {
    const resolution = resolveAcpLaunchExecutable({
      agent: ompAgent(),
      env: {
        BB_ARC_RUNTIME_ROOT: "/arc/arc-runtimes",
        BB_OMP_EXECUTABLE: "/arc/arc-runtimes/runtimes/omp/18.2.6/omp",
      },
    });

    expect(resolution).toMatchObject({ kind: "unavailable" });
  });

  it("leaves the shipped command alone outside Arc", () => {
    const resolution = resolveAcpLaunchExecutable({
      agent: ompAgent(),
      env: { PATH: "/global/bin" },
    });

    expect(resolution).toMatchObject({
      kind: "agent",
      agent: { launch: { command: "omp" } },
    });
  });

  it("does not touch agents Arc does not own", () => {
    const resolution = resolveAcpLaunchExecutable({
      agent: cursorAgent(),
      env: { BB_ARC_RUNTIME_ROOT: "/arc/arc-runtimes" },
    });

    expect(resolution).toMatchObject({
      kind: "agent",
      agent: { launch: { command: "cursor-agent" } },
    });
  });
});
