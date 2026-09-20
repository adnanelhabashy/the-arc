# Phase 10 Deploy Handoff — Build & Reinstall Arc Agent.app

Handoff written: 2026-09-19. Target: a fresh agent continuing the Arc
productization in `~/Projects/bb`.

## State of the work (do not redo)

- **Checkpoint commit already exists**: `2aa4c1aaa` on branch `self-contained`
  ("Arc productization Phases 7-10…", 190 files). It contains ALL of
  Phases 1–10. Do **not** commit again unless new changes appear; if they do,
  `git status` first and ask before committing.
- Prior commits on the branch: `58dc272e6` (Phases 5–6), `006da63f8`
  (Phases 0–4). Base `4113ce06` untouched. Not pushed (do not push without
  approval).
- Working tree is clean **except** a stray untracked file `000` at the repo
  root. Leave it alone (do not commit, do not delete).
- Full Phase 10 gate already passed in the dev app: 300/12 arc-domains,
  8/8 arc-core, 26/26 Mission Control, 389 passed / 3 known-failures desktop,
  4/4 server picker tests, 128/128 account-pool. See
  `adnan/arc-productization/IMPLEMENTATION_LOG.md` (Phase 10 section) and
  ADR-057..060 in `DECISIONS.md`.

## The remaining task (exactly this, nothing more)

1. Build a fresh production `Arc Agent.app` from commit `2aa4c1aaa`.
2. Reinstall it over `/Applications/Arc Agent.app`, **preserving `~/.bb`**
   (threads, settings, credentials, runtimes). Do not delete or migrate
   anything under `~/.bb`.
3. Launch the **installed** app (not the dev app).
4. Verify the Phase 10 UI surfaces are present and working (checklist below).
5. Stop. Do **not** begin Phase 11.

## Hard-won pitfalls (read before touching anything)

### 1. Quitting the app — what went wrong here

The previous agent force-killed app processes; the app kept respawning new
pids and the churn made a mess. **Do not `kill`/`pkill` the app.**

- First try: `osascript -e 'quit app "Arc Agent"'`, then wait and verify with
  `pgrep -fl "Arc Agent.app" | head`.
- If it is still running after ~10 s, **ask the user to quit Arc Agent
  manually** (Cmd+Q) and wait for confirmation. Do not escalate to SIGKILL
  without explicit user approval.
- There may also be a dev Electron and a dev server running from the checkout
  (`run-electron-dev`); leave them alone unless they hold port 22809, in which
  case ask the user to close them too. The packaged app needs 22809 free.

### 2. Build

```bash
cd ~/Projects/bb
git log --oneline -1        # must show 2aa4c1aaa
pnpm --filter @bb/desktop package
```

- `package` = `prepare-runtime` (turbo build of `bb-app`) +
  `prepare-arc-runtimes` (seeds bundled Codex/OMP runtimes; needs the download
  cache or network) + electron-builder `--mac --dir --arm64` (no publish, no
  DMG). Takes several minutes; run with a long timeout or in background.
- Output app: `apps/desktop/release/mac-arm64/Arc Agent.app`.
- Do **not** use `dist`/`desktop:build` — those pass `--publish always`.

### 3. Install (replaces only the app bundle)

```bash
ditto "apps/desktop/release/mac-arm64/Arc Agent.app" "/Applications/Arc Agent.app.new"
rm -rf "/Applications/.Arc Agent.staged.app"   # stale leftover from an older install
mv "/Applications/Arc Agent.app" "/Applications/Arc Agent.app.old"
mv "/Applications/Arc Agent.app.new" "/Applications/Arc Agent.app"
# verify it launches, then: rm -rf "/Applications/Arc Agent.app.old"
```

- Replace only the `.app`; **never** touch `~/.bb`. All user data, threads,
  settings, credentials, and the seeded Arc runtimes
  (`~/.bb/projects-bb-*/desktop/arc-runtimes/…`) live there and must survive.

### 4. Launch the installed app

```bash
open -a "/Applications/Arc Agent.app"
```

It spawns its own server on port 22809. Give it ~15 s. If you need CDP for
verification, relaunch with a debug port instead:
`"/Applications/Arc Agent.app/Contents/MacOS/Arc Agent" --remote-debugging-port=9223`
(run in background; do not `kill` it afterwards — quit via AppleScript or ask
the user).

### 5. Environment traps in agent shells

- `BB_SERVER_URL` / `BB_INSTANCE` may be exported in the shell and point at
  the wrong instance. Prefix CLI calls with `env -u BB_SERVER_URL -u BB_INSTANCE`
  (or the equivalent for your shell).
- The Mission Control plugin in the **installed** instance is installed *from
  source* (`adnan/plugins/adnan-mission-control`), so the rewritten Phase 10
  MC is picked up on app restart without reinstalling the plugin. Verify with
  `env -u BB_SERVER_URL pnpm bb:dev plugin list` — expect
  `adnan-mission-control` running and `arc-core` among the plugins on the
  server (`arc-core` is now a bundled default plugin — check the server log
  for `plugin arc-core… loaded`).

## Verification checklist (installed app, evidence required)

Server log: `~/.bb/projects-bb-*/logs/server.*.log` — confirm `arc-core`
loaded and no `arc.agents.list` HTTP 500s.

1. **Agents page** (Mission Control → Agents): exactly three cards — OMP
   (runtime 18.2.6 from `~/.bb` userData, truthful account state), Codex
   (0.155.1), Claude Code (setup-required / external state). Prepare/repair
   buttons per card; no update/rollback UI.
2. **Accounts page**: ChatGPT / Claude / OMP Providers groups; connect
   buttons; honest empty states. No "Account Pool" wording.
3. **OMP Providers**: Connect Provider opens the discovery dialog listing
   providers from the managed 18.2.6 broker (~75 entries, no hardcoding);
   search filters (try "kimi" → Kimi Code + Moonshot); OAuth and api-key
   classes shown. Do **not** run real OAuth login or submit real API keys.
4. **Usage & Limits**: dashboard grouped OMP / Codex / Claude Code; empty
   groups render honest "no usage sources" states (no accounts connected in
   this instance — that is correct, not a bug).
5. **Resource behavior**: with the app idle, `pgrep -fl "arc-runtimes"` shows
   no codex/claude/omp-acp processes; the OMP auth broker (if it started for
   discovery) idle-stops within ~60 s.

If any surface is missing or errors: read the server log first; the two bugs
already fixed in this work were (a) agent `availableActions` carrying
`reason: undefined` (rejected by the strict wire contract — fixed in
`packages/arc-domains/src/arc-agent/manager.ts`) and (b) `arc-core` missing
its node-backed `OmpSpawn` (fixed via `createNodeOmpSpawn` in
`plugins/arc-core/src/node-spawn.ts`). Suspect regressions of these first.

## Definition of done

Installed app launched from `/Applications`, all four checklist sections
verified with evidence, `~/.bb` intact, and a short report to the user.
Then stop. Phase 11 (runtime updates/rollback) is explicitly out of scope.
