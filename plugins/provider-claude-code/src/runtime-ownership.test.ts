import { describe, expect, it } from "vitest";
import { claudeCodeOffersInstallationMaintenance } from "./runtime-ownership.js";

// A host application that supplies Claude Code's executable owns that runtime,
// so the provider must not offer provider-level installation maintenance: it
// would compare the machine's npm-global CLI against npm's latest tag and offer
// to update a binary the application does not run, competing with the
// application's own runtime manager.
describe("claude code provider installation maintenance", () => {
  it("is withdrawn when the host application supplies the runtime", () => {
    expect(
      claudeCodeOffersInstallationMaintenance({
        BB_CLAUDE_CODE_EXECUTABLE:
          "/Users/someone/Library/Application Support/Arc Agent/arc-runtimes/runtimes/claude-code/2.1.278/claude",
      }),
    ).toBe(false);
  });

  it("stays declared for a standalone server that resolves Claude from PATH", () => {
    expect(claudeCodeOffersInstallationMaintenance({})).toBe(true);
    expect(
      claudeCodeOffersInstallationMaintenance({
        BB_CLAUDE_CODE_EXECUTABLE: "  ",
      }),
    ).toBe(true);
  });
});
