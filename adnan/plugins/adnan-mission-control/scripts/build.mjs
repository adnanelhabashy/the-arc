// Builds Mission Control's production bundles and records what they were built
// from, so the tracked `dist/` can be checked against its sources.
//
// `dist/` is committed: the packaged app loads the bundle, not the TypeScript.
// Nothing else in the repository rebuilds it, so without a recorded input set a
// source change and its distributed bundle can drift apart silently — which is
// exactly what happened to the role-permission validation in `server.ts`.
//
// Run `pnpm --filter bb-plugin-adnan-mission-control build`, then commit the
// rebuilt `dist/`. `test/dist-bundle-current.test.ts` fails until both are done.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stampPath = join(pluginRoot, "dist", "source.stamp.json");

/** Directories and files `bb plugin build` reads to produce the bundles. */
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

function isBuildInput(relativePath) {
  const name = relativePath.split("/").pop() ?? "";
  return !name.includes(".test.") && !name.includes(".spec.");
}

function collectInputs() {
  const found = [];
  const walk = (absolutePath) => {
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

/** One digest over the sorted (path, content) pairs. Content-addressed, so a
 * touched-but-unchanged file does not invalidate the stamp. */
function digestOfInputs(inputs) {
  const overall = createHash("sha256");
  const perInput = {};
  for (const relativePath of inputs) {
    const digest = createHash("sha256")
      .update(readFileSync(join(pluginRoot, relativePath)))
      .digest("hex");
    perInput[relativePath] = digest;
    overall.update(`${relativePath}\u0000${digest}\u0000`);
  }
  return { digest: overall.digest("hex"), inputs: perInput };
}

function main() {
  console.log("[mission-control] building bundles");
  execFileSync("bb", ["plugin", "build", pluginRoot], {
    cwd: pluginRoot,
    stdio: "inherit",
  });

  const { digest, inputs } = digestOfInputs(collectInputs());
  writeFileSync(
    stampPath,
    `${JSON.stringify(
      {
        note: "Written by scripts/build.mjs. Regenerate by running the build, never by hand.",
        digest,
        inputs,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(
    `[mission-control] stamped ${Object.keys(inputs).length} inputs at ${digest}`,
  );
}

main();
