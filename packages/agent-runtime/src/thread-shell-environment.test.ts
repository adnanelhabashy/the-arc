import { describe, expect, it } from "vitest";
import {
  resolveThreadEnvironment,
  type ResolvedThreadEnvironmentEntry,
} from "./thread-shell-environment.js";

function entryFor(
  entries: readonly ResolvedThreadEnvironmentEntry[],
  name: string,
): ResolvedThreadEnvironmentEntry | undefined {
  return entries.find((entry) => entry.name === name);
}

describe("resolved thread environment diagnostics", () => {
  it("withholds credential values from the event while the child still receives them", () => {
    const resolved = resolveThreadEnvironment({
      baseShellEnv: {
        PATH: "/usr/bin:/bin",
        HOME: "/Users/someone",
        OPENAI_API_KEY: "sk-live-shell-secret",
      },
      contributedEnv: [
        {
          name: "OMP_AUTH_BROKER_TOKEN",
          value: "broker-token-xyz",
          reason: "Bearer token for Arc's OMP broker on this machine",
          source: { plugin: "arc-core" },
        },
        {
          name: "OMP_AUTH_BROKER_URL",
          value: "http://127.0.0.1:58860",
          reason: "OMP account credentials come from Arc's loopback broker",
          source: { plugin: "arc-core" },
        },
      ],
      environmentId: "env_1",
      projectId: "proj_1",
      threadId: "thr_1",
    });

    expect(entryFor(resolved.entries, "OPENAI_API_KEY")?.value).toEqual({
      masked: true,
    });
    expect(entryFor(resolved.entries, "OMP_AUTH_BROKER_TOKEN")?.value).toEqual({
      masked: true,
    });
    expect(entryFor(resolved.entries, "OMP_AUTH_BROKER_URL")?.value).toBe(
      "http://127.0.0.1:58860",
    );
    expect(entryFor(resolved.entries, "PATH")?.value).toBe("/usr/bin:/bin");

    expect(resolved.envVars.OPENAI_API_KEY).toBe("sk-live-shell-secret");
    expect(resolved.envVars.OMP_AUTH_BROKER_TOKEN).toBe("broker-token-xyz");

    expect(JSON.stringify(resolved.entries)).not.toContain(
      "sk-live-shell-secret",
    );
    expect(JSON.stringify(resolved.entries)).not.toContain("broker-token-xyz");
  });
});
