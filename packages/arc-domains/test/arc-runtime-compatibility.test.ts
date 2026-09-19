import { describe, expect, it } from "vitest";
import {
  ARC_RUNTIME_COMPATIBILITY_POLICY,
  evaluateArcRuntimeCompatibility,
  type ArcRuntimeCompatibilityPolicy,
} from "../src/arc-runtime/compatibility.js";

const POLICY: ArcRuntimeCompatibilityPolicy = {
  codex: {
    minimum: "0.136.0",
    maximumTested: "0.155.1",
    blockedVersions: ["0.140.0"],
  },
  omp: {
    minimum: "18.0.0",
    maximumTested: "18.2.6",
  },
};

describe("evaluateArcRuntimeCompatibility", () => {
  it("blocks versions below the minimum", () => {
    const result = evaluateArcRuntimeCompatibility({
      policy: POLICY,
      runtimeId: "codex",
      version: "0.100.0",
    });

    expect(result.compatibility).toBe("blocked");
    expect(result.reason).toContain("below the minimum");
  });

  it("supports versions inside the tested range", () => {
    const result = evaluateArcRuntimeCompatibility({
      policy: POLICY,
      runtimeId: "codex",
      version: "0.150.0",
    });

    expect(result.compatibility).toBe("supported");
  });

  it("treats boundary versions as supported", () => {
    for (const version of ["0.136.0", "0.155.1"]) {
      const result = evaluateArcRuntimeCompatibility({
        policy: POLICY,
        runtimeId: "codex",
        version,
      });
      expect(result.compatibility).toBe("supported");
    }
  });

  it("marks versions newer than the tested maximum as untested, not blocked", () => {
    const result = evaluateArcRuntimeCompatibility({
      policy: POLICY,
      runtimeId: "omp",
      version: "19.0.0",
    });

    expect(result.compatibility).toBe("untested");
    expect(result.reason).toContain("newer than the tested maximum");
  });

  it("blocks an explicit known-bad release inside the range", () => {
    const result = evaluateArcRuntimeCompatibility({
      policy: POLICY,
      runtimeId: "codex",
      version: "0.140.0",
    });

    expect(result.compatibility).toBe("blocked");
    expect(result.reason).toContain("known-bad");
  });

  it("returns untested for a malformed version without crashing", () => {
    const result = evaluateArcRuntimeCompatibility({
      policy: POLICY,
      runtimeId: "codex",
      version: "not-a-version",
    });

    expect(result.compatibility).toBe("untested");
  });

  it("returns untested when no rule exists for the runtime", () => {
    const result = evaluateArcRuntimeCompatibility({
      policy: POLICY,
      runtimeId: "claude-code",
      version: "2.1.0",
    });

    expect(result.compatibility).toBe("untested");
  });

  it("supports the pinned tested maximum under the shipped policy", () => {
    const result = evaluateArcRuntimeCompatibility({
      policy: ARC_RUNTIME_COMPATIBILITY_POLICY,
      runtimeId: "codex",
      version: "0.155.1",
    });

    expect(result.compatibility).toBe("supported");
  });

  it("blocks ancient Codex versions under the shipped bootstrap policy", () => {
    const result = evaluateArcRuntimeCompatibility({
      policy: ARC_RUNTIME_COMPATIBILITY_POLICY,
      runtimeId: "codex",
      version: "0.1.0",
    });

    expect(result.compatibility).toBe("blocked");
  });

  it("supports the minimum boundary and marks newer versions untested", () => {
    const atMinimum = evaluateArcRuntimeCompatibility({
      policy: ARC_RUNTIME_COMPATIBILITY_POLICY,
      runtimeId: "codex",
      version: "0.136.0",
    });
    expect(atMinimum.compatibility).toBe("supported");

    const belowMinimum = evaluateArcRuntimeCompatibility({
      policy: ARC_RUNTIME_COMPATIBILITY_POLICY,
      runtimeId: "codex",
      version: "0.120.0",
    });
    expect(belowMinimum.compatibility).toBe("blocked");

    const aboveMaximum = evaluateArcRuntimeCompatibility({
      policy: ARC_RUNTIME_COMPATIBILITY_POLICY,
      runtimeId: "codex",
      version: "0.156.0",
    });
    expect(aboveMaximum.compatibility).toBe("untested");
  });
});

describe("OMP compatibility under the shipped policy", () => {
  it("supports exactly the first tested pin 18.2.6", () => {
    const result = evaluateArcRuntimeCompatibility({
      policy: ARC_RUNTIME_COMPATIBILITY_POLICY,
      runtimeId: "omp",
      version: "18.2.6",
    });

    expect(result.compatibility).toBe("supported");
  });

  it("marks newer OMP versions untested", () => {
    const result = evaluateArcRuntimeCompatibility({
      policy: ARC_RUNTIME_COMPATIBILITY_POLICY,
      runtimeId: "omp",
      version: "18.3.0",
    });

    expect(result.compatibility).toBe("untested");
  });

  it("blocks older OMP versions until compatibility evidence exists", () => {
    const result = evaluateArcRuntimeCompatibility({
      policy: ARC_RUNTIME_COMPATIBILITY_POLICY,
      runtimeId: "omp",
      version: "18.2.5",
    });

    expect(result.compatibility).toBe("blocked");
  });

  it("blocks ancient OMP majors", () => {
    const result = evaluateArcRuntimeCompatibility({
      policy: ARC_RUNTIME_COMPATIBILITY_POLICY,
      runtimeId: "omp",
      version: "17.1.4",
    });

    expect(result.compatibility).toBe("blocked");
  });
});

describe("Claude Code compatibility under the shipped policy", () => {
  it("supports exactly the tested pin 2.1.276", () => {
    const result = evaluateArcRuntimeCompatibility({
      policy: ARC_RUNTIME_COMPATIBILITY_POLICY,
      runtimeId: "claude-code",
      version: "2.1.276",
    });

    expect(result.compatibility).toBe("supported");
  });

  it("marks newer Claude versions untested", () => {
    const result = evaluateArcRuntimeCompatibility({
      policy: ARC_RUNTIME_COMPATIBILITY_POLICY,
      runtimeId: "claude-code",
      version: "2.1.280",
    });

    expect(result.compatibility).toBe("untested");
  });

  it("marks older Claude versions untested rather than silently supported", () => {
    const result = evaluateArcRuntimeCompatibility({
      policy: ARC_RUNTIME_COMPATIBILITY_POLICY,
      runtimeId: "claude-code",
      version: "2.1.200",
    });

    expect(result.compatibility).toBe("untested");
    expect(result.reason).toContain("older than the first tested version");
  });

  it("treats untestedBelow as data, not a block", () => {
    const policy: ArcRuntimeCompatibilityPolicy = {
      "claude-code": {
        maximumTested: "2.1.276",
        untestedBelow: "2.1.276",
        blockedVersions: ["2.0.0"],
      },
    };

    const blocked = evaluateArcRuntimeCompatibility({
      policy,
      runtimeId: "claude-code",
      version: "2.0.0",
    });
    expect(blocked.compatibility).toBe("blocked");

    const olderUntested = evaluateArcRuntimeCompatibility({
      policy,
      runtimeId: "claude-code",
      version: "2.1.0",
    });
    expect(olderUntested.compatibility).toBe("untested");
  });
});
