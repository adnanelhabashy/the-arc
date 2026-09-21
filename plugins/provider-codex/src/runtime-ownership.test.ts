import { describe, expect, it } from "vitest";
import { codexOffersInstallationMaintenance } from "./runtime-ownership.js";

// A host application that supplies Codex's executable owns that runtime, so
// the provider must not offer provider-level installation maintenance: it
// would install or update a different binary than the one that runs, and it
// would compete with the application's own runtime manager.
describe("codex provider installation maintenance", () => {
  it("is withdrawn when the host application supplies the runtime", () => {
    expect(
      codexOffersInstallationMaintenance({
        BB_CODEX_BRIDGE_APP_SERVER_COMMAND:
          "/Users/someone/Library/Application Support/Arc Agent/arc-runtimes/runtimes/codex/0.155.1/codex",
      }),
    ).toBe(false);
  });

  it("stays declared for a standalone server that resolves Codex from PATH", () => {
    expect(codexOffersInstallationMaintenance({})).toBe(true);
    expect(
      codexOffersInstallationMaintenance({
        BB_CODEX_BRIDGE_APP_SERVER_COMMAND: "   ",
      }),
    ).toBe(true);
  });
});
