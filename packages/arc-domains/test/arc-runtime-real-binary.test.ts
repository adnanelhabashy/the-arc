import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256File } from "../src/arc-runtime/digest.js";
import { probeArcRuntimeVersion } from "../src/arc-runtime/probe.js";
import {
  ARC_CODEX_RELEASE,
  ARC_OMP_RELEASE,
  validateArcRuntimeRelease,
} from "../src/arc-runtime/releases.js";

const stagedSeedPath = resolve(
  process.cwd(),
  "resources",
  "arc-runtimes",
  "codex",
  ARC_CODEX_RELEASE.version,
  "codex",
);

const stagedOmpSeedPath = resolve(
  process.cwd(),
  "resources",
  "arc-runtimes",
  "omp",
  ARC_OMP_RELEASE.version,
  "omp",
);

const seedAvailable = existsSync(stagedSeedPath);
const ompSeedAvailable = existsSync(stagedOmpSeedPath);

describe.skipIf(!seedAvailable)("real pinned Codex binary", () => {
  it("has the exact pinned executable digest", async () => {
    const digest = await sha256File(stagedSeedPath);
    expect(digest).toBe(ARC_CODEX_RELEASE.executableSha256);
  });

  it("reports exactly the pinned version", async () => {
    const probe = await probeArcRuntimeVersion({
      executablePath: stagedSeedPath,
    });
    expect(probe).toEqual({
      kind: "ok",
      version: ARC_CODEX_RELEASE.expectedExecutableVersion,
    });
  });

  it("ships release metadata that passes validation", () => {
    expect(validateArcRuntimeRelease(ARC_CODEX_RELEASE)).toEqual({
      kind: "ok",
    });
  });

  it("ships third-party notices next to the seed", async () => {
    const notices = await readFile(
      join(
        process.cwd(),
        "resources",
        "arc-runtimes",
        "THIRD_PARTY_NOTICES.md",
      ),
      "utf8",
    );
    expect(notices).toContain("OpenAI Codex");
    expect(notices).toContain("Apache");
    expect(notices).toContain("0.155.1");
  });
});

describe.skipIf(!ompSeedAvailable)("real pinned OMP binary", () => {
  it("has the exact pinned executable digest", async () => {
    const digest = await sha256File(stagedOmpSeedPath);
    expect(digest).toBe(ARC_OMP_RELEASE.executableSha256);
  });

  it("reports exactly the pinned version via omp --version", async () => {
    const probe = await probeArcRuntimeVersion({
      executablePath: stagedOmpSeedPath,
    });
    expect(probe).toEqual({
      kind: "ok",
      version: ARC_OMP_RELEASE.expectedExecutableVersion,
    });
  });

  it("ships release metadata that passes validation", () => {
    expect(validateArcRuntimeRelease(ARC_OMP_RELEASE)).toEqual({
      kind: "ok",
    });
  });

  it("ships third-party notices covering OMP next to the seed", async () => {
    const notices = await readFile(
      join(
        process.cwd(),
        "resources",
        "arc-runtimes",
        "THIRD_PARTY_NOTICES.md",
      ),
      "utf8",
    );
    expect(notices).toContain("Oh My Pi");
    expect(notices).toContain("MIT License");
    expect(notices).toContain("18.2.6");
    expect(notices).toContain("Mario Zechner");
    expect(notices).toContain("Can Bölük");
    expect(notices).toContain("Stencil Labs");
  });
});
