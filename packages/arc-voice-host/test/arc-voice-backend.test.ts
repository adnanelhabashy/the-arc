import { describe, expect, it } from "vitest";
import { resolveArcVoiceBackend } from "../src/backend.js";
import { ARC_VOICE_BACKENDS } from "../src/types.js";

describe("resolveArcVoiceBackend", () => {
  it("selects MLX only for Apple Silicon macOS", () => {
    expect(resolveArcVoiceBackend({ platform: "darwin", arch: "arm64" })).toBe(
      "mlx",
    );
    expect(resolveArcVoiceBackend({ platform: "darwin", arch: "x64" })).toBe(
      "cpu",
    );
  });

  it("selects CUDA, XPU, and DirectML on Windows", () => {
    expect(
      resolveArcVoiceBackend({ platform: "win32", arch: "x64", gpu: "nvidia" }),
    ).toBe("cuda");
    expect(
      resolveArcVoiceBackend({ platform: "win32", arch: "x64", gpu: "intel" }),
    ).toBe("xpu");
    expect(
      resolveArcVoiceBackend({ platform: "win32", arch: "x64", gpu: "amd" }),
    ).toBe("directml");
    expect(
      resolveArcVoiceBackend({ platform: "win32", arch: "x64", gpu: "other" }),
    ).toBe("directml");
  });

  it("selects CUDA and ROCm on Linux", () => {
    expect(
      resolveArcVoiceBackend({ platform: "linux", arch: "x64", gpu: "nvidia" }),
    ).toBe("cuda");
    expect(
      resolveArcVoiceBackend({ platform: "linux", arch: "x64", gpu: "amd" }),
    ).toBe("rocm");
    expect(
      resolveArcVoiceBackend({ platform: "linux", arch: "x64", gpu: "intel" }),
    ).toBe("cpu");
  });

  it("falls back to CPU when no supported accelerator is reported", () => {
    expect(resolveArcVoiceBackend({ platform: "win32", arch: "x64" })).toBe(
      "cpu",
    );
    expect(resolveArcVoiceBackend({ platform: "linux", arch: "arm64" })).toBe(
      "cpu",
    );
    expect(resolveArcVoiceBackend({ platform: "freebsd", arch: "x64" })).toBe(
      "cpu",
    );
  });

  it("never returns a backend outside the declared set", () => {
    const platforms: NodeJS.Platform[] = [
      "darwin",
      "win32",
      "linux",
      "freebsd",
    ];
    const gpus = [
      undefined,
      "apple",
      "nvidia",
      "intel",
      "amd",
      "other",
    ] as const;

    for (const platform of platforms) {
      for (const gpu of gpus) {
        for (const arch of ["arm64", "x64"]) {
          expect(ARC_VOICE_BACKENDS).toContain(
            resolveArcVoiceBackend({ platform, arch, gpu }),
          );
        }
      }
    }
  });
});
