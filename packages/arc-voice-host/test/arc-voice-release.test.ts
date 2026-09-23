import { describe, expect, it } from "vitest";
import {
  ARC_VOICEBOX_RELEASE,
  validateArcVoiceboxRelease,
  voiceboxComponentPathInBundle,
  voiceboxReleaseAvailability,
  type ArcVoiceboxRelease,
} from "../src/release.js";

describe("ARC_VOICEBOX_RELEASE", () => {
  it("ships release metadata that passes validation", () => {
    expect(validateArcVoiceboxRelease(ARC_VOICEBOX_RELEASE)).toEqual({
      kind: "ok",
    });
  });

  it("pins the macOS arm64 component Arc verified live", () => {
    expect(ARC_VOICEBOX_RELEASE.platform).toBe("darwin-arm64");
    expect(ARC_VOICEBOX_RELEASE.version).toBe("0.5.0");
    expect(ARC_VOICEBOX_RELEASE.componentFileName).toBe("voicebox-server");
    expect(ARC_VOICEBOX_RELEASE.componentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ARC_VOICEBOX_RELEASE.expectedVersionOutput).toBe(
      "voicebox-server 0.5.0",
    );
    expect(ARC_VOICEBOX_RELEASE.license).toBe("MIT");
  });

  it("locates the component inside the upstream bundle", () => {
    expect(
      voiceboxComponentPathInBundle({
        bundlePath: "/tmp/Voicebox.app/",
        release: ARC_VOICEBOX_RELEASE,
      }),
    ).toBe("/tmp/Voicebox.app/Contents/MacOS/voicebox-server");
  });
});

describe("validateArcVoiceboxRelease", () => {
  const patch = (
    overrides: Partial<ArcVoiceboxRelease>,
  ): ArcVoiceboxRelease => ({
    ...ARC_VOICEBOX_RELEASE,
    ...overrides,
  });

  it("rejects a component digest that is not a sha256", () => {
    expect(
      validateArcVoiceboxRelease(patch({ componentSha256: "not-a-digest" })),
    ).toEqual({
      kind: "invalid",
      problem: "componentSha256 is not a lowercase hex sha256 digest",
    });
  });

  it("rejects a non-semantic version", () => {
    expect(validateArcVoiceboxRelease(patch({ version: "0.5" }))).toEqual({
      kind: "invalid",
      problem: "version 0.5 is not a semantic version",
    });
  });

  it("rejects a platform identity that is not platform-architecture", () => {
    expect(
      validateArcVoiceboxRelease(patch({ platform: "darwin arm64" })),
    ).toEqual({
      kind: "invalid",
      problem: "platform darwin arm64 is not a platform-architecture identity",
    });
  });

  it("rejects an empty expected version output", () => {
    expect(
      validateArcVoiceboxRelease(patch({ expectedVersionOutput: "  " })),
    ).toEqual({
      kind: "invalid",
      problem: "expectedVersionOutput is empty",
    });
  });
});

describe("voiceboxReleaseAvailability", () => {
  it("is available on the pinned platform", () => {
    expect(
      voiceboxReleaseAvailability(ARC_VOICEBOX_RELEASE, {
        platform: "darwin",
        arch: "arm64",
      }),
    ).toEqual({ kind: "available" });
  });

  it("reports the mismatch instead of pretending to run elsewhere", () => {
    expect(
      voiceboxReleaseAvailability(ARC_VOICEBOX_RELEASE, {
        platform: "linux",
        arch: "x64",
      }),
    ).toEqual({
      kind: "unsupported-platform",
      current: "linux-x64",
      pinned: "darwin-arm64",
    });
  });
});
