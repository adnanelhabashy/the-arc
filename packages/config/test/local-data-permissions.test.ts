import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hardenLocalDataPermissions } from "../src/local-data-permissions.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bb-permissions-"));
  tempDirs.push(dir);
  return dir;
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("local data permission hardening", () => {
  it("creates a missing data directory owner-only and reports it", () => {
    const dataDir = join(tempDir(), ".bb");
    const databasePath = join(dataDir, "bb.db");

    const report = hardenLocalDataPermissions({ dataDir, databasePath });

    expect(modeOf(dataDir)).toBe(0o700);
    expect(report).toEqual({ hardened: [], failed: [] });
  });

  it("corrects a world-readable database and its WAL sidecars", () => {
    const dataDir = tempDir();
    const databasePath = join(dataDir, "bb.db");
    chmodSync(dataDir, 0o755);
    writeFileSync(databasePath, "", { mode: 0o644 });
    writeFileSync(`${databasePath}-wal`, "", { mode: 0o644 });
    chmodSync(`${databasePath}-wal`, 0o644);

    const report = hardenLocalDataPermissions({ dataDir, databasePath });

    expect(modeOf(dataDir)).toBe(0o700);
    expect(modeOf(databasePath)).toBe(0o600);
    expect(modeOf(`${databasePath}-wal`)).toBe(0o600);
    expect(report.hardened).toEqual([
      "data-dir",
      "database",
      "database-wal",
    ]);
    expect(report.failed).toEqual([]);
  });

  it("changes nothing and reports nothing when permissions already hold", () => {
    const dataDir = tempDir();
    const databasePath = join(dataDir, "bb.db");
    chmodSync(dataDir, 0o700);
    writeFileSync(databasePath, "", { mode: 0o600 });

    const report = hardenLocalDataPermissions({ dataDir, databasePath });

    expect(report).toEqual({ hardened: [], failed: [] });
  });

  it("reports a target it cannot restrict without exposing the path", () => {
    const root = tempDir();
    const blockingFile = join(root, "not-a-directory");
    writeFileSync(blockingFile, "", { mode: 0o600 });

    const report = hardenLocalDataPermissions({
      dataDir: join(blockingFile, "nested", ".bb"),
      databasePath: join(blockingFile, "nested", ".bb", "bb.db"),
    });

    expect(report.hardened).toEqual([]);
    expect(report.failed).toEqual([
      { target: "data-dir", code: "ENOTDIR" },
    ]);
  });
});
