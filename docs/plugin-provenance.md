# Builtin plugin provenance in a packaged app

A packaged Arc/BB app must run only plugin code that this checkout built. When
a builtin plugin cannot be resolved from the app's own bundle, the app must
fail loudly instead of loading a copy another installation left on the machine:
a stale copy silently changes product behavior, and nothing in the UI or the
logs says so.

## How a builtin plugin's root directory is resolved

`resolveBuiltinPluginRootPathForModuleDir`
(`apps/server/src/services/plugins/builtin-registry.ts`) tries four candidates
in order, relative to the server module directory:

| #   | Candidate                                              | Packaged app path                                             |
| --- | ------------------------------------------------------ | ------------------------------------------------------------- |
| 1   | `../../../packages/bundled-plugins/dist/<name>`        | missing (`node_modules/packages/…` does not exist)            |
| 2   | `builtin-plugins/<name>`                               | `<App>/…/bb-app/server/dist/builtin-plugins/<name>`           |
| 3   | `../../../plugins/<name>`                              | missing                                                       |
| 4   | `../../../../../plugins/<name>`                        | `<App>/Contents/Resources/plugins/<name>` — **never shipped** |

So a packaged app resolves a builtin plugin only through candidate 2, which is
populated by `@bb/bundled-plugins` → `bb-app` build. Everything else falls
through to candidate 4, which the desktop build does not create:
`apps/desktop/electron-builder.config.json` ships `resources/arc-runtimes`
only.

Resolution feeds three consumers, and each has its own failure mode:

- **The row.** `plugins.root_dir` in `~/.bb/bb.db` is persisted.
  `reconcileBundled` (`apps/server/src/services/plugins/plugin-registration.ts`)
  re-points a row when the resolved path has a readable manifest. When the read
  throws, it logs `bundled plugin <name> is unavailable` and `continue`s —
  **keeping the previous row**, which is how a different app's copy stays live.
- **The server artifact.** `resolveServerEntry`
  (`apps/server/src/services/plugins/plugin-runtime.ts`) serves
  `<rootDir>/dist/server.js` when the manifest's `server` entry is exactly that
  path (`isPackagedBuiltinEntry`). `prepare-bundled` rewrites the manifest that
  way (`packages/plugin-build/src/prepare-plugin-runtime.ts`), so packaged
  copies always run their prebuilt `dist/server.js`, never the TypeScript
  source.
- **The host/bridge artifact.** `loadHostArtifactCandidate` hashes
  `<rootDir>/dist/host.js` and the daemon caches it per digest at
  `~/.bb/plugin-host-artifacts/<pluginId>/<sha256>/host.mjs`
  (`apps/host-daemon/src/plugin-host-artifact-cache.ts`). Provider bridges run
  from that cache, so the digest — not the checkout — decides what executes.

A packaged app never rebuilds a packaged builtin: `loadHostArtifactCandidate`
and `loadAppBundleCandidate` rebuild only for `path` plugins and for builtins
whose entry is not `./dist/*.js`.

## Incident: provider-codex ran from `bb-original.app` (2026-09-20)

`provider-codex` was not part of the bundled set, so the packaged app could not
resolve it and the Sep-16 row survived:

```text
bb.db plugins row
  provider-codex  builtin  /Applications/bb-original.app/Contents/Resources/app.asar.unpacked/…
                           …/bb-app/server/dist/builtin-plugins/provider-codex
```

Evidence that this copy was the one executing:

- `dist/host.js` in that directory and
  `~/.bb/plugin-host-artifacts/provider-codex/e45e0601…/host.mjs` have the same
  sha256 (`e45e0601acc096c1a41fa3defbcc76985a27c409d5fbe3f24bbd353bfa17bb1a`),
  built 2026-09-12, stamped `sdkVersion 0.4.87`.
- Running `codex app-server` processes carried
  `-c model_providers.bb-account-pool.env_http_headers.x-bb-account-pool-token`
  only — no `x-bb-account-pool-pin` and no `x-bb-account-pool-thread-id`, which
  that build does not know about.

Consequence: Account Pooler received neither a pin nor a thread correlation, so
it fell back to priority order. A thread whose `accountKey` was the Plus
account was served by the Team account — the UI said Plus, the provider bills
Team — for every turn.

Two log lines make this class of defect visible:

- `bundled plugin <name> is unavailable: no readable package.json at <path>` at
  server start — the row was not re-pointed.
- `bundled-plugins: not built in this checkout (no plugin sources): <names>` in
  the build — the plugin was not assembled.

`plugin <id>: ignoring prebuilt dist/server.js (built with SDK …) — loading
from source` is **not** evidence that the app runs current source. When the
manifest's `server` entry already is `dist/server.js`, that branch returns the
same prebuilt file; the message only reports the SDK mismatch.

## The build invariant

- `packages/bundled-plugins/package.json` lists every bundled plugin whose
  sources exist in `plugins/<name>`. Turbo's `^prepare:bundled` runs for
  dependencies, so a missing entry means the plugin is never prepared, never
  assembled, and never packaged.
- `packages/bundled-plugins/build.ts` throws when a plugin with sources in this
  checkout has no `.bundled-runtime`, and reports the registry names it does
  not build here on a single line. It never skips silently.
- `packages/scripts/test/bundled-plugin-tasks.test.mjs` holds two invariants:
  every bundled plugin with sources declares `prepare:bundled` + `@bb/plugin-build`
  and is a dependency of `@bb/bundled-plugins`; and every `plugins/<name>`
  source is registered as bundled.
- At load time, `packagedBuiltinArtifactProblem` +
  `validatePluginArtifactMeta` reject a packaged builtin whose `dist/*.meta.json`
  is missing or does not match the plugin id, version, or artifact format.

## Rules

- Never hand-copy a plugin's `dist/` into an app bundle, and never rely on
  `reconcileBundled` to repair a wrong `plugins.root_dir`.
- Ship plugin code through `.bundled-runtime` only: `prepare-bundled` output
  with the packaged-form manifest, assembled by `@bb/bundled-plugins` into
  `builtin-plugins/<name>`.
- When adding sources under `plugins/<name>`, add that plugin's package name to
  `@bb/bundled-plugins` dependencies in the same change. The build and the
  assembly test both fail otherwise.
- Verify a packaged app by artifact, not by UI: the plugin's `root_dir` must
  point inside the app being launched, and
  `~/.bb/plugin-host-artifacts/<pluginId>/<digest>/host.mjs` must hash to the
  packaged `dist/host.js`.

## Residual risk

Registry names without sources in this checkout (27 at the time of writing, for
example `connect`, `keep-awake`, `side-chat`, the marketplace official plugins)
cannot be built here, so they keep resolving to whatever installation first
registered them. That is unchanged behavior, not a regression, but it is the
same hole. Restoring a plugin's sources and registering them as bundled closes
it; the build now fails loudly if the dependency entry is forgotten.

## Verification recipe

```bash
pnpm exec turbo run build --filter=bb-app
ls packages/bb-app/server/dist/builtin-plugins

sqlite3 ~/.bb/bb.db "select id, root_dir from plugins order by id;"
grep -c "no readable package.json" ~/.bb/logs/server-stdio.log

shasum -a 256 "<App>/Contents/Resources/app.asar.unpacked/node_modules/bb-app/server/dist/builtin-plugins/<name>/dist/host.js" \
              ~/.bb/plugin-host-artifacts/<name>/*/host.mjs
```
