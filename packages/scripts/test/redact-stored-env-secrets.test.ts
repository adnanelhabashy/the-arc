import { describe, expect, it } from "vitest";
import { redactEnvResolvedRow } from "../src/commands/redact-stored-env-secrets.js";

function eventRow(
  entries: Array<{ name: string; value: unknown; source?: unknown }>,
): string {
  return JSON.stringify({
    type: "provider.env-resolved",
    threadId: "thr_1",
    entries: entries.map((entry) => ({
      reason: "why",
      source: { plugin: "account-pool" },
      ...entry,
    })),
  });
}

describe("stored provider env redaction", () => {
  it("masks credential-shaped values and leaves the rest of the event intact", () => {
    const result = redactEnvResolvedRow(
      eventRow([
        { name: "CODEX_POOL_AUTH_TOKEN", value: "live-hub-token" },
        { name: "CODEX_OPENAI_BASE_URL", value: "http://127.0.0.1:38886/hub" },
        { name: "PATH", value: "/usr/bin:/bin" },
      ]),
    );

    expect(result.changed).toBe(true);
    expect(result.names).toEqual(["CODEX_POOL_AUTH_TOKEN"]);
    const parsed = JSON.parse(result.data) as {
      threadId: string;
      entries: Array<{ name: string; value: unknown; reason: string }>;
    };
    expect(parsed.threadId).toBe("thr_1");
    expect(parsed.entries.map((entry) => entry.name)).toEqual([
      "CODEX_POOL_AUTH_TOKEN",
      "CODEX_OPENAI_BASE_URL",
      "PATH",
    ]);
    expect(parsed.entries[0]?.value).toEqual({ masked: true });
    expect(parsed.entries[0]?.reason).toBe("why");
    expect(parsed.entries[1]?.value).toBe("http://127.0.0.1:38886/hub");
    expect(result.data).not.toContain("live-hub-token");
  });

  it("leaves an already-masked or credential-free row untouched", () => {
    const alreadyMasked = eventRow([
      { name: "OMP_AUTH_BROKER_TOKEN", value: { masked: true } },
    ]);
    expect(redactEnvResolvedRow(alreadyMasked)).toEqual({
      changed: false,
      data: alreadyMasked,
      names: [],
    });

    const clean = eventRow([{ name: "PATH", value: "/usr/bin" }]);
    expect(redactEnvResolvedRow(clean).changed).toBe(false);
  });

  it("ignores a payload that is not a resolvable event", () => {
    expect(redactEnvResolvedRow("{not json").changed).toBe(false);
    expect(redactEnvResolvedRow("{}").changed).toBe(false);
    expect(redactEnvResolvedRow(JSON.stringify({ entries: "nope" })).changed).toBe(
      false,
    );
  });
});
