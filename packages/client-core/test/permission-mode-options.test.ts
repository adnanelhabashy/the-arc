import { describe, expect, it } from "vitest";
import { permissionModeLabel, permissionModeValues } from "@bb/domain";
import { PERMISSION_MODE_OPTIONS } from "../src/prompt/permission-mode-options.js";

/**
 * The picker and the server's permission failure messages have to name a mode
 * identically: a message that says "select Full Access to run it" is only
 * actionable if the picker offers an option by that exact name. Both read
 * `permissionModeLabel`, so this pins the two together.
 */
describe("PERMISSION_MODE_OPTIONS", () => {
  it("offers every permission mode the domain knows, once each", () => {
    expect(PERMISSION_MODE_OPTIONS.map((option) => option.value)).toEqual([
      ...permissionModeValues,
    ]);
  });

  it("labels each mode exactly as the permission messages do", () => {
    for (const option of PERMISSION_MODE_OPTIONS) {
      expect(option.label).toBe(permissionModeLabel(option.value));
    }
  });

  it("marks only full access as a warning", () => {
    expect(
      PERMISSION_MODE_OPTIONS.filter((option) => option.tone === "warning").map(
        (option) => option.value,
      ),
    ).toEqual(["full"]);
  });
});
