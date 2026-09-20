import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveClaudeCodeExecutable } from "./session-options.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "claude-managed-"));
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

describe("Claude Code managed-runtime ownership", () => {
  it("runs the Arc-managed Claude even when a global claude comes first on PATH", async () => {
    const root = await workspace();
    const globalBin = join(root, "global-bin");
    const managedDir = join(
      root,
      "arc-runtimes",
      "runtimes",
      "claude-code",
      "2.1.276",
    );
    const globalClaude = await fakeExecutable(globalBin, "claude");
    const managedClaude = await fakeExecutable(managedDir, "claude");

    const resolved = resolveClaudeCodeExecutable({
      env: {
        PATH: `${globalBin}:${managedDir}`,
        BB_ARC_RUNTIME_ROOT: join(root, "arc-runtimes"),
        BB_CLAUDE_CODE_EXECUTABLE: managedClaude,
      },
    });

    expect(resolved).toBe(managedClaude);
    expect(resolved).not.toBe(globalClaude);
  });

  it("fails closed instead of using PATH when Arc owns the runtime but names no executable", async () => {
    const root = await workspace();
    const globalBin = join(root, "global-bin");
    await fakeExecutable(globalBin, "claude");

    expect(() =>
      resolveClaudeCodeExecutable({
        env: {
          PATH: globalBin,
          BB_ARC_RUNTIME_ROOT: join(root, "arc-runtimes"),
        },
      }),
    ).toThrow(/managed Claude Code runtime/);
  });

  it("rejects a managed path that is not executable", async () => {
    const root = await workspace();
    expect(() =>
      resolveClaudeCodeExecutable({
        env: {
          BB_ARC_RUNTIME_ROOT: join(root, "arc-runtimes"),
          BB_CLAUDE_CODE_EXECUTABLE: join(root, "missing-claude"),
        },
      }),
    ).toThrow(/must point to an executable Claude CLI path/);
  });

  it("keeps PATH and well-known discovery outside Arc", async () => {
    const root = await workspace();
    const globalBin = join(root, "global-bin");
    const globalClaude = await fakeExecutable(globalBin, "claude");

    expect(
      resolveClaudeCodeExecutable({ env: { PATH: globalBin } }),
    ).toBe(globalClaude);
  });
});
