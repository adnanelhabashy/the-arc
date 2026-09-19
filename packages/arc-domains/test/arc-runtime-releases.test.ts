import { describe, expect, it } from "vitest";
import {
  ARC_CLAUDE_CODE_RELEASE,
  ARC_CODEX_RELEASE,
  ARC_OMP_RELEASE,
  ARC_RUNTIME_RELEASES,
  validateArcRuntimeRelease,
  type ArcRuntimeRelease,
} from "../src/arc-runtime/releases.js";

function releasePatch(
  patch: Partial<ArcRuntimeRelease>,
): ArcRuntimeRelease {
  return { ...ARC_CODEX_RELEASE, ...patch };
}

describe("pinned release metadata", () => {
  it("pins Codex 0.155.1 with the exact rust release tag", () => {
    expect(ARC_CODEX_RELEASE.version).toBe("0.155.1");
    expect(ARC_CODEX_RELEASE.releaseTag).toBe("rust-v0.155.1");
    expect(ARC_CODEX_RELEASE.expectedExecutableVersion).toBe("0.155.1");
  });

  it("maps the Apple-silicon platform identity", () => {
    expect(ARC_CODEX_RELEASE.platform).toBe("darwin-arm64");
  });

  it("uses the exact official asset name", () => {
    expect(ARC_CODEX_RELEASE.assetName).toBe(
      "codex-aarch64-apple-darwin.tar.gz",
    );
  });

  it("pins lowercase hex digests for the archive and executable", () => {
    expect(ARC_CODEX_RELEASE.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ARC_CODEX_RELEASE.executableSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records the Apache-2.0 license", () => {
    expect(ARC_CODEX_RELEASE.license).toBe("Apache-2.0");
  });

  it("passes validation for the shipped pin", () => {
    for (const release of ARC_RUNTIME_RELEASES) {
      expect(validateArcRuntimeRelease(release)).toEqual({ kind: "ok" });
    }
  });

  it("rejects a latest alias as release identity", () => {
    const result = validateArcRuntimeRelease(
      releasePatch({ releaseTag: "latest" }),
    );
    expect(result.kind).toBe("invalid");
  });

  it("rejects a latest download URL", () => {
    const result = validateArcRuntimeRelease(
      releasePatch({
        downloadUrl:
          "https://github.com/openai/codex/releases/latest/download/codex-aarch64-apple-darwin.tar.gz",
      }),
    );
    expect(result.kind).toBe("invalid");
  });

  it("rejects a non-https download URL", () => {
    const result = validateArcRuntimeRelease(
      releasePatch({
        downloadUrl:
          "http://github.com/openai/codex/releases/download/rust-v0.155.1/codex-aarch64-apple-darwin.tar.gz",
      }),
    );
    expect(result.kind).toBe("invalid");
  });

  it("rejects a download URL outside the openai/codex release path", () => {
    const result = validateArcRuntimeRelease(
      releasePatch({
        downloadUrl:
          "https://evil.example.com/openai/codex/releases/download/rust-v0.155.1/codex-aarch64-apple-darwin.tar.gz",
      }),
    );
    expect(result.kind).toBe("invalid");
  });

  it("rejects a URL whose asset name differs from the pinned asset", () => {
    const result = validateArcRuntimeRelease(
      releasePatch({
        downloadUrl:
          "https://github.com/openai/codex/releases/download/rust-v0.155.1/codex-aarch64-apple-darwin.zip",
      }),
    );
    expect(result.kind).toBe("invalid");
  });

  it("rejects malformed digests and versions", () => {
    expect(
      validateArcRuntimeRelease(releasePatch({ sha256: "not-hex" })).kind,
    ).toBe("invalid");
    expect(
      validateArcRuntimeRelease(releasePatch({ executableSha256: "A".repeat(64) }))
        .kind,
    ).toBe("invalid");
    expect(
      validateArcRuntimeRelease(releasePatch({ version: "latest" })).kind,
    ).toBe("invalid");
  });
});

function ompReleasePatch(
  patch: Partial<ArcRuntimeRelease>,
): ArcRuntimeRelease {
  return { ...ARC_OMP_RELEASE, ...patch };
}

describe("pinned OMP release metadata", () => {
  it("pins OMP 18.2.6 with the exact v18.2.6 release tag", () => {
    expect(ARC_OMP_RELEASE.version).toBe("18.2.6");
    expect(ARC_OMP_RELEASE.releaseTag).toBe("v18.2.6");
    expect(ARC_OMP_RELEASE.expectedExecutableVersion).toBe("18.2.6");
    expect(ARC_OMP_RELEASE.platform).toBe("darwin-arm64");
  });

  it("pins the direct executable asset name and kind", () => {
    expect(ARC_OMP_RELEASE.artifactKind).toBe("executable");
    expect(ARC_OMP_RELEASE.assetName).toBe("omp-darwin-arm64");
  });

  it("pins the GitHub-verified digest for both fields of a direct asset", () => {
    expect(ARC_OMP_RELEASE.sha256).toBe(
      "d498da40d577e1ffa681ca8632c2ea40a9f722a08b880412011d37dffee9513a",
    );
    expect(ARC_OMP_RELEASE.executableSha256).toBe(ARC_OMP_RELEASE.sha256);
  });

  it("records the MIT license", () => {
    expect(ARC_OMP_RELEASE.license).toBe("MIT");
  });

  it("passes validation for the shipped pin", () => {
    expect(validateArcRuntimeRelease(ARC_OMP_RELEASE)).toEqual({ kind: "ok" });
  });

  it("rejects a download URL outside the can1357/oh-my-pi release path", () => {
    const result = validateArcRuntimeRelease(
      ompReleasePatch({
        downloadUrl:
          "https://github.com/openai/codex/releases/download/v18.2.6/omp-darwin-arm64",
      }),
    );
    expect(result.kind).toBe("invalid");
  });

  it("rejects a latest alias for OMP", () => {
    const result = validateArcRuntimeRelease(
      ompReleasePatch({
        downloadUrl:
          "https://github.com/can1357/oh-my-pi/releases/download/latest/omp-darwin-arm64",
        releaseTag: "latest",
      }),
    );
    expect(result.kind).toBe("invalid");
  });

  it("rejects divergent digests on a direct executable asset", () => {
    const result = validateArcRuntimeRelease(
      ompReleasePatch({ executableSha256: "0".repeat(64) }),
    );
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.problem).toContain("identical");
    }
  });

  it("ships both pinned releases in the release list", () => {
    expect(ARC_RUNTIME_RELEASES.map((release) => release.runtimeId)).toEqual([
      "codex",
      "omp",
    ]);
  });
});

function claudeReleasePatch(
  patch: Partial<ArcRuntimeRelease>,
): ArcRuntimeRelease {
  return { ...ARC_CLAUDE_CODE_RELEASE, ...patch };
}

describe("pinned Claude Code release metadata", () => {
  it("pins Claude 2.1.276 from the Anthropic official release endpoint", () => {
    expect(ARC_CLAUDE_CODE_RELEASE.version).toBe("2.1.276");
    expect(ARC_CLAUDE_CODE_RELEASE.releaseTag).toBe("v2.1.276");
    expect(ARC_CLAUDE_CODE_RELEASE.artifactKind).toBe("direct-official");
    expect(ARC_CLAUDE_CODE_RELEASE.platform).toBe("darwin-arm64");
    expect(ARC_CLAUDE_CODE_RELEASE.downloadUrl).toBe(
      "https://downloads.claude.ai/claude-code-releases/2.1.276/darwin-arm64/claude",
    );
  });

  it("pins the checksum extracted from the GPG-signed release manifest", () => {
    expect(ARC_CLAUDE_CODE_RELEASE.sha256).toBe(
      "9de364db11a410d53cbbb0f6b1f18c66c90053efc9a63370072856d10db66329",
    );
    expect(ARC_CLAUDE_CODE_RELEASE.executableSha256).toBe(
      ARC_CLAUDE_CODE_RELEASE.sha256,
    );
  });

  it("records the proprietary license terms", () => {
    expect(ARC_CLAUDE_CODE_RELEASE.license).toBe("Anthropic Commercial Terms");
  });

  it("passes validation for the shipped pin", () => {
    expect(validateArcRuntimeRelease(ARC_CLAUDE_CODE_RELEASE)).toEqual({
      kind: "ok",
    });
  });

  it("rejects a Claude download URL on any host other than downloads.claude.ai", () => {
    const result = validateArcRuntimeRelease(
      claudeReleasePatch({
        downloadUrl:
          "https://github.com/anthropics/claude-code/releases/download/v2.1.276/claude-darwin-arm64.tar.gz",
      }),
    );
    expect(result.kind).toBe("invalid");
  });

  it("rejects a Claude URL missing the exact pinned version/platform path", () => {
    const result = validateArcRuntimeRelease(
      claudeReleasePatch({
        downloadUrl:
          "https://downloads.claude.ai/claude-code-releases/2.1.277/darwin-arm64/claude",
      }),
    );
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.problem).toContain("exact pinned");
    }
  });

  it("is not part of the build-time seed release list", () => {
    expect(ARC_RUNTIME_RELEASES).not.toContain(ARC_CLAUDE_CODE_RELEASE);
    expect(
      ARC_RUNTIME_RELEASES.map((release) => release.runtimeId),
    ).not.toContain("claude-code");
  });
});
