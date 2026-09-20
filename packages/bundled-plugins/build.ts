import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { BUNDLED_PLUGINS } from "../../apps/server/src/services/plugins/builtin-registry.js";
import {
  BUNDLED_MARKETPLACE_FILENAME,
  BUNDLED_MARKETPLACE_GENERATED_DIRECTORY,
} from "../../apps/server/src/services/plugin-catalog/bundled-marketplace-paths.js";

const root = resolve(import.meta.dirname, "../..");
const output = resolve(import.meta.dirname, "dist");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(
  resolve(
    root,
    "apps/server/src/generated",
    BUNDLED_MARKETPLACE_GENERATED_DIRECTORY,
    BUNDLED_MARKETPLACE_FILENAME,
  ),
  resolve(output, BUNDLED_MARKETPLACE_FILENAME),
);
const withoutSource: string[] = [];
for (const { name } of BUNDLED_PLUGINS) {
  if (!existsSync(resolve(root, "plugins", name, "package.json"))) {
    // Arc Agent fork: this plugin's sources are not part of this checkout.
    // Registry names are upstream truth, so it stays registered; it just is
    // not built or shipped from here.
    withoutSource.push(name);
    continue;
  }
  // A registry name with sources here must be a dependency of this package:
  // that is what makes turbo run its `prepare:bundled` before this copy, and
  // what makes a plugin source edit invalidate this build. Skipping silently
  // would ship no copy at all, and the packaged app would then load whatever
  // plugin artifact another installation left on the machine.
  const staged = resolve(root, "plugins", name, ".bundled-runtime");
  if (!existsSync(staged)) {
    throw new Error(
      `bundled-plugins: "${name}" has sources in this checkout but no prepared .bundled-runtime. ` +
        `Add "bb-plugin-${name}" to packages/bundled-plugins dependencies so "prepare:bundled" runs for it.`,
    );
  }
  await cp(staged, resolve(output, name), { recursive: true });
}
if (withoutSource.length > 0) {
  console.warn(
    `bundled-plugins: not built in this checkout (no plugin sources): ${withoutSource.join(", ")}`,
  );
}
