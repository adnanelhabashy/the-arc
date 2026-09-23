import type { ArcVoiceBackend, ArcVoiceGpuVendor } from "./types.js";

export interface ResolveArcVoiceBackendArgs {
  platform: NodeJS.Platform;
  arch: string;
  gpu?: ArcVoiceGpuVendor;
}

export function resolveArcVoiceBackend(
  args: ResolveArcVoiceBackendArgs,
): ArcVoiceBackend {
  if (args.platform === "darwin") {
    return args.arch === "arm64" ? "mlx" : "cpu";
  }
  if (args.platform === "win32") {
    if (args.gpu === "nvidia") {
      return "cuda";
    }
    if (args.gpu === "intel") {
      return "xpu";
    }
    if (args.gpu === "amd" || args.gpu === "other") {
      return "directml";
    }
    return "cpu";
  }
  if (args.platform === "linux") {
    if (args.gpu === "nvidia") {
      return "cuda";
    }
    if (args.gpu === "amd") {
      return "rocm";
    }
    return "cpu";
  }
  return "cpu";
}
