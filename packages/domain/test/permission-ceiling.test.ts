import { describe, expect, it } from "vitest";
import { clampPermissionModeToCeiling } from "../src/shared-types.js";

describe("clampPermissionModeToCeiling", () => {
  it("keeps a mode that is already at or below the ceiling", () => {
    expect(
      clampPermissionModeToCeiling({
        ceiling: "auto",
        permissionMode: "accept-edits",
      }),
    ).toBe("accept-edits");
    expect(
      clampPermissionModeToCeiling({ ceiling: "auto", permissionMode: "auto" }),
    ).toBe("auto");
  });

  it("lowers a mode above the ceiling", () => {
    expect(
      clampPermissionModeToCeiling({ ceiling: "auto", permissionMode: "full" }),
    ).toBe("auto");
    expect(
      clampPermissionModeToCeiling({
        ceiling: "accept-edits",
        permissionMode: "full",
      }),
    ).toBe("accept-edits");
  });

  it("refuses to raise an unsupported mode to one the provider offers above it", () => {
    expect(
      clampPermissionModeToCeiling({
        ceiling: "full",
        permissionMode: "accept-edits",
        permissionModes: ["full"],
      }),
    ).toBeNull();
    expect(
      clampPermissionModeToCeiling({
        ceiling: "full",
        permissionMode: "auto",
        permissionModes: ["accept-edits", "full"],
      }),
    ).toBe("accept-edits");
  });

  it("picks the highest supported mode when the ceiling itself is unsupported", () => {
    expect(
      clampPermissionModeToCeiling({
        ceiling: "auto",
        permissionMode: "full",
        permissionModes: ["accept-edits", "full"],
      }),
    ).toBe("accept-edits");
  });

  it("returns null when the provider supports nothing under the ceiling", () => {
    expect(
      clampPermissionModeToCeiling({
        ceiling: "auto",
        permissionMode: "full",
        permissionModes: ["full"],
      }),
    ).toBeNull();
  });
});
