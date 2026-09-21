// Phase 13 (BB upstream sync). These assert the Arc-specific facts a BB
// merge could silently revert: product identity, release ownership, and
// independent versioning. Deep behavioral coverage for runtime management,
// account routing, and OMP isolation already lives in their own suites
// (packages/arc-domains, plugins/account-pool, plugins/provider-acp) — this
// file does not duplicate it, it only guards the config surface a git merge
// touches directly. See docs/bb-upstream-sync.md.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), "utf8");

const STABLE_APP_ID = "io.github.adnanelhabashy.arcagent";
const NIGHTLY_APP_ID = "io.github.adnanelhabashy.arcagent.nightly";
const RELEASE_REPO = "adnanelhabashy/the-arc";

describe("Arc product identity", () => {
  it("electron-builder ships the stable Arc bundle id and product name", () => {
    const config = JSON.parse(read("apps/desktop/electron-builder.config.json"));
    expect(config.appId).toBe(STABLE_APP_ID);
    expect(config.productName).toBe("Arc Agent");
  });

  it("desktop-release-channel.mjs keeps stable and nightly identities distinct", () => {
    const src = read("apps/desktop/scripts/desktop-release-channel.mjs");
    expect(src).toContain(`appId: "${STABLE_APP_ID}"`);
    expect(src).toContain(`applicationName: "Arc Agent"`);
    expect(src).toContain(`appId: "${NIGHTLY_APP_ID}"`);
    expect(src).toContain(`applicationName: "Arc Agent Nightly"`);
  });
});

describe("Arc release ownership", () => {
  it("nightly desktop publish refuses to run outside the Arc release repo", () => {
    const workflow = read(".github/workflows/publish-bb-app.yml");
    expect(workflow).toContain(`github.repository }}" != "${RELEASE_REPO}"`);
    expect(workflow).toContain(`GH_REPO: ${RELEASE_REPO}`);
  });

  it("stable desktop publish refuses to run outside the Arc release repo", () => {
    const workflow = read(".github/workflows/build-desktop.yml");
    expect(workflow).toContain(`github.repository }}" != "${RELEASE_REPO}"`);
    expect(workflow).toContain(`GH_REPO: ${RELEASE_REPO}`);
  });

  it("the desktop update feed has no built-in fallback to a BB-controlled URL", () => {
    const src = read("apps/desktop/src/desktop-update-provider.ts");
    // The only mention of get-bb/bb here must be the comment explaining the
    // absence of a fallback, never a literal releases/download endpoint.
    expect(src).not.toMatch(/get-bb\/bb\/releases\/download/);
  });
});

describe("Arc independent versioning", () => {
  it("arc-version.json carries an Arc version and a separately-tracked BB provenance commit", () => {
    const versionFile = JSON.parse(read("apps/desktop/arc-version.json"));
    expect(typeof versionFile.arcVersion).toBe("string");
    expect(versionFile.arcVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof versionFile.bbUpstreamCommit).toBe("string");
    expect(versionFile.bbUpstreamCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("main.ts reads the Arc app version from getArcAppVersion, not Electron's app.getVersion", () => {
    const src = read("apps/desktop/src/main.ts");
    expect(src).not.toMatch(/\bapp\.getVersion\(\)/);
  });
});

describe("Forbidden regressions in Arc release-identity files", () => {
  // Curated, not tree-wide: this is the exact set of files that carry Arc's
  // release identity and that a BB merge conflict is most likely to touch.
  // Historical/provenance mentions elsewhere (ADRs, docs, the get-bb/bb-only
  // scheduled-job gates in mobile-e2e.yml / marketplace-v2-live.yml) are
  // deliberately out of scope — see Step 5 of docs/bb-upstream-sync.md.
  const files = [
    ".github/workflows/publish-bb-app.yml",
    ".github/workflows/build-desktop.yml",
    "apps/desktop/electron-builder.config.json",
    "apps/desktop/scripts/desktop-release-channel.mjs",
    "apps/desktop/src/desktop-update-provider.ts",
    "apps/desktop/arc-version.json",
  ];

  it.each(files)("%s has no dev.bb.desktop bundle id", (file) => {
    expect(read(file)).not.toMatch(/dev\.bb\.desktop/);
  });

  it.each(files)("%s has no literal get-bb/bb release-download URL", (file) => {
    expect(read(file)).not.toMatch(/get-bb\/bb\/releases\/download/);
  });
});

describe("OMP isolation env vars", () => {
  it("environment.ts still relocates OMP config through PI_CONFIG_DIR / PI_CODING_AGENT_DIR", () => {
    const src = read("packages/arc-domains/src/arc-runtime/environment.ts");
    expect(src).toContain('"PI_CONFIG_DIR"');
    expect(src).toContain('"PI_CODING_AGENT_DIR"');
  });
});
