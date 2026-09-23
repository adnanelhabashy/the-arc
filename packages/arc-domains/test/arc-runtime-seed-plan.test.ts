import { describe, expect, it } from "vitest";
import {
  arcRuntimeSeedFileDigests,
  arcRuntimeSeedFileNames,
  planArcRuntimeSeedBuild,
} from "../src/arc-runtime/seed-plan.js";
import { ARC_CODEX_RELEASE, ARC_OMP_RELEASE } from "../src/arc-runtime/releases.js";

/**
 * The seed pipeline's definition of a complete seed directory. This is the
 * decision that could let a release build ship Codex without the
 * `codex-code-mode-host` beside it, so a seed that holds only the binary must
 * never read as complete.
 */

const companion = ARC_CODEX_RELEASE.companions![0];
const codexFiles = {
  codex: ARC_CODEX_RELEASE.executableSha256,
  [companion.fileName]: companion.executableSha256,
};

describe("arcRuntimeSeedFileNames", () => {
  it("names the executable and every companion for Codex", () => {
    expect(arcRuntimeSeedFileNames(ARC_CODEX_RELEASE)).toEqual([
      "codex",
      companion.fileName,
    ]);
  });

  it("names only the executable for a runtime with no companions", () => {
    expect(arcRuntimeSeedFileNames(ARC_OMP_RELEASE)).toEqual(["omp"]);
  });
});

describe("arcRuntimeSeedFileDigests", () => {
  it("pins a digest for every seed file", () => {
    expect(arcRuntimeSeedFileDigests(ARC_CODEX_RELEASE)).toEqual([
      { fileName: "codex", sha256: ARC_CODEX_RELEASE.executableSha256 },
      {
        fileName: companion.fileName,
        sha256: companion.executableSha256,
      },
    ]);
  });
});

describe("planArcRuntimeSeedBuild", () => {
  it("reports a seed holding only the binary as incomplete, naming the helper", () => {
    const plan = planArcRuntimeSeedBuild({
      release: ARC_CODEX_RELEASE,
      seedDigests: { codex: ARC_CODEX_RELEASE.executableSha256 },
    });

    expect(plan).toEqual({ kind: "rebuild", missing: [companion.fileName] });
  });

  it("reports a helper from a different release as incomplete", () => {
    const plan = planArcRuntimeSeedBuild({
      release: ARC_CODEX_RELEASE,
      seedDigests: { ...codexFiles, [companion.fileName]: "f".repeat(64) },
    });

    expect(plan).toEqual({ kind: "rebuild", missing: [companion.fileName] });
  });

  it("reports a stale binary as incomplete even when the helper is correct", () => {
    const plan = planArcRuntimeSeedBuild({
      release: ARC_CODEX_RELEASE,
      seedDigests: { ...codexFiles, codex: "a".repeat(64) },
    });

    expect(plan).toEqual({ kind: "rebuild", missing: ["codex"] });
  });

  it("reports an unreadable file as incomplete", () => {
    const plan = planArcRuntimeSeedBuild({
      release: ARC_CODEX_RELEASE,
      seedDigests: { ...codexFiles, [companion.fileName]: null },
    });

    expect(plan).toEqual({ kind: "rebuild", missing: [companion.fileName] });
  });

  it("reports every missing file when the seed is empty", () => {
    const plan = planArcRuntimeSeedBuild({
      release: ARC_CODEX_RELEASE,
      seedDigests: {},
    });

    expect(plan).toEqual({
      kind: "rebuild",
      missing: ["codex", companion.fileName],
    });
  });

  it("accepts a seed whose every file matches its pin", () => {
    expect(
      planArcRuntimeSeedBuild({
        release: ARC_CODEX_RELEASE,
        seedDigests: codexFiles,
      }),
    ).toEqual({ kind: "complete" });
  });

  it("accepts a companionless runtime on its executable alone", () => {
    expect(
      planArcRuntimeSeedBuild({
        release: ARC_OMP_RELEASE,
        seedDigests: { omp: ARC_OMP_RELEASE.executableSha256 },
      }),
    ).toEqual({ kind: "complete" });
  });
});
