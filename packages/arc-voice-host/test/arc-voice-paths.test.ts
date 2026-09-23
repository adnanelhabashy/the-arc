import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createArcVoicePaths,
  VOICEBOX_EXECUTABLE_NAME,
} from "../src/paths.js";

const userDataPath = join("/", "arc-user-data");

describe("createArcVoicePaths", () => {
  it("places the runtime under the Arc-owned arc-runtimes tree", () => {
    const paths = createArcVoicePaths({ userDataPath });

    expect(paths.runtimeRoot).toBe(
      join(userDataPath, "arc-runtimes", "voicebox"),
    );
    expect(paths.manifestPath).toBe(
      join(userDataPath, "arc-runtimes", "voicebox", "runtime-manifest.json"),
    );
    expect(paths.stagingRoot).toBe(
      join(userDataPath, "arc-runtimes", "voicebox", "staging"),
    );
    expect(paths.executablePath).toBe(
      join(
        userDataPath,
        "arc-runtimes",
        "voicebox",
        "active",
        VOICEBOX_EXECUTABLE_NAME,
      ),
    );
  });

  it("redirects model storage into the Arc-owned voice directory", () => {
    const paths = createArcVoicePaths({ userDataPath });

    expect(paths.modelsRoot).toBe(join(userDataPath, "voice", "models"));
    expect(paths.profilesRoot).toBe(join(userDataPath, "voice", "profiles"));
    expect(paths.capturesRoot).toBe(join(userDataPath, "voice", "captures"));
    expect(paths.tempRoot).toBe(join(userDataPath, "voice", "temp"));
    expect(paths.stateRoot).toBe(join(userDataPath, "voice", "state"));
  });

  it("keeps every resolved path inside the Arc-owned user data directory", () => {
    const paths = createArcVoicePaths({ userDataPath });

    for (const path of Object.values(paths).filter(
      (value): value is string => typeof value === "string",
    )) {
      expect(path.startsWith(userDataPath)).toBe(true);
    }
  });
});
