import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The distributed plugin is the bundle, not the TypeScript: the app loads
 * `dist/`, and `dist/` is committed. Nothing rebuilds it automatically, so a
 * source change without a rebuild ships stale behaviour with no signal — the
 * role-permission validation in `server.ts` was in exactly that state.
 *
 * `scripts/build.mjs` records a digest of the build inputs alongside the
 * bundles. This asserts the recorded digest still describes the sources on
 * disk, which fails the moment they diverge and stays failed until the build
 * runs.
 */

const pluginRoot = resolve(__dirname, "..");
const stampPath = join(pluginRoot, "dist", "source.stamp.json");

/** Must match `scripts/build.mjs`. */
const inputRoots = [
  "app.tsx",
  "server.ts",
  "package.json",
  "tsconfig.json",
  "components.json",
  "assets",
  "components",
  "hooks",
  "lib",
];

const ignoredDirectoryNames = new Set(["node_modules", "dist", ".git"]);

function isBuildInput(relativePath: string): boolean {
  const name = relativePath.split("/").pop() ?? "";
  return !name.includes(".test.") && !name.includes(".spec.");
}

function collectInputs(): string[] {
  const found: string[] = [];
  const walk = (absolutePath: string): void => {
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      for (const entry of readdirSync(absolutePath)) {
        if (ignoredDirectoryNames.has(entry)) continue;
        walk(join(absolutePath, entry));
      }
      return;
    }
    const relativePath = relative(pluginRoot, absolutePath).split("\\").join("/");
    if (isBuildInput(relativePath)) found.push(relativePath);
  };
  for (const root of inputRoots) walk(join(pluginRoot, root));
  return found.sort();
}

function digestOfInputs(inputs: readonly string[]): string {
  const overall = createHash("sha256");
  for (const relativePath of inputs) {
    const digest = createHash("sha256")
      .update(readFileSync(join(pluginRoot, relativePath)))
      .digest("hex");
    overall.update(`${relativePath}\u0000${digest}\u0000`);
  }
  return overall.digest("hex");
}

const BUILD_COMMAND =
  "pnpm --filter bb-plugin-adnan-mission-control build";

describe("distributed bundle matches its sources", () => {
  it("has a recorded build stamp", () => {
    const stamp = JSON.parse(readFileSync(stampPath, "utf8")) as {
      digest?: string;
      inputs?: Record<string, string>;
    };
    expect(stamp.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(stamp.inputs ?? {}).length).toBeGreaterThan(0);
  });

  it("was built from the sources currently on disk", () => {
    const stamp = JSON.parse(readFileSync(stampPath, "utf8")) as {
      digest: string;
      inputs: Record<string, string>;
    };
    const current = collectInputs();

    // Name the changed files first: the digest alone cannot say what to rebuild.
    const recorded = stamp.inputs;
    const changed = current.filter((path) => {
      const digest = createHash("sha256")
        .update(readFileSync(join(pluginRoot, path)))
        .digest("hex");
      return recorded[path] !== digest;
    });
    const removed = Object.keys(recorded).filter(
      (path) => !current.includes(path),
    );
    const stale = [...changed, ...removed];

    expect(
      stale,
      `dist/ is stale relative to these sources: ${stale.join(", ")}. Run: ${BUILD_COMMAND}`,
    ).toEqual([]);
    expect(digestOfInputs(current)).toBe(stamp.digest);
  });

  it("ships the bundle the stamp describes", () => {
    // A stamp with no bundle beside it would pass the digest check while the
    // app had nothing to load.
    for (const artifact of [
      "dist/server.js",
      "dist/server.meta.json",
      "dist/app.js",
      "dist/app.css",
      "dist/app.meta.json",
    ]) {
      expect(statSync(join(pluginRoot, artifact)).size).toBeGreaterThan(0);
    }
  });
});
