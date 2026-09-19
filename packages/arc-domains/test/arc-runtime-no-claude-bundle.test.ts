import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ARC_CLAUDE_CODE_RELEASE,
  ARC_CODEX_RELEASE,
} from "../src/arc-runtime/releases.js";

const stagedResourcesRoot = resolve(
  process.cwd(),
  "resources",
  "arc-runtimes",
);

const resourcesStaged = existsSync(
  join(stagedResourcesRoot, "codex", ARC_CODEX_RELEASE.version),
);

// Permanent guard for the Phase 5 legal rule: Claude Code is proprietary
// (© Anthropic PBC, Commercial Terms) and must never be bundled inside the Arc
// application bundle. Only Codex and OMP seeds may ship.
describe.skipIf(!resourcesStaged)("Arc bundle contains no Claude Code binary", () => {
  it("stages exactly the Codex and OMP seeds", async () => {
    const entries = await readdir(stagedResourcesRoot);
    const runtimeDirs = entries.filter(
      (entry) => entry !== "THIRD_PARTY_NOTICES.md",
    );
    expect(runtimeDirs.sort()).toEqual(["codex", "omp"]);
  });

  it("has no claude-code seed directory", () => {
    expect(
      existsSync(
        join(stagedResourcesRoot, "claude-code", ARC_CLAUDE_CODE_RELEASE.version),
      ),
    ).toBe(false);
  });

  it("ships no file named like the Claude executable", async () => {
    const offenders: string[] = [];
    async function scan(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          await scan(path);
        } else if (/^claude(-code)?(\.|$)/i.test(entry.name)) {
          offenders.push(path);
        }
      }
    }
    await scan(stagedResourcesRoot);
    expect(offenders).toEqual([]);
  });
});
