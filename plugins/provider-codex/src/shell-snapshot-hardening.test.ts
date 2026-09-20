import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hardenCodexShellSnapshotDir,
  resolveCodexShellSnapshotDir,
} from "./shell-snapshot-hardening.js";

let codexHome: string | undefined;

afterEach(async () => {
  if (codexHome !== undefined) {
    await rm(codexHome, { recursive: true, force: true });
    codexHome = undefined;
  }
});

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("hardenCodexShellSnapshotDir", () => {
  it("creates a missing snapshot directory as owner-only", async () => {
    codexHome = await mkdtemp(join(tmpdir(), "codex-home-"));
    const dir = resolveCodexShellSnapshotDir({ CODEX_HOME: codexHome });

    hardenCodexShellSnapshotDir({ CODEX_HOME: codexHome });

    expect(mode(dir)).toBe(0o700);
  });

  it("tightens an existing world-readable directory and its files", async () => {
    codexHome = await mkdtemp(join(tmpdir(), "codex-home-"));
    const dir = join(codexHome, "shell_snapshots");
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const snapshotFile = join(dir, "thread.123.sh");
    writeFileSync(snapshotFile, "export CODEX_POOL_AUTH_TOKEN=fake\n");
    chmodSync(snapshotFile, 0o644);

    hardenCodexShellSnapshotDir({ CODEX_HOME: codexHome });

    expect(mode(dir)).toBe(0o700);
    expect(mode(snapshotFile)).toBe(0o600);
  });

  it("is idempotent on an already-hardened directory", async () => {
    codexHome = await mkdtemp(join(tmpdir(), "codex-home-"));
    hardenCodexShellSnapshotDir({ CODEX_HOME: codexHome });
    expect(() =>
      hardenCodexShellSnapshotDir({ CODEX_HOME: codexHome }),
    ).not.toThrow();
    const dir = resolveCodexShellSnapshotDir({ CODEX_HOME: codexHome });
    expect(mode(dir)).toBe(0o700);
  });

  it("defaults to ~/.codex/shell_snapshots when CODEX_HOME is unset", () => {
    expect(resolveCodexShellSnapshotDir({})).toMatch(
      /\.codex\/shell_snapshots$/,
    );
  });
});
