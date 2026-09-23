import { describe, expect, it } from "vitest";
import { resolvePermissionModeSelection } from "./useThreadCreationOptions";

function select(
  rawPermissionMode: "accept-edits" | "auto" | "full",
  permissionModes: readonly ("accept-edits" | "auto" | "full")[],
  permissionCeiling: "accept-edits" | "auto" | "full" = "full",
) {
  return resolvePermissionModeSelection({
    rawPermissionMode,
    permissionModes,
    permissionCeiling,
    providerId: "codex",
  });
}

describe("resolvePermissionModeSelection", () => {
  it("keeps the raw permission mode when the provider supports it", () => {
    expect(select("accept-edits", ["accept-edits", "auto", "full"])).toBe(
      "accept-edits",
    );
    expect(select("full", ["accept-edits", "full"])).toBe("full");
    expect(select("auto", ["accept-edits", "auto", "full"])).toBe("auto");
  });

  it("adapts an unsupported auto down to the highest mode below it", () => {
    expect(select("auto", ["accept-edits", "full"])).toBe("accept-edits");
  });

  it("falls back to the product default when a carried-over mode cannot be honoured", () => {
    expect(select("accept-edits", ["auto", "full"])).toBe("auto");
  });

  it("shows the only mode a full-only provider can run, whichever mode was carried over", () => {
    // The composer has to land on the one mode the provider can execute, so the
    // user sees it and can deliberately select it. The server refuses the same
    // combination with a message naming that mode, so the two agree.
    expect(select("accept-edits", ["full"])).toBe("full");
    expect(select("auto", ["full"])).toBe("full");
    expect(select("full", ["full"])).toBe("full");
  });

  it("lowers the selection to the machine ceiling", () => {
    expect(select("full", ["accept-edits", "auto", "full"], "auto")).toBe("auto");
    expect(select("full", ["accept-edits", "auto", "full"], "accept-edits")).toBe(
      "accept-edits",
    );
  });

  it("shows the only mode the machine permits when the provider fits nowhere", () => {
    expect(select("full", ["full"], "accept-edits")).toBe("full");
  });

  it("leaves the raw selection alone when the provider reports no modes", () => {
    expect(select("accept-edits", [])).toBe("accept-edits");
  });
});
