import { describe, expect, it } from "vitest";
import {
  buildDesktopAboutDetails,
  createDesktopAboutPanelOptions,
  formatBuildAge,
  type DesktopAboutFacts,
} from "../src/desktop-about-panel.js";

function createFacts(overrides: Partial<DesktopAboutFacts> = {}): DesktopAboutFacts {
  return {
    applicationName: "Arc Agent",
    bbBaseVersion: "0.43.1",
    bbUpstreamCommit: "3e9bef842",
    buildDate: "2026-01-01T00:00:00.000Z",
    channel: "latest",
    claudeVersion: "2.1.0",
    codexVersion: "0.150.0",
    commit: "abc1234",
    electronVersion: "38.0.0",
    ompVersion: null,
    osArch: "arm64",
    osRelease: "24.0.0",
    osType: "Darwin",
    platform: "darwin",
    pluginSdkVersion: "1.2.3",
    version: "1.0.0",
    ...overrides,
  };
}

describe("desktop about panel provenance", () => {
  it("shows Arc's own version separately from the BB base it was built on", () => {
    const details = buildDesktopAboutDetails(createFacts(), null);

    expect(details).toContain("Version: 1.0.0");
    expect(details).toContain("Core based on BB: 0.43.1");
    expect(details).toContain("BB upstream commit: 3e9bef842");
  });

  it("shows each managed runtime's manifest-selected version", () => {
    const details = buildDesktopAboutDetails(createFacts(), null);

    expect(details).toContain("Codex: 0.150.0");
    expect(details).toContain("Claude Code: 2.1.0");
  });

  it("shows a runtime that has never been installed distinctly from unknown data", () => {
    const details = buildDesktopAboutDetails(createFacts(), null);

    expect(details).toContain("OMP: Not installed");
    expect(details).not.toContain("OMP: unknown");
  });

  it("shows an empty BB upstream commit as unknown rather than blank", () => {
    const details = buildDesktopAboutDetails(
      createFacts({ bbUpstreamCommit: "" }),
      null,
    );

    expect(details).toContain("BB upstream commit: unknown");
  });

  it("keeps the panel's headline version as Arc's version, not the BB base version", () => {
    const options = createDesktopAboutPanelOptions(createFacts());

    expect(options.applicationVersion).toBe("1.0.0");
    expect(options.applicationVersion).not.toContain("0.43.1");
  });

  it("never exposes secrets or filesystem paths through the About facts shape", () => {
    const facts = createFacts();
    const serialized = JSON.stringify(facts).toLowerCase();

    expect(serialized).not.toMatch(/token|secret|password|api[_-]?key/u);
  });
});

describe("formatBuildAge", () => {
  it("reports today for a build made moments ago", () => {
    const nowMs = Date.parse("2026-01-01T12:00:00.000Z");
    expect(formatBuildAge("2026-01-01T00:00:00.000Z", nowMs)).toBe("today");
  });

  it("reports null for an unparsable build date", () => {
    expect(formatBuildAge("not-a-date", Date.now())).toBe(null);
  });
});
