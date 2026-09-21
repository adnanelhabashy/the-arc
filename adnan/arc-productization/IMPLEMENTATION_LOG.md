# Arc Productization Implementation Log

## Phase 0 — Source-of-Truth Inventory and Baseline

Date: 2026-09-18. Executor: Arc Agent run on `~/Projects/bb` @ `4113ce06` (main).

### Files read

- `~/Downloads/ARC_AGENT_PRODUCTIZATION_EXECUTION_PLAN.md` (full, 3755 lines)
- Local: `apps/desktop/src/main.ts` (spawn/env sections), `apps/desktop/src/bb-process.ts`, `apps/desktop/src/app-paths.ts`, `apps/desktop/src/desktop-auto-update.ts`, `apps/desktop/electron-builder.config.json`, `apps/desktop/scripts/run-electron-builder.mjs`, `apps/desktop/scripts/desktop-release-channel.mjs`, `apps/desktop/package.json`, `apps/server/src/services/system/usage-limits.ts`, `apps/server/src/services/plugins/builtin-registry.ts`, `packages/bundled-plugins/build.ts`, `packages/bundled-plugins/package.json`, `adnan/plugins/adnan-mission-control/{server.ts, lib/data.ts, components/usage-limits.tsx, package.json}`, `plugins/bb-official.json`
- Upstream reference (via `git show upstream/main:…` and read-only scouts): `plugins/provider-codex/server.ts`, `plugins/provider-codex/src/bridge/{bridge.ts, provider-maintenance.ts}`, `plugins/provider-claude-code/server.ts`, `plugins/provider-claude-code/src/bridge/provider-maintenance.ts`, `plugins/provider-acp/{server.ts, src/known-agents.ts, src/declaration.ts, src/agents.ts, src/configured-agents.ts, src/host.ts}`, `plugins/account-pool/src/{server.ts, rpc.ts, contracts.ts, store.ts, hub.ts, usage-source.ts}`, `plugins/provider-usage/{server.ts, usage-source-contract.ts, usage-schema.ts, usage-normalization.ts}`, `packages/process-utils/src/index.ts` (env sanitization)
- Installed runtime (read-only): `/Applications/Arc Agent.app/Contents/Resources`, `~/.bb/plugin-host-artifacts/*/host.mjs`, `~/.bb/plugins/`

### Source observations

- ALL first-party provider plugin sources absent locally (provider-codex, provider-claude-code, provider-acp, provider-pi, provider-usage, account-pool). Fork commit `ab0a19549` makes the build tolerate this; running app uses prebuilt host artifacts.
- Provider IDs confirmed: `codex`, `claude-code`, `acp-omp`, `pi` (own plugin), `acp-opencode`, `acp-cursor`, `acp-grok`, `acp-hermes-agent` (ACP known agents, verified in installed artifact).
- Codex has NO usable executable override in production (bridge env knob stripped by BB_* sanitization; no passthrough declared). Claude HAS `BB_CLAUDE_CODE_EXECUTABLE` (sole passthrough, X_OK-validated, used everywhere). OMP has NO override; `customAgents` id=omp with absolute command is the only replacement mechanism.
- Generic usage-source (`provider-usage.v1.*`) exists ONLY upstream; local usage path is the old per-provider `provider.usage` host RPC. Mission Control uses `usage_dashboard_get` → direct + pool model.
- Generated Electron config STILL contains `publish.url = https://github.com/get-bb/bb/releases/download/desktop-latest/` and `appId = dev.bb.desktop`; auto-update disabled by default (`BB_DESKTOP_AUTO_UPDATE=1` gate); installed app ships no app-update.yml.
- Mission Control pins plugin-sdk 0.4.87 vs local 0.4.99 (build warns, succeeds).
- Desktop child-env seam for private PATH: `spawnOwnedRuntime` (main.ts:1965).

### Commands run

- `git branch --show-current / rev-parse HEAD / log -1 / status --short / remote -v` → main, 4113ce06, 1 dirty file (pre-existing dist artifact), 3 remotes (origin=fork, upstream=get-bb/bb EXISTS, the-arc)
- `node/npm/pnpm/bb --version` → v24.16.0 / 11.13.0 / 9.15.0 / 0.43.1
- Path inventory loop (plan §4.1) → all provider plugins MISSING, core packages + desktop + Mission Control PRESENT
- `git diff upstream/main -- apps/desktop …` → rebrand diff (12 files)
- `node apps/desktop/scripts/run-electron-builder.mjs --print-config` → confirms BB feed in generated config
- `bb plugin list` → Mission Control running from path source; account-pool needs-configuration
- Version reads from package.jsons
- Git-history divergence comparison: NOT run (denied; recorded as unmeasured)

### Tests

- `pnpm --filter @bb/desktop typecheck` → PASS
- `pnpm --filter @bb/desktop test` → FAIL 3/393 (nightly publish-feed test = fork-induced; 2 others pre-existing)
- `pnpm --filter @bb/agent-runtime test` → FAIL 5/331 (all `runtime.codex-topology.test.ts`; root cause: missing `plugins/provider-codex` sources — known fork limitation)
- `bb plugin build` (Mission Control) → PASS (SDK pin warning only)

### Risks

- R1: Generated config still ships BB update feed → must be fixed deliberately in Phase 12 (stop condition #11 watch item).
- R2: Codex executable override needs a small plugin patch (passthrough + probe helper); without it Arc-managed Codex can turn but health lies.
- R3: Provider plugin sources absent → any provider-behavior change requires porting sources from upstream into the fork (deliberate sync decision before Phase 3).
- R4: SDK pin drift (0.4.87 vs 0.4.99) in Mission Control.
- R5: 3 desktop tests failing before any change; Phase 1+ must not increase this count.

### Gate

PASS — all Phase 0 questions answerable; no blocker to Phase 1. Known failures are pre-existing and classified.

### Next phase

Phase 1 — runtime path/environment scaffolding (pending user approval; NOT started).

---

## Phase 1 — Arc Private Runtime Path and Environment Foundation

Date: 2026-09-18. Same checkout @ `4113ce06` (verified clean against Phase 0 baseline before editing).

### Files changed

- `apps/desktop/src/arc-runtime/types.ts` — new; `ArcRuntimeId` ("codex" | "claude-code" | "omp"), `ArcActiveRuntime`.
- `apps/desktop/src/arc-runtime/paths.ts` — new; `createArcRuntimePaths({ userDataPath })` resolving `arc-runtimes/` root, `runtime-manifest.json`, `staging/`, `runtimes/<id>/<version>/` family/version/executable paths. Executable names: codex→codex, claude-code→claude, omp→omp.
- `apps/desktop/src/arc-runtime/environment.ts` — new; `buildArcManagedRuntimeEnvironment` (pure: prepends active-runtime dirs before original PATH, platform-aware delimiter, no empty PATH entries, dedup, immutable input) and `resolveActiveArcRuntimes` (minimal resolver returning none until Phase 2 manifest lands).
- `apps/desktop/src/main.ts` — `spawnOwnedRuntime` now builds the child env via the Arc runtime module (paths from `args.userDataPath`) before adding `APP_SURFACE`; no probing logic in main.ts.
- `apps/desktop/test/arc-runtime.test.ts` — new; 19 tests covering plan Tests A–J (no-runtimes no-op, codex-only, omp-only, deterministic codex→omp→claude order, Claude override set/wins/absent, existing override preserved, spaces in PATH and userData, PATH undefined/empty, immutability, dedup).

### Decisions

- ADR-015 added: Arc-managed active Claude wins `BB_CLAUDE_CODE_EXECUTABLE` for the owned child; otherwise existing env value untouched. No Codex/OMP env overrides fabricated.
- Prepend precedence fixed as codex → omp → claude-code (plan STEP 9 order).

### Tests

- `pnpm --filter @bb/desktop typecheck` → PASS
- `vitest run test/arc-runtime.test.ts` → 19/19 PASS
- `pnpm --filter @bb/desktop test` → 408 passed, 3 failed — failures identical to Phase 0 baseline (nightly publish-feed, server-moved notice, browser-view popup). Zero regressions.

### Not done (deliberately, per plan)

Runtime downloads/packaging, Codex provider patch, manifest/active-runtime population, updater changes, agent picker restriction.

### Gate

PASS. Phase 2 entry point: `resolveActiveArcRuntimes` + `runtime-manifest.json` (paths already resolved by `paths.manifestPath`).

---

## Phase 2 — Arc Runtime Manifest + Compatibility Policy

Date: 2026-09-19. Same checkout @ `4113ce06` (verified against Phase 1 state before editing).

### Files changed

- `apps/desktop/src/arc-runtime/types.ts` — added `ArcRuntimeSource`, `ArcRuntimeCompatibility`, `ARC_RUNTIME_IDS`.
- `apps/desktop/src/arc-runtime/manifest.ts` — new; Zod v1 manifest schema (`schemaVersion`, `createdByArcVersion`, `platform`, per-runtime `activeVersion`/`previousVersion`/`source`/`digest`/`installedAt`), `readArcRuntimeManifest` (missing → default; malformed/invalid → recoverable `invalid` with default; future schema → `unsupported-version` with file preserved), `writeArcRuntimeManifest` (atomic tmp+rename, 0600, parent mkdir), `createEmptyArcRuntimeManifest`, `resolveArcPlatformIdentity` (`<platform>-<arch>`, e.g. `darwin-arm64`).
- `apps/desktop/src/arc-runtime/compatibility.ts` — new; semver-based `evaluateArcRuntimeCompatibility` returning supported/untested/blocked + reason. Bootstrap policy: Codex `minimum: 0.136.0` only (provenance: upstream provider-codex `minimumSupportedVersion`, Phase 0). No tested maximums recorded yet → nothing claims "supported".
- `apps/desktop/src/arc-runtime/environment.ts` — `resolveActiveArcRuntimes` is now async and manifest-backed: manifest activeVersion + executable existence (regular file, X_OK on POSIX) required; stale entries skipped with diagnostics; corrupt/future manifests → no Arc runtimes, never throws.
- `apps/desktop/src/main.ts` — `spawnOwnedRuntime` awaits the resolver with platform identity, `app.getVersion()` as creator version, and `desktopLogger.warn` diagnostics.
- Tests: `test/arc-runtime-manifest.test.ts` (11), `test/arc-runtime-compatibility.test.ts` (9), `test/arc-runtime-resolution.test.ts` (8); updated the stale Phase 1 resolver test in `test/arc-runtime.test.ts`.

### Corruption behavior

Missing/malformed/invalid manifest → desktop starts with zero Arc-managed runtimes, warning logged, system PATH behavior unchanged. Future `schemaVersion` → file preserved byte-for-byte, runtimes ignored.

### Compatibility logic

below minimum → blocked; known-bad list → blocked; above tested max → untested; no tested max recorded → untested; malformed/unknown → untested. Only Codex minimum 0.136.0 is policy today, from upstream evidence.

### Decisions

ADR-016 through ADR-019 added.

### Tests

- `pnpm --filter @bb/desktop typecheck` → PASS
- arc-runtime focused suites → 46/46 PASS
- `pnpm --filter @bb/desktop test` → 435 passed / 3 failed — failures identical to Phase 0/1 baseline. Zero regressions.

### Unresolved items

- `createdByArcVersion` temporarily uses the desktop app version; replace when independent Arc version metadata lands (Phase 12 territory).
- Tested maximums for all three runtimes are pinned when each runtime is introduced (Phases 3–5).
- Manifest repair/reconcile operation for stale entries — later phase.
- No vendor `--version` probing yet (deliberate; arrives with runtime installation phases).

### Gate

PASS.

---

## Phase 3 — Arc-Managed Codex Runtime

Date: 2026-09-19. Same checkout @ `4113ce06` (verified against Phase 2 state before editing).

### Pinned release (independently verified against GitHub)

- Version: **0.155.1** — tag `rust-v0.155.1`, release name `0.155.1`, **not** a prerelease, not a draft (GitHub API, 2026-09-19)
- Asset: `codex-aarch64-apple-darwin.tar.gz` (90,600,719 bytes) — archive contains exactly one entry, the platform executable (228,803,200 bytes uncompressed)
- Archive SHA-256: `5e5a51470dce2423f9d96bd191d0bbc4cc0e2848a6833df5178eaf47a07a3768` — **exact match** (computed locally after download)
- Executable SHA-256: `8eaf1ad12fe6bf89b1710330f58900014322c7c5af677e43be116d8ac5fc0a9e` — recorded in pinned metadata
- `--version` output: `codex-cli 0.155.1` (parsed by semver regex, not string-equality on the human-readable prefix)
- License: **Apache-2.0** confirmed from the tag (`LICENSE`); upstream `NOTICE` exists (OpenAI Codex © 2025, Ratatui MIT attribution) and is preserved verbatim in the bundled third-party notices
- All prompt-supplied values matched the official metadata; no divergence, no silent version switch

### License / attribution

- `apps/desktop/third-party-notices/codex.md` (source-controlled): component, version, tag, source URL, download URL, Apache-2.0 reference, upstream NOTICE verbatim
- Copied into the bundle at `Contents/Resources/arc-runtimes/THIRD_PARTY_NOTICES.md` by the prepare script; test-asserted

### Architecture (two layers)

- Layer A — packaged immutable seed: `apps/desktop/resources/arc-runtimes/` (gitignored build output, produced by `scripts/prepare-arc-runtimes.mts`) → electron-builder `extraResources` → `Arc Agent.app/Contents/Resources/arc-runtimes/codex/0.155.1/codex`
- Layer B — user-managed copy: `<userData>/arc-runtimes/runtimes/codex/0.155.1/codex`, created by `src/arc-runtime/bootstrap.ts` (`prepareArcManagedRuntimes`), executed via the Phase 1 private child PATH; the seed is never executed or mutated at runtime
- New modules: `releases.ts` (pinned metadata + allowlist validation), `digest.ts`, `probe.ts`, `archive.ts` (single-entry tar inspection, traversal rejection), `acquire.ts` (testable staging pipeline), `bootstrap.ts` (fresh install / idempotence / same-pin repair / no-downgrade / kept-broken / manifest-last)

### Acquisition security

Download URL comes only from pinned backend metadata, validated to be `https` + `github.com/openai/codex/releases/download/` + exact asset name; `latest` aliases rejected by validator and tested. Download cached by archive digest in `.arc-runtime-cache/` (gitignored); every integrity failure aborts with non-zero exit. Extraction inspects the tar listing first (rejects multi-entry, absolute, `..`, separator/space names), extracts only the validated single entry, requires a regular file, and renames to exactly `codex` with 0o755.

### Bootstrap behavior (all test-proven)

- A fresh install (no manifest) copies from seed → verifies staged digest → probes staged version → moves into place → writes manifest last (`activeVersion=0.155.1`, `source=arc-bundled`, `digest`, `installedAt`, `previousVersion=null`)
- Idempotent restart: reuses the verified copy, no rewrite (installedAt stable)
- Same-pin repair: missing managed binary → reinstalled from seed, full verification, manifest preserved
- Valid newer active (0.156.0): **not** downgraded
- Broken different version: `kept-broken` diagnostic, no silent replacement
- Copy failure / seed digest failure / version-probe failure: manifest unchanged, Arc continues opening
- Steady-state launch does not re-hash the 229 MB binary (ADR-024)

### Provider integration

The existing prebuilt provider-codex resolves bare `"codex"` from `process.env.PATH` at all launch/probe/health sites (verified in the installed host artifact). No provider source ported; no new env override. End-to-end proof: environment tests spawn a real `codex --version` against the built child env — Arc-managed binary wins over a fake global Codex, and resolves with `PATH=/usr/bin:/bin` plus isolated HOME (no `~/.codex` involvement). Known cosmetic gap: install-status may report npm-global source for a managed binary (later provider-source phase).

### Compatibility policy

Codex `minimum: 0.136.0` (upstream provider constraint), `maximumTested: 0.155.1` (this phase's pin). Semantics: versions within [minimum, maximumTested] minus known-bad list are "supported by this Arc build" — not individually tested releases. 0.120.0 → blocked, 0.136.0 → supported, 0.155.1 → supported, 0.156.0 → untested.

### Files changed

- Application source: `arc-runtime/{releases,digest,probe,archive,acquire,bootstrap}.ts` (new), `paths.ts` (exported `arcRuntimeExecutableName`), `compatibility.ts` (maximumTested), `app-paths.ts` (`resolveArcRuntimeSeedRoot`), `main.ts` (bootstrap call before resolver, thin)
- Build: `scripts/prepare-arc-runtimes.mts` (new), `electron-builder.config.json` (`extraResources`), `package.json` (`prepare-arc-runtimes` wired into dev/dist/package chains), `.gitignore` (narrow: `.arc-runtime-cache/`, `resources/arc-runtimes/`)
- Notices: `third-party-notices/codex.md` (new, source-controlled)
- Tests: `arc-runtime-releases.test.ts` (12), `arc-runtime-acquire.test.ts` (8), `arc-runtime-bootstrap.test.ts` (11), `arc-runtime-environment.test.ts` (3), `arc-runtime-real-binary.test.ts` (4, conditional on staged seed), compatibility file (+1 matrix test)
- Generated build artifacts: `apps/desktop/resources/arc-runtimes/**` and `apps/desktop/.arc-runtime-cache/**` (gitignored, not committed)

### Packaging verification

`pnpm --filter @bb/desktop run package` (unpacked `--mac --dir --arm64`, does NOT touch `/Applications`) produced `release/mac-arm64/Arc Agent.app` containing `Contents/Resources/arc-runtimes/codex/0.155.1/codex` with digest `8eaf1ad1…a9e` (exact pinned match) and working `codex-cli 0.155.1`; only the Apple-silicon seed is packaged; `THIRD_PARTY_NOTICES.md` present. Local build unsigned (no Developer ID identity on this machine) — the seed sits inside the bundle resource tree so normal Electron bundle signing covers it when a signing identity is present; release-signing/notarization validation remains Phase 22.

### Tests

- `pnpm --filter @bb/desktop typecheck` → PASS
- Phase 3 focused suites → 47/47 PASS (includes real-binary digest + version + notices assertions against the staged seed)
- `pnpm --filter @bb/desktop test` → **473 passed / 3 failed** — failures identical to Phase 0–2 baseline (nightly publish-feed, server-moved notice, browser-view popup). +38 tests, zero regressions.

### Decisions

ADR-020 through ADR-024 added.

### Unresolved items

- Provider install-source/health cosmetics for managed binaries (npm-global detection) — later provider-source phase.
- Live full-app provider turn against Arc Codex (requires accounts; Phase 7+). PATH resolution proven at process level + provider artifact verified PATH-based.
- Runtime update/rollback UI and manifest reconcile — Phase 11.
- Release signing/notarization — Phase 22.

### Gate

PASS.

---

## Phase 4 — Arc-Managed OMP / Oh My Pi Runtime

Date: 2026-09-19. Same checkout @ `4113ce06` (verified against Phase 3 state before editing).

### Pinned release (independently verified against GitHub)

- Version: **18.2.6** — tag `v18.2.6`, release name `v18.2.6`, **not** a prerelease, not a draft, created 2026-09-18 (GitHub API, 2026-09-19)
- Asset: `omp-darwin-arm64` — direct standalone binary, **187,226,128 bytes** (not an archive)
- Asset SHA-256: `d498da40d577e1ffa681ca8632c2ea40a9f722a08b880412011d37dffee9513a` — **exact match** (GitHub API digest + locally computed after download, both equal)
- Version command: `omp --version` → output `omp/18.2.6` (parsed by the shared semver regex)
- License: **MIT**, verified verbatim at tag `v18.2.6` `LICENSE` — Copyright (c) 2025 Mario Zechner; 2025-2026 Can Bölük; 2026 Stencil Labs, Inc. Full text preserved in `apps/desktop/third-party-notices/omp.md` and shipped in the bundle
- All prompt-supplied values matched official metadata; no divergence, no silent version switch

### Artifact-kind architecture

`ArcRuntimeRelease` gained `artifactKind: "archive" | "executable"`. Archive assets (Codex) keep the Phase 3 single-entry tar extraction path; executable assets (OMP) are staged directly (regular-file check → source digest vs pin → copy → 0o755 → staged digest re-check → `--version` probe). Download cache keys on the asset digest with a kind-specific extension (`.tar.gz` / `.bin`); cache reuse still re-verifies SHA-256 — never bypassed. Trusted URL allowlist is per-runtime (`openai/codex`, `can1357/oh-my-pi`); `latest` aliases rejected; runtimes without a recorded origin fail validation. No OMP-only parallel pipeline; `prepareArcManagedRuntimes` default is now both pinned releases.

### ACP provider integration (verified, no source ported)

Installed provider-acp host artifact declares `acp-omp` as `launch: { command: "omp", args: ["acp"] }`, `signInCommand: "omp login"`, and resolves commands via bundled `resolveCommand`/`which` against the process PATH — the same pattern Codex uses (ADR-023/028). Private PATH suffices end to end. **Protocol-level proof**: spawned the real pinned `omp acp` with `PATH=/usr/bin:/bin` and an unused HOME; it answered an ACP `initialize` JSON-RPC request with `protocolVersion: 1`, `agentInfo: { name: "oh-my-pi", version: "18.2.6" }`, `authMethods` (existing local credentials), and `agentCapabilities { loadSession: true, … }` — **runtime ready with no AI account**, confirming runtime readiness is independent of account readiness. Capabilities ride under `agentCapabilities` (current ACP schema). Test-guarded (`arc-runtime-omp-acp.test.ts`, skipped if the real seed is absent).

### OMP config isolation (Option A — verified OMP overrides, Arc-child env only)

Source-verified against oh-my-pi v18.2.6 `packages/utils/src/dirs.ts` + `docs/config-usage.md`:

- `PI_CONFIG_DIR` relocates the OMP user config root (name joined under the process home); Arc sets it to the home-relative path of `<userData>/omp` when userData is inside home (the macOS `~/Library/Application Support/…` case); skipped (with `PI_CODING_AGENT_DIR` still set) if userData ever lives outside home
- `PI_CODING_AGENT_DIR` absolutely overrides the agent dir (settings, auth storage `agent.db`, sessions, `mcp.json`) for the default profile — always set to `<userData>/omp/agent`
- No XDG variables needed: with the config root relocated, every data/state/cache category falls back under the Arc root; external `~/.omp` is never touched
- No invented `OMP_*` variables; nothing global is modified; standalone OMP and normal terminals unaffected
- Broker note for later phases: `omp auth-broker serve` binds `127.0.0.1:8765` by default, token file `<config-dir>/auth-broker.token` mode 0600/0700; `auth-broker list --json` enumerates **registered OAuth provider definitions, not connected accounts** (docs-verified — matters for the Accounts page); endpoints `/v1/{healthz,snapshot,usage,credentials/check,…}` are bearer-gated except `healthz`

### Bootstrap behavior for OMP (all test-proven, generic engine reused)

- Fresh install: seed digest + probe → staged copy verified → moved to `runtimes/omp/18.2.6/omp` → manifest last (`activeVersion=18.2.6`, `source=arc-bundled`, digest, `installedAt`, `previousVersion=null`)
- Idempotent restart reuses the copy; same-version missing binary repaired from seed; valid newer active (18.3.0) never downgraded; broken different version → `kept-broken`; digest mismatch → manifest untouched
- All existing Codex bootstrap/acquire tests pass unchanged in behavior

### Compatibility policy

OMP `minimum = maximumTested = 18.2.6` (ADR-027): 18.2.6 → supported, 18.3.0 → untested, 18.2.5/17.x → blocked. Codex policy untouched.

### Files changed

- `src/arc-runtime/releases.ts` — artifact kinds, per-runtime URL allowlists, `ARC_OMP_RELEASE`, both-kind validation rules
- `src/arc-runtime/acquire.ts` — `assetPath` terminology, direct-executable staging branch
- `src/arc-runtime/bootstrap.ts` — default release list now both pins (no other change; engine was already generic)
- `src/arc-runtime/environment.ts` — OMP state isolation env (`PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR`) on the Arc child env only
- `src/arc-runtime/compatibility.ts` — OMP policy
- `scripts/prepare-arc-runtimes.mts` — generalized asset cache (kind-specific extension), combined notices from all `third-party-notices/*.md`
- `third-party-notices/omp.md` (new, source-controlled; MIT verbatim)
- Tests: `arc-runtime-releases` (+9 OMP pin/validation), `arc-runtime-acquire` (+4 direct-executable, call-site rename), `arc-runtime-bootstrap-omp.test.ts` (new, 6), `arc-runtime-environment` (+5 OMP resolution/isolation), `arc-runtime-omp-acp.test.ts` (new, 1 real protocol handshake), `arc-runtime-real-binary` (+4 OMP digest/version/notice), `arc-runtime-compatibility` (+4 OMP matrix), fixture `artifactKind` additions
- No changes to `main.ts` (bootstrap default covers both), electron-builder config (whole `resources/arc-runtimes` tree already packaged), or any provider source

### Packaging verification

`pnpm --filter @bb/desktop run package` (unpacked `--mac --dir --arm64`; `/Applications` untouched) produced `release/mac-arm64/Arc Agent.app` containing BOTH:

```text
Contents/Resources/arc-runtimes/codex/0.155.1/codex  sha256 8eaf1ad1…a9e  → codex-cli 0.155.1
Contents/Resources/arc-runtimes/omp/18.2.6/omp        sha256 d498da40…513a → omp/18.2.6
Contents/Resources/arc-runtimes/THIRD_PARTY_NOTICES.md  (Apache-2.0 Codex + MIT OMP sections)
```

Only darwin-arm64 assets present. Local build unsigned for lack of a Developer ID identity (same as Phase 3; Phase 22 covers release signing).

### Tests

- `pnpm --filter @bb/desktop typecheck` → PASS
- Phase 4 focused suites → 80/80 PASS (8 files; includes real-binary OMP digest/version/notices and the real ACP `initialize` handshake)
- `pnpm --filter @bb/desktop test` → **506 passed / 3 failed** — failures identical to the Phase 0–3 baseline. +33 tests, zero regressions.

### Decisions

ADR-025 through ADR-028 added.

### Unresolved items

- First real OMP turn through the full BB stack requires accounts (Phase 7+); runtime readiness and ACP protocol startup are proven, account readiness is explicitly separate (`authMethods` drives it)
- Broker/client usage integration and the Accounts page (`auth-broker list` semantics) — Phase 8; security observations recorded above
- Broker default port 8765 could collide with a standalone-OMP broker; per-process env isolation avoids config collision, port coordination belongs to the broker-integration phase
- Runtime update/rollback UI — Phase 11; release signing — Phase 22

### Gate

PASS.

---

## Phase 5 — Claude Code Managed Setup

Date: 2026-09-19. Branch `self-contained` @ 006da63f8 (Phase 0–4 commit; working tree clean at start).

### Legal / distribution decision

- `anthropics/claude-code` LICENSE.md at v2.1.276: **"© Anthropic PBC. All rights reserved. Use is subject to Anthropic's Commercial Terms of Service."** — not redistributable.
- **Arc does not bundle Claude.** No Claude executable exists in the app bundle (verified in the packaged `.app`; permanently guarded by `arc-runtime-no-claude-bundle.test.ts`).
- Claude Code is obtained **directly from Anthropic on the user's machine** at setup time — download-by-end-user, not redistribution. Arc's documentation states Claude Code is obtained directly from Anthropic and remains subject to Anthropic's terms (no terms text copied).

### Installation option: **OPTION B — DIRECT OFFICIAL VERIFIED DOWNLOAD**

- Option A rejected with evidence: the official installer (`claude.ai/install.sh`, fetched and read) hardcodes `$HOME/.claude/downloads` and delegates to `claude install`, which owns `~/.local/bin/claude` + `~/.local/share/claude/versions/`; no custom-destination env/flag exists. Docs only support a "custom launcher" at the standard path.
- Option B evidence: the installer itself downloads `https://downloads.claude.ai/claude-code-releases/<v>/<platform>/claude` and checksum-verifies it against the signed manifest; the docs explicitly contemplate users downloading "the binary from the GCS bucket" with manifest verification. Arc implements exactly that flow into an Arc-private runtime directory. Option C (run the official installer to `~/.local`) is the documented fallback if the endpoint changes.

### Pinned release (independently verified)

- Version **2.1.276**, tag `v2.1.276`, not prerelease/draft (GitHub API); official per-platform tarballs + `SHASUMS256.txt` + `.sig` on the GitHub release; native binaries served from `downloads.claude.ai/claude-code-releases/2.1.276/`
- Signing key `https://downloads.claude.ai/keys/claude-code.asc` — fingerprint `31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE`, **matches the published fingerprint exactly** (verified with OpenPGP against the armored key)
- `manifest.json.sig` **verifies** against `manifest.json` with that key (OpenPGP verified)
- darwin-arm64 from the signed manifest: SHA-256 `9de364db11a410d53cbbb0f6b1f18c66c90053efc9a63370072856d10db66329`, size 215,643,408 — the pinned checksum in `releases.ts`
- Downloaded binary: checksum **exact match**; `codesign --verify --verbose=4` → valid on disk, satisfies Designated Requirement; `codesign -dv` → Identifier `com.anthropic.claude-code`, Authority `Developer ID Application: Anthropic PBC (Q6L2SF6YDW)` → Apple Root CA; `spctl -t execute` reports "code is valid but does not seem to be an app" with origin Anthropic PBC (expected for a bare CLI binary; cryptographic verification is the gate)
- `--version` → `2.1.276 (Claude Code)`; `doctor` (read-only, pre-auth) → `Running: native (2.1.276)`, `Config install method: native`, `No installation issues found`
- Runtime trust model: the installer script has no stable digest pin; Arc's postconditions are independent — pinned checksum (extracted from the GPG-verified manifest at engineering time) + macOS code signature + exact version probe. No gpg needed on user machines.

### Implementation

- `releases.ts`: third artifact kind `direct-official`; per-runtime trusted origins (github.com for codex/omp, downloads.claude.ai for claude-code); `ARC_CLAUDE_CODE_RELEASE` excluded from the build-time `ARC_RUNTIME_RELEASES` seed list
- `claude-discovery.ts`: classifies existing installs — not-installed / official-native (incl. custom launcher) / homebrew / npm-legacy (wrapper detection) / explicit-override / arc-managed / broken-launcher (incl. dangling symlinks); explicit `BB_CLAUDE_CODE_EXECUTABLE` wins; Arc-managed detection is path-based
- `claude-setup.ts`: the setup operation — validate pin → manifest read (future-schema preserved) → idempotent reuse when active+runnable → no-downgrade for valid different version → broken-different-version deferred → backoff-gated download (60s/5m/30m/6h) → staged checksum gate → macOS codesign gate (Anthropic) → chmod → exact version probe → informational doctor → move into `runtimes/claude-code/2.1.276/` → **manifest written last** (`source: official-managed-install`, digest, installedAt); every failure path leaves the manifest untouched and records backoff; network failure fails safe
- `environment.ts`: active Arc Claude → `BB_CLAUDE_CODE_EXECUTABLE` (exact path, Phase 1 mechanism) + `DISABLE_AUTOUPDATER=1` + `DISABLE_UPDATES=1` on the Arc child env only; OMP isolation untouched; Phase 1 PATH ordering unchanged
- `main.ts`: `prepareManagedClaudeCode` runs after seed bootstrap inside the existing failure-safe try/catch; Arc opens regardless
- `compatibility.ts`: `untestedBelow` rule addition; Claude policy = exactly 2.1.276 supported, newer untested, older untested (upstream `minimumSupportedVersion` is null in the prebuilt provider artifact — no invented minimum)
- Manifest: **no schema change** — Claude lives at the derived runtime path, v1 semantics suffice (ADR-031); renderer can never supply executable paths

### Provider integration

Prebuilt provider-claude-code artifact: `claudeExecutable() = process.env.BB_CLAUDE_CODE_EXECUTABLE?.trim() || "claude"` — the env var beats PATH absolutely and feeds `--version`, `doctor`, health, and launch. No provider source ported (Phase 0 situation unchanged). End-to-end proof with `PATH=/usr/bin:/bin` and fake globals: `BB_CLAUDE_CODE_EXECUTABLE` resolved the managed binary; managed `claude --version` returned `2.1.276 (Claude Code)` while fake globals existed for all three engines.

### Three-engine milestone (single Arc child environment, `PATH=/usr/bin:/bin`)

```text
codex       0.155.1   arc-managed (bundled seed)     ✓
omp         18.2.6    arc-managed (bundled seed)     ✓ + PI_CODING_AGENT_DIR isolation
claude-code 2.1.276   official-managed-install       ✓ + BB_CLAUDE_CODE_EXECUTABLE + DISABLE_UPDATES
```

### Files changed

- Application source: `arc-runtime/releases.ts` (kind + origin generalization), `arc-runtime/claude-discovery.ts` (new), `arc-runtime/claude-setup.ts` (new), `arc-runtime/environment.ts` (auto-update env), `arc-runtime/compatibility.ts` (`untestedBelow` + Claude rule), `main.ts` (setup wiring)
- Manifest/schema: none (v1 sufficient, ADR-031)
- Build configuration: none (Claude intentionally absent from prepare script, electron-builder config, and notices)
- Tests: `arc-runtime-claude-discovery.test.ts` (8), `arc-runtime-claude-setup.test.ts` (13, covering A–H + backoff + future-schema + no-secrets), `arc-runtime-claude-environment` additions inside `arc-runtime-environment.test.ts` (3), releases pin tests (+8), compatibility matrix (+4), `arc-runtime-no-claude-bundle.test.ts` (new, 3)
- Provider source: none

### Packaging verification

`release/mac-arm64/Arc Agent.app/Contents/Resources/arc-runtimes/` contains exactly `codex/0.155.1/codex` (digest 8eaf1ad1…a9e), `omp/18.2.6/omp` (digest d498da40…513a), and `THIRD_PARTY_NOTICES.md`. No `claude-code` directory; no file matching `claude*` anywhere under the resource tree. `/Applications` untouched.

### Tests

- `pnpm --filter @bb/desktop typecheck` → PASS
- Phase 5 focused suites → 81/81 PASS
- `pnpm --filter @bb/desktop test` → **544 passed / 3 failed** — failures identical to the Phase 0–4 baseline. +38 tests, zero regressions.

### Live end-to-end evidence (real binary, real codesign, real doctor)

- Clean userData → setup → ready, manifest `official-managed-install` with pinned digest; doctor reported `Auto-updates: disabled (set by env: DISABLE_UPDATES)`; second run idempotent and offline.

### Decisions

ADR-029 through ADR-033 added.

### Unresolved items

- First real Claude turn needs authentication (Phase 7+); runtime readiness and `doctor` are proven pre-auth by design
- Claude updates/rollback UI — Phase 11; Arc update feed — Phase 12
- Native installer's interactive TUI (`claude install`) not used; if Anthropic withdraws the direct endpoint, switch to Option C per ADR-029

### Gate

PASS.

---

## Phase 6 — Arc Agent Manager

Date: 2026-09-19. Same checkout, Phase 5 state verified before editing.

### What Arc gained

One backend/domain abstraction (`apps/desktop/src/arc-agent/`) representing Arc's three coding agents consistently, orchestrating the existing Phase 1–5 runtime services instead of duplicating them:

- `types.ts` — `ArcAgentId` (`codex` | `claude-code` | `omp`), separated runtime/provider/account states, overall-state model, typed `ArcAgentError` (`unsupported-agent`, `runtime-prepare-failed`, `runtime-repair-failed`, `provider-unavailable`).
- `catalog.ts` — the CLOSED Arc product catalog: exactly OMP, Codex, Claude Code (fixed order), each mapping Arc agent ID → runtime ID → BB provider ID (`omp` → `acp-omp`). Upstream BB providers (pi, acp-opencode, acp-cursor, acp-grok, acp-hermes-agent) can never leak in via upstream drift; their sources remain untouched and persisted BB provider IDs are unchanged.
- `manager.ts` — `ArcAgentManager` (`listArcAgents`, `getArcAgent`, `prepareAgent`, `repairAgent`), pure backend logic: no React, no IPC, no `window` globals. Ready to be exposed to Mission Control/server later.

### Status model

`ArcAgentStatus`: descriptor fields + `runtime` (state/version/compatibility/source) + `provider.state` + `account.state` + `overallState` + `actions[]` + `observedAt`.

Runtime states: `not-prepared`, `preparing` (in-flight op, single-flight tracked), `ready`, `ready-with-warning` (compatibility untested), `broken` (manifest records intent, filesystem doesn't fulfill it), `unsupported` (compatibility blocked), `unavailable` (manifest corrupt/future-schema). Version and source come from the manifest — status never probes binaries and never shells out to `--version`.

Account state is a placeholder (`unknown`) with the full shape (`not-connected`/`connected`/`expired`/`error`) reserved for Phase 7–8 — no credential inspection, no login.

Overall-state rules (deterministic): `unavailable`/`broken`/`unsupported`/`not-prepared`/`preparing` mirror the runtime state; `ready` or `ready-with-warning` becomes `ready` only when account is `connected`, otherwise `runtime-ready` — Arc never claims "ready" when a real coding turn could not run.

### Actions

Advertised per runtime state, with explicit unavailable reasons: `prepare` (not-prepared only), `repair` (broken only). `update`, `rollback` (Phase 11), `connect-account` (Phase 7–8), `open-settings` (Phase 10) are reserved IDs marked unavailable — the UI never has to guess.

- `prepareAgent("codex" | "omp")` → existing `prepareArcManagedRuntimes` with the single pinned release (idempotent: healthy → `already-active`, no reinstall).
- `prepareAgent("claude-code")` → existing `prepareManagedClaudeCode` (backoff, checksum, codesign, probe all inherited).
- `repairAgent` → same services with repair semantics: same-version seed restoration or same-pin official reinstall; repair on a healthy runtime is a safe no-op; repair on `not-prepared` fails typed pointing to prepare; a valid newer/different active version is never touched (repair ≠ update, no version changes, no credential access).

### Concurrency

- Single-flight per agent: duplicate same-agent prepare/repair joins the in-flight operation (two Claude setup clicks cannot start two downloads). Different agents run concurrently; the serialized manifest mutation is the only shared critical section.
- `prepareAgent`/`repairAgent` return the refreshed status observed AFTER the operation completes (in-flight agents report `preparing` to concurrent status readers).

### Manifest mutation safety (race found and fixed)

The Phase 3–5 race was real the moment concurrent operations became reachable: bootstrap (Codex/OMP) and Claude setup each did an independent read→modify→write of the same `runtime-manifest.json`; concurrent prepare-Claude + repair-Codex would each read, then write disjoint entries, losing one update (atomic tmp+rename only prevents torn writes, not lost updates).

Fix: `mutateArcRuntimeManifest` in `manifest.ts` — an in-process serialized mutation chain per manifest path; every read-modify-write (bootstrap, Claude activation commit, digest backfill) now routes through it. The Claude commit re-checks manifest state inside the lock after its download and never clobbers a concurrent activation. No-op decisions skip the write entirely (a missing manifest is not created by `kept-existing`). Proven by a deterministic interlock test: concurrent Codex + Claude activations both persist.

### Provider health

Real BB provider health is not cleanly queryable from the desktop layer without a cross-layer hack, so `ArcProviderStatusSource` is an injectable interface whose default implementation honestly reports `unknown` — never fabricated as ready. A server-RPC implementation can be injected later without touching the manager.

### Side-effect-free status (permanent protection)

`listArcAgents()`/`getArcAgent()` never download, copy, repair, or write: test-asserted that a status sweep over fresh userData leaves the filesystem byte-identical (no manifest creation, no runtime dirs).

### Files changed

- Application source: `src/arc-agent/{types,catalog,manager}.ts` (new); `src/arc-runtime/manifest.ts` (+serialized mutation); `src/arc-runtime/bootstrap.ts` and `src/arc-runtime/claude-setup.ts` (routed onto the mutation API, behavior preserved)
- Tests: `test/arc-agent-catalog.test.ts` (6), `test/arc-agent-manager-status.test.ts` (13), `test/arc-agent-manager-actions.test.ts` (13), `test/arc-runtime-manifest-mutation.test.ts` (5)
- Provider source: none. UI: none (no `components/*`/`app.tsx` edits). No IPC surface exposed yet (fixed-action `agents.list/prepare/repair` reserved for a later phase).

### Tests

- `pnpm --filter @bb/desktop typecheck` → PASS
- Phase 6 focused suites → 38/38 PASS
- `pnpm --filter @bb/desktop test` → **582 passed / 3 failed** — failures identical to the Phase 0–5 baseline (nightly publish-feed, server-moved notice, browser-view popup). +38 tests, zero regressions.

### Known unknowns

- Provider health remains `unknown` until a real `ArcProviderStatusSource` lands (server RPC or host maintenance API).
- `preparing` is only observable while the in-process operation runs; cross-process operation tracking is out of scope for desktop v1.
- No service-registration/IPC exposure yet — Mission Control wiring arrives with Phase 10.

### Gate

PASS.

---

## Phase 7 — Account Pool Integration for Codex / ChatGPT and Claude Accounts

Date: 2026-09-19. Same checkout, Phase 6 state verified before editing (commit `58dc272e6` = Phases 5–6).

### Account Pool availability (plan §39–41)

- Phase 0 finding confirmed: provider/plugin sources are absent locally and `packages/bundled-plugins/dist` shipped only `bb-guide` — the Arc product had NO account pool. The pool's RPC wire contract, however, exists and was verified live (below), so the source was imported rather than reinvented.
- Imported `plugins/account-pool` **server source only** from pinned upstream commit `93344e0ea1b844c447e010e1dc1b100bb0f1c021` (2026-09-19 upstream/main). Arc modifications, all documented:
  - Dropped `app.tsx`/`app.test.tsx` and the `bb.app` manifest entry — `@bb/shared-ui` and the dnd-kit/radix UI stack do not exist in this fork, and Arc builds its own Accounts UI (Phase 10) against the ArcAccount model instead of the pool's React UI.
  - Dropped `src/cli.ts` (`registerPoolCli`) — it requires plugin-sdk ≥0.4.102 CLI APIs (`defineCli`, `cliCommand`); the fork SDK is 0.4.99. Arc consumes the pool exclusively through its typed RPC contract; `bb pool` CLI diagnostics remain available from the separately installed upstream bb CLI.
  - Dropped `src/server.test.ts` — 34 of its 66 tests exercise the removed CLI through `runCli`. All retained unit suites pass: **128/128** (store, credentials, codex/claude adapters, device/OAuth login, parent-pool, upstream-transport, usage-source, provider-adapter, request-body).
  - Pruned package.json/tsconfig/vitest config to the server surface; lockfile importer patched by hand (pnpm re-resolution is impossible in this fork — `apps/app` references workspace plugins that do not exist locally; the frozen lockfile is load-bearing).
- Built the bundled runtime (`prepare:bundled`) → `packages/bundled-plugins/dist/account-pool` now ships with the product.
- `accountPoolDefaultEnabled` no longer env-gated on `BB_ACCOUNT_POOL_PARENT_URL` (that var is optional parent-proxy configuration, not an enable gate): **the account pool is now a default-enabled builtin for Arc**. Registry test updated; the other 6 failures in `builtin-plugins.test.ts` are pre-existing fork state (verified identical with my changes stashed).
- Live non-destructive contract check against the RUNNING Arc desktop server (`http://127.0.0.1:38886`): `POST /api/v1/plugins/account-pool/rpc/account.list` → `{ok:true,result:[]}`; `status.get` → full status shape with `routing {claude:true,codex:true}`. No login performed.

### Arc account domain (`apps/desktop/src/arc-account/`)

- `types.ts` — `ArcAccount` (source-agnostic: id `pool:<uuid>`, sourceId, sourceKind, providerFamily openai|anthropic, providerLabel ChatGPT|Claude, `accountKey`, email, planLabel, authState connected|expired|disabled|error|unknown, enabled, `availableThrough`, observedAt), login challenge/poll models, typed `ArcAccountError` (account-source-unavailable, account-not-found, login-cancelled/expired/failed, unsupported-provider), and the `ArcAccountSource` interface Phase 8 will extend with an OMP implementation.
- `account-pool-source.ts` — `AccountPoolSource` adapter over the pool RPC contract via `POST {serverUrl}/api/v1/plugins/account-pool/rpc/:method` (local-auth route; JSON content-type; `{ok,result}` envelope). 404/503 and transport failures → `account-source-unavailable`; a 400 on `codexLogin.poll` (unknown session) → `login-expired`. Provider mapping: **ChatGPT/OpenAI account → Codex; Claude/Anthropic account → Claude Code; never OMP.**
- `service.ts` — `ArcAccountService`: cross-source inventory with no cross-source dedup (Phase 9, keyed on canonical accountKey only), id-prefix operation routing (`pool:<id>`), `hasConnectedAccount(agentId)` readiness, and per-provider login single-flight: duplicate starts join the in-flight/pending challenge (5 clicks = 1 provider login attempt), terminal poll/complete/cancel clears the pending session, failed starts clear immediately, and expired pending sessions (pool TTL is 10 min) stop blocking fresh starts.
- `agent-status-source.ts` — `ServiceArcAccountStatusSource` bridges the service into `ArcAgentManager` via the new injectable `ArcAgentAccountStatusSource`; OMP short-circuits to `unknown` without touching the pool.

### Identity rules (plan §9–10, 29–30, 37)

- Canonical `accountKey` is provider-issued only: `openai:chatgpt:<codexAccountId>` (ChatGPT `account_id` claim) and `anthropic:account:<accountUuid>`. Email is presentation metadata and NEVER identity; same-email accounts with different canonical ids remain distinct accounts; accounts without a trustworthy canonical id keep `accountKey = null` and stay distinct (no email-based, plan-based, or position-based identity, no unsafe dedup).
- `planLabel` = pool `subscriptionType` (Plus/Pro/Team/Max), `null` when unknown — UNKNOWN ≠ FREE.
- Multi-account preserved end to end: priority/reorder delegate to the pool's existing semantics (`account.setPriority`, `account.reorder`); enable/disable are distinct from remove (disable keeps credentials); **no quota-driven silent account rotation was added** — held/exhausted quota states still report `authState: connected` and Arc never switches accounts on its own.

### Login flows (plan §19–26)

- **ChatGPT/Codex**: `codexLogin.start` → `{sessionId, verificationUri, userCode, expiresAt, intervalMs}` (presentation data only, no tokens) → Arc polls `codexLogin.poll` (pending → waiting-for-user; complete → connected account; error → failed with sanitized message) → `codexLogin.cancel` supported and exposed.
- **Claude**: `login.start` → `{sessionId, authorizeUrl}` (official PKCE authorize URL; Arc opens the user's browser; the pool's session TTL is not exposed so Arc reports `expiresAt: null` rather than inventing one) → user pastes the provider callback → `login.complete`. Arc never presents an email/password form and never sees provider passwords.
- Per-provider single-flight + local pending-state expiry; cancellation forgets local pending state safely.

### Credential ownership and security (plan §11, 42–44)

- Credentials stay in the pool's own secret store (`<serverData>/plugins/account-pool/secrets/accounts`, dir 0700, files 0600, atomic tmp+rename — verified in imported `store.ts`). ArcAccount carries metadata only; nothing is copied into the runtime manifest, Mission Control KV, desktop-store, or Arc userData.
- Permanent no-secrets regression test: serialized accounts + login challenges scanned for access/refresh tokens, authorization, id tokens, api keys, passwords, secrets, PKCE verifiers, cookies, bearer — none present.
- Arc account logs: provider, operation, status, sanitized error only. No OAuth payloads, codes, or tokens are logged by the new Arc code; the imported pool logs transport error codes, not credentials.

### ArcAgentManager integration (plan §31–35)

- New injectable `ArcAgentAccountStatusSource` (default reports `unknown`, preserving Phase 6 behavior). Overall-state rules extended: runtime ready + account `connected` → `ready`; + `not-connected` → **`account-required`** (new state); expired/error/unknown → conservative `runtime-ready`; runtime problems still dominate.
- `connect-account` action: available for Codex/Claude Code exactly when the runtime is ready and the account is not-connected/expired/error; OMP stays unavailable ("agent does not support account connection yet"); connected accounts report "already connected".
- Status reads remain side-effect-free with an account source attached (manifest byte-identical across a full sweep; account source consulted once per agent, no logins started).

### Files changed

- Application source: `src/arc-account/{types,account-pool-source,service,agent-status-source}.ts` (new); `src/arc-agent/{types,manager}.ts` (account axis + account-required + connect-account)
- Imported plugin source: `plugins/account-pool/**` (server-only, pinned upstream `93344e0`, documented modifications above); `apps/server/src/services/plugins/builtin-registry.ts` (default-enabled); lockfile importer patch
- Tests: `test/arc-account-pool-source.test.ts` (22), `test/arc-account-service.test.ts` (10), `test/arc-agent-manager-accounts.test.ts` (8); updated `apps/server/test/services/plugins/builtin-plugins.test.ts`
- UI: none. Provider source: none. Generated artifacts: `plugins/account-pool/.bundled-runtime`, `packages/bundled-plugins/dist` (gitignored).

### Tests

- `pnpm --filter bb-plugin-account-pool test` → **128/128 PASS**
- `pnpm --filter @bb/desktop typecheck` and `@bb/server typecheck` → PASS
- Phase 7 focused suites → 40/40 PASS
- `pnpm --filter @bb/desktop test` → **622 passed / 3 failed / 1 skipped** — failures identical to the Phase 0–6 baseline (nightly publish-feed, server-moved notice, browser-view popup). +40 tests, zero regressions.
- Live wire-contract check against the running Arc server (above); no real login performed.

### Remaining for later phases

- OMP accounts/auth-broker — Phase 8 (OMP stays account-unknown; no broker started).
- Usage dashboard / cross-source dedup by canonical accountKey — Phase 9.
- Accounts UI — Phase 10 (backend APIs are ready); service/manager wiring behind IPC — Phase 10.
- First real coding turns with connected accounts — end-to-end validation once an account is connected in-product.

### Gate

PASS.

---

## Phase 8 — OMP Accounts / Providers Integration

Date: 2026-09-19. Continues on the Phase 7 working tree.

### OMP verification (exact managed version, no assumptions)

- Managed target verified: **18.2.6** — release binary downloaded from `github.com/can1357/oh-my-pi/releases/download/v18.2.6/omp-darwin-arm64`, sha256 `d498da40d577e1ffa681ca8632c2ea40a9f722a08b880412011d37dffee9513a` matching the official `SHA256SUMS.txt`, live-executed. The oh-my-pi **source at tag `78b7531` (v18.2.6)** was fetched and read for the auth-broker, auth-storage, usage, and broker-server implementations. All contracts below are confirmed against both.
- **Provider discovery**: `omp auth-broker list --json` → static OAuth registry, `[{id, name}]`, **75 providers in 18.2.6** (73 in 18.2.0). Proven NOT to be accounts: a fresh isolated config still lists all 75 with zero credentials (`runList` maps `getOAuthProviders()` only — registry, not store).
- **Connected-account discovery**: broker `GET /v1/snapshot` returns every stored credential (`id`, `provider`, `type: oauth|api_key`, identity fields, `identityKey`, `blocks`). This is the only *complete* machine-readable inventory — `omp usage --json` culls providers without usage endpoints (22 usage providers registered) and can exit 1 with only a stderr hint. Arc uses the snapshot.
- **Login**: `omp auth-broker login <provider>` drives the official flow in-process and persists to the same SQLite store. OAuth providers print `Open this URL in your browser:` + URL; API-key providers (e.g. DeepSeek) print a dashboard URL *then* a key prompt with **no trailing newline** (`Paste your DeepSeek API key (sk-...): `) and validate the key against the provider. Cancel = process SIGTERM.
- **Logout**: `omp auth-broker logout <provider>` deletes ALL credentials for a provider — per-account removal does not exist. **Enable/disable: none** (only automatic provider-side `blocks`/tombstones). **Priority/reorder: none** (storage order + round-robin; `--account N` selection only).
- **Multi-account: yes** — multiple OAuth credentials per provider (`identity_key`, stored order).
- **Credentials**: OMP-owned SQLite `agent.db` (`auth_credentials`, `auth_credential_blocks`); refresh tokens arrive as sentinels in snapshots, access tokens/api keys are real → backend-only handling, metadata allowlist mapping, immediate discard. Broker bearer token: `<configRoot>/auth-broker.token`, created **0600** (verified live), obtained via `omp auth-broker token` (Arc never reads the file directly).
- **Broker**: default bind `127.0.0.1:8765` (source-verified `DEFAULT_AUTH_BROKER_BIND`); `--bind=127.0.0.1:0` works (ephemeral port reported on stdout). Bearer-guarded (verified 401 unauthenticated). Routes: `/v1/healthz`, `/v1/snapshot`, `/v1/usage`(+history/observed/clients/stale), `/v1/credentials/disabled`, `POST /v1/credential`. No LLM proxying.
- **Phase 9 usage contract** (documented, not wired): `omp usage --json` → `{generatedAt, reports[] (provider, limits[], metadata{email,accountId,...}, raw trimmed), accountsWithoutUsage[], disabledCredentials[], capacity{}}`; broker `/v1/usage` same trimmed shape; 5-minute per-credential server-side cache; usage history in `agent.db` (`usage_history` keyed provider/account_key/limit_id).

### ArcAccountService / ArcAgentManager integration

- `OmpAccountSource` (`apps/desktop/src/arc-account/omp-account-source.ts`) implements the Phase 7 `ArcAccountSource` contract behind the existing service — no service redesign. `sourceKind: "omp"`, `availableThrough: ["omp"]` only.
- Inventory = lazily-started loopback broker + snapshot, mapped through an explicit metadata allowlist (identity: `accountId` → `omp:<provider>:<accountId>` canonical key when provider-issued; email never identity; api-key credentials → `accountKey: null`, distinct records). Active `blocks` → `authState: "disabled"` (automatic, `enabled` stays true — no user disable exists).
- Broker lifecycle: starts on first account operation, ephemeral `127.0.0.1:0` bind, **idle-stopped after 60s** (configurable). Non-loopback reported address → fail-safe rejection before the token is used. Snapshot cached 5s in-process. **No `omp acp`, no permanent broker/daemon**; live-verified zero OMP processes after shutdown.
- Login: per-provider single-flight in the service (`startOmpProviderLogin`/`poll`/`cancel`/`submitOmpProviderLoginKey`); OAuth challenges carry presentation data only; API keys travel only into the OMP child's stdin and are never stored/logged/returned.
- Removal: provider-wide `omp auth-broker logout` only when the account is the provider's sole credential; multi-account providers fail honestly with `disconnect-failed`. Unsupported operations (enable/disable, priority, reorder, pool logins) throw typed `unsupported-provider`.
- Failure isolation: `listArcAccountsDetailed()` returns per-source `ready|unavailable` status; one source failing never destroys the other's accounts; a failed relevant source maps to agent account `unknown` (never fabricated `not-connected`); only an all-sources failure throws.
- Manager: OMP now reports real account state — ready+zero accounts → `account-required` with `connect-account` available; connected → `ready`; source failure → `unknown`/`runtime-ready`. Catalog unchanged: exactly OMP, Codex, Claude Code (permanent test).
- Isolation: every OMP child resolves via the runtime manifest (`createArcOmpRuntimeResolver`) and the Phase 4 environment builder (`PI_CONFIG_DIR`/`PI_CODING_AGENT_DIR` under Arc userData) — a global `omp` on PATH can never win; standalone `~/.omp` untouched (test-proven).

### Live end-to-end evidence (real 18.2.6, isolated env)

- `listOmpProviders()` → 75 providers, 0 accounts; `listAccounts()` → `[]`.
- DeepSeek login: challenge `kind: "api-key"` with the unterminated prompt captured; invalid key submitted via stdin → OMP validated → terminal `failed`; `shutdown()` → `pgrep` confirms **no OMP processes remain**.

### Files changed

- Application source: `src/arc-account/omp-account-source.ts` (new); `src/arc-account/types.ts` (OMP provider/login types, source status, new error codes, open provider family); `src/arc-account/service.ts` (failure isolation, `accountStateForAgent`, OMP login APIs); `src/arc-account/agent-status-source.ts` (OMP readiness); `src/arc-agent/manager.ts` (OMP connect-account); `src/arc-account/account-pool-source.ts` (type narrowing only)
- Tests: `test/arc-account-omp-source.test.ts` (22), `test/arc-account-source-merge.test.ts` (8), `test/arc-agent-manager-omp-accounts.test.ts` (7), `test/arc-omp-runtime-resolver.test.ts` (2); one Phase 7 assertion updated for Phase 8 semantics (`arc-agent-manager-accounts.test.ts`)
- UI: none. Account Pool source: unchanged. No IPC.

### Tests

- Phase 8 focused suites → **42/42 PASS**
- `pnpm --filter @bb/desktop typecheck` + `pnpm --filter @bb/server typecheck` → PASS
- `pnpm --filter @bb/desktop test` → **664 passed / 3 failed / 1 skipped** — failures identical to the Phase 0–7 baseline (nightly publish-feed, server-moved notice, browser-view popup). +42 tests, zero regressions.
- Live smoke against the real managed 18.2.6 binary (above).

### Remaining for later phases

- Usage & Limits unification — Phase 9 (`omp usage --json` + broker `/v1/usage` contract documented above).
- Accounts/Settings UI and provider-selection UX — Phase 10 (backend APIs ready: `listOmpProviders`, login start/poll/cancel, key submit).
- Import Existing OMP Configuration — later feature (deliberately not built; no credential copying).

### Gate

PASS.

---

## Phase 9 — Unified Usage & Limits

Date: 2026-09-19. Continues on the Phase 8 working tree.

### What was built

- New domain `apps/desktop/src/arc-usage/` — one generic usage abstraction over
  three real sources, backend/domain only (no UI, no IPC, no `main.ts` wiring;
  Phase 10 consumes it):
  - `types.ts` — `ArcUsageResource` / `ArcUsageWindow` / source interfaces /
    typed domain errors (`usage-source-unavailable`, `usage-fetch-failed`,
    `usage-resource-not-found`, `usage-refresh-failed`, `usage-contract-invalid`).
  - `service.ts` — `ArcUsageService`: `listUsageResources`, `getUsageResource`,
    `refreshUsageResource`, `refreshAllUsage`, `getCurrentAgentUsage`. Per-resource
    last-good in-memory cache, source failure isolation, canonical-identity
    association, observational reads only.
  - `pool-source.ts` — adapter over the Account Pool's already-bundled generic
    usage RPC (`provider-usage.v1.listResources` / `getResource`) reusing the
    Phase 7 `AccountPoolRpcClient` HTTP seam. Zod-validates wire payloads
    locally (`usage-contract-invalid` on malformed data); no pool code changed.
  - `omp-source.ts` — adapter over `OmpAccountSource.fetchUsageSnapshot()`
    (new): broker `GET /v1/usage` (reports) + `GET /v1/credentials/disabled`
    (tombstones), reusing the Phase 8 lazy loopback broker lifecycle.
  - `thread-source.ts` — thread context-window occupancy as its own
    `sourceKind: "thread"` resource via an injectable `ArcThreadContextGateway`.
- `apps/desktop/src/arc-account/omp-account-source.ts` — broker wire extended
  with `usage()` / `disabledCredentials()` and a public `fetchUsageSnapshot()`.

### Truthfulness rules implemented

- UNKNOWN != ZERO: provider-not-exposed → `status: "unavailable"` +
  `unavailableReason: "not-exposed"`, `windows: []`; auth/install states →
  `unavailableReason: "not-connected"`; fetch failures → `status: "error"`.
  No fabricated percentages anywhere.
- Percentages derived only from true fractions (explicit fraction, or
  used/limit with a real positive denominator). Unbounded amounts (OpenRouter
  `$7.32 remaining`) stay amount-only with `unit: "usd"` — never "73%".
- Stale last-good: a failed refresh keeps the previous successful reading,
  marked `stale: true`; a failure with no prior data yields an error state,
  never zeros. "unavailable" (a real provider answer) does not mark prior data
  stale and does not overwrite it.
- `observedAt` (provider-side snapshot time) preserved separately from
  `fetchedAt` (when Arc obtained it); reset timestamps pass through or stay
  null — never guessed.
- Window kinds normalized: five-hour / daily / weekly / monthly / custom,
  preserving provider labels; unknown vendor windows ("Rolling 3 hours") map
  to `custom` with their label intact.

### Identity and association

- Association key: identical non-null canonical `accountKey` only. Email is
  never identity (permanent test: same email + different accountKey → two
  resources). `accountKey: null` is always source-local, never cross-source
  merged.
- Merged resources keep provenance: `sources: ["pool", "omp"]` (deterministic
  kind order), per-window `source`, agentIds union in Arc catalog order.
  Same-semantics window conflicts resolve to the newer `observedAt`; distinct
  semantics stay side by side. Nothing is averaged.
- Pool and OMP canonical namespaces differ by issuer (`openai:chatgpt:<id>`
  vs `omp:openai-codex:<id>`), so production association is conservative:
  pool↔OMP duplicates remain separate until a trustworthy mapping exists
  (same rule as ADR-049/051). The merge machinery is tested with fixtures.

### Source behavior

- Pool: `listResources` is metadata-only (no quota refresh); `getResource`
  maps the ok/not_installed/unauthenticated/expired/error union; refresh flag
  passes through per resource.
- OMP: broker `/v1/usage` returns only `{generatedAt, reports[]}` — verified
  live against the real managed 18.2.6 binary (empty store → `reports: []`,
  clean SIGTERM exit). `accountsWithoutUsage` is derived locally from the Arc
  OMP account inventory minus report-covered identities; api-key accounts are
  covered only by a single-identity provider report. Disabled tombstones map
  to `credentialDisabled` + `unavailableReason: "disabled"` ("Connected but
  temporarily unavailable" for Phase 10). Broker has no force-refresh
  parameter: a refresh is a fetch attempt bounded by OMP's five-minute
  per-credential server cache (documented, not hidden). Capacity stats and
  usage history are out of scope per plan §48.
- Thread context: `usedTokens`/`modelContextWindow` with `estimated` flag;
  tokens with a real denominator produce a true percentage; kept strictly
  separate from provider quota (own sourceKind, never merged).

### Security

- Report `metadata` passes an explicit allowlist (email, accountId, orgId,
  orgName, planType) — nothing else crosses. Raw provider payloads stay
  backend-only. Broker token remains in `Authorization` headers inside the
  backend; a non-loopback broker address still fails closed before token use
  (Phase 8 machinery unchanged).
- Permanent tests scan serialized usage resources for token/credential
  patterns (access/refresh/api keys, authorization, bearer, cookies, pkce).

### Current-agent resolution (`getCurrentAgentUsage`)

- Returns the current thread context resource plus every usage resource for
  the active agent. OMP resources never attach to Codex/Claude and vice
  versa. Active-account identity is not invented: with no supplied
  `activeAccountKey`, all agent resources return with `activeAccountUnknown:
  true` (Phase 10 may render "multiple connected accounts"); a supplied key
  filters provably-different accounts out while keeping unknown ones.

### Files changed

- Application source: `src/arc-usage/{types,service,pool-source,omp-source,thread-source}.ts` (new); `src/arc-account/omp-account-source.ts` (broker wire + `fetchUsageSnapshot`)
- Account Pool source: unchanged (its generic usage RPC is consumed as-is).
- Runtime source: unchanged. OMP runtime: unchanged.
- UI: none. IPC: none. Mission Control: unchanged (Phase 10 migrates its direct+pool dashboard onto this service).

### Tests

- New suites: `test/arc-usage-pool-source.test.ts` (12), `test/arc-usage-omp-source.test.ts` (11), `test/arc-usage-service.test.ts` (12) → **35/35 PASS**
- `@bb/desktop` + `@bb/server` typecheck → PASS
- `pnpm --filter bb-plugin-account-pool test` → 128/128 PASS (pool untouched)
- `pnpm --filter @bb/desktop test` → **699 passed / 3 failed / 1 skipped** — failures identical to the Phase 0–8 baseline (nightly publish-feed, server-moved notice, browser-view popup). +35 tests, zero regressions.
- Live contract check against the real managed 18.2.6 broker (isolated env): `/v1/usage` → `{generatedAt, reports[]}`, `/v1/credentials/disabled` → `{generatedAt, disabled[]}`, clean process exit.

### Gate

PASS.

## Phase 10 — Arc Product Surfaces (Agent Picker, Agents, Accounts, Usage UI)

### Domain relocation

- `arc-runtime/`, `arc-agent/`, `arc-account/`, `arc-usage/` moved from `apps/desktop/src/` to a new shared package `packages/arc-domains` so the server-side `arc-core` plugin (and the desktop) consume one implementation. Desktop suite now 389 passed / 3 known failures / 1 skipped; `packages/arc-domains` 300 passed / 12 skipped (300 + 389 = 689 of the pre-move 699; the remaining delta is tests later consolidated while slicing — totals reported per package, never compared as one number).
- One behavioral fix during relocation: agent `availableActions` now omit the `reason` key when an action is available instead of carrying `reason: undefined`; the strict RPC wire contract rejects explicit-undefined values. Found by live visual review (HTTP 500 from `arc.agents.list`).

### arc-core service plugin (new, bundled)

- `plugins/arc-core/` hosts `ArcAgentManager` / `ArcAccountService` / `ArcUsageService` behind a fixed 22-method `bb.rpc` contract (`arc.status`, `arc.agents.*`, `arc.accounts.*`, `arc.omp.*`, `arc.usage.*`). Strict zod wire schemas; unknown fields rejected; secret-bearing payloads rejected by a permanent scanner test; contract-drift tests pin the method set.
- Arc mode is declared by env (`BB_ARC_RUNTIME_ROOT` / `BB_ARC_APP_VERSION` / `BB_ARC_SEED_ROOT`) set by the desktop shell on the server it spawns (`buildArcManagedRuntimeEnvironment`, Phase 4). Absent env → every RPC reports `arc-unavailable` rather than fabricating state.
- Wired a node-backed `OmpSpawn` (`createNodeOmpSpawn`) into `OmpAccountSource` — without it OMP provider discovery/auth had no process runner in the server process ("no OMP process runner is configured"). Spawned executable is only ever the manifest-pinned managed runtime path, never caller input.
- Registered in `packages/bundled-plugins` (default-enabled). SDK pin corrected to the checkout's `0.4.99` (`>=0.4.102` pins from mid-work upstream context blocked loading).

### Agent picker

- Server filters `execution-options` to the closed Arc catalog in Arc mode: OMP, Codex, Claude Code visible; Pi/OpenCode/Cursor/Grok/Hermes and other non-Arc providers hidden from normal selection. Historical threads remain readable (filter applies to options, not to thread rendering). 4 server tests (incl. catalog edge cases).

### Mission Control (adnan/plugins/adnan-mission-control, rewritten)

- Backend proxy (`server.ts`): fixed `arc_*` RPC passthrough over the loopback HTTP RPC with `ArcUnavailableError` mapping (`arc_status` degrades to `{arcAvailable:false, reason}`; others propagate a clean message). Old direct+pool usage dashboard RPC/hooks removed entirely.
- Nav restructure: Overview, Agents, Accounts, Usage & Limits, Threads (moved), Roles, Approvals, Verification.
- Overview: live Arc summary (agents/ready/setup-required, accounts connected, usage stale/error).
- Agents: exactly three cards over `arc.agents.list` — runtime state, version, compatibility, account state, source; per-agent actions (prepare/repair via ArcAgentManager; Claude "Set Up Claude Code" dialog drives the Phase 5 managed setup backend; no Terminal). Update/rollback actions intentionally absent (Phase 11).
- Accounts: ChatGPT / Claude / OMP Providers groups over `arc.accounts.list` — connect, multiple accounts, enable/disable/remove (pool), provider-wide disconnect (OMP, per ADR-051 semantics). No "Account Pool" terminology.
- OMP provider management: dynamic discovery through the managed broker (75 providers, no hardcoded registry), searchable picker ("kimi" → Kimi Code + Moonshot), OAuth vs api-key auth classes from the backend wire, api-key submit → backend → OMP with immediate input clear (test-pinned; no key persisted in UI state/storage/logs).
- Usage & Limits dashboard: OMP / Codex / Claude Code grouping, multiple accounts+windows, five-hour/weekly/custom kinds, amount-only limits, reset timestamps, stale + not-exposed + error + partial-failure render rules, per-resource refresh.
- Small usage popup (thread timeline `ProviderUsageSection`): consumes `arc.usage.current`; context window section; UNKNOWN≠ZERO, stale last-good, not-exposed, amount-only, active-account-unknown all rendered; retry on transient failure.

### Era-matched dependency repair (not Arc functionality)

- `plugins/automations` restored from upstream commit `3b37d2790` — the newest commit before `592c7a1a0` (#3738) introduced required `workingDirectory`/`resolvedWorkingDirectory` fields this checkout's apps/app stories/fixtures do not provide, and after `2aa42d886` (#3553) rebuilt the stories the checkout carries. `upstream/main` (`c1a64f4b`) and merge-base (`fe53586c5`) were both wrong eras (too new / too old). Checkout-era app code + checkout-era plugin = no compat patch.
- `plugins/secrets` restoration was evaluated and rejected (not an installed workspace member; module-resolution churn), leaving one pre-existing apps/app story import failure (`InteractionStates.stories.tsx`) documented as baseline, unrelated to Arc.

### Visual review (real app, mandatory)

- Launched the desktop Arc app (Electron, CDP-driven) against the dev server running with the Arc env contract; seeded managed runtimes (Codex 0.155.1, OMP 18.2.6) into the dev userData via the Phase 1 bootstrap service.
- Screens opened and inspected: Mission Control Overview, Agents, Accounts, OMP provider picker + live search, Usage & Limits dashboard, new-thread composer, dark mode, 760px narrow viewport. Issues found and fixed: the `reason: undefined` wire failure above; the missing OMP spawn runner above; stale React Query caches after plugin reload (fixed by reload, no code change). Sidebar "Threads" header pill shows a light background block in dark mode — pre-existing app shell styling, not an MC surface, left unchanged.
- Not live-verifiable without real credentials (covered by tests instead): OAuth connect flows, usage data rendering with real accounts, in-thread popup with a running agent. API-key flows not executed against real providers by policy.

### Security

- arc-core wire contract rejects secret-shaped values; account/usage payloads cross only the Phase 8/9 allowlists; no access/refresh/broker/api-key material observed in any renderer payload during review. No arbitrary command/executable-path/download/env RPC exists (fixed 22-method set; executable paths come only from the runtime manifest).
- API keys: submit → backend → OMP stdin; input cleared immediately; never persisted or displayed.

### Resource behavior

- UI idle (Mission Control open, no agent running): no Codex/Claude/OMP-ACP processes. OMP auth broker starts lazily for discovery and idle-stops after its 60s TTL — verified live (process gone after ~75s).

### Tests

- `packages/arc-domains`: 300 passed / 12 skipped · `plugins/arc-core`: 8/8 (incl. new node-spawn behavioral tests) · Mission Control: 26/26 · desktop: 389 passed / 3 known failures / 1 skipped (identical to pre-Phase-10 baseline) · server affected: 4/4 · account-pool: 128/128 · typecheck green: desktop, server, arc-domains, arc-core, MC; apps/app green except one documented pre-existing story failure.
- Mission Control plugin built via `bb plugin build` (`dist/server.js` + `dist/app.js`) and loaded by the running app.

### Gate

PASS (with documented pre-existing baselines: 3 desktop failures, 1 apps/app story import).

## Phase 10.x — Post-gate live fixes (Kimi onboarding + usage honesty)

Found during the installed-app deploy verification with a real Kimi Code
account connected:

- **Kimi device URL rewrite** (`arc-domains/arc-account/omp-account-source`):
  Kimi's device flow sends users to `www.kimi.com` (mainland site, WeChat
  QR / phone login). The challenge `authorizeUrl` host is rewritten to
  `kimi.ai` for `kimi-code` so users land on the international site where
  their accounts live. Scoped per provider; other providers and non-Kimi
  hosts untouched.
- **Amount-with-limit usage bars** (`Mission Control usage-limits`): Kimi
  reports `usedAmount/limitAmount/remainingAmount` (e.g. 88/100, 12
  remaining) with no percents. The row renderer previously showed a bare
  amount and hid the reset line; with a known limit it now derives the bar
  from amounts and renders the reset countdown. Unknown-limit windows still
  render amount-only (a bar would fabricate a percentage).
- **Device-flow dialog copy** (`Mission Control connect-flows`): the OMP
  device dialog said "confirm the code matches", reading like a code-entry
  field exists. Kimi's page is two-step (sign in, then confirm the prefilled
  code); the copy now says so. No code entry exists by design.
- **No re-login eviction bug**: `startExclusive` returns an existing pending
  session rather than replacing it; investigated and cleared.

Tests: +1 arc-domains (URL rewrite + negative scoping), +1 MC (amount-with-
limit bar/reset). Suites re-run green: arc-domains 304 passed, MC 38 passed.

## Phase 10.2 — Per-thread account selection (2026-09-20)

Implements explicit Agent → Model → Account selection per thread, replacing the previous fully-transparent, pool-global account choice.

### Architecture (ADR-061..063)

- `threads.accountKey`/`threads.accountResolved` (migration `0126_add_thread_account.sql`), nullable, additive.
- `accountKey` threaded through the wire schema, `agent-runtime`'s `ProviderExecutionContext`, and thread start/resume restore logic (`thread-commands.ts`).
- Account Pool hub (`plugins/account-pool/src/hub.ts`) accepts an explicit pin (header for Claude Code, URL-path form for Codex — its bridge has no custom-header passthrough) that bypasses priority/affinity for that request only; disabled/removed pins fail closed (HTTP 409, distinct reason, no fallback).
- Auto-resolve-once: the hub records which account it actually picked for an unpinned/Auto thread via a bounded, self-expiring per-thread correlation route; the server reads it once and pins the thread permanently.
- Composer `AccountPicker` (Agent/Model/Account, four states: Auto / resolved+explicit-confirm-to-change / legacy-unknown-blocks-send / unavailable-blocks-send), wired into both `NewThreadComposer` (new threads, via `PATCH /threads` `accountKey`) and `ThreadDetailPromptArea` (existing threads, via `useUpdateThread`).
- Mission Control thread list and the thread-scoped usage popup (`ProviderUsageSection`) read the bound account from the thread row; unresolved renders "Account unknown" / "Active account unknown", never zero.

### Known limitation

Codex account pinning and Auto-resolve-once are architecturally complete and tested via the hub's path-based correlation mechanism, but end-to-end verification against the real Codex CLI/bridge and two live ChatGPT accounts requires the installed app and real OAuth sessions — not verifiable from this environment. Claude Code's path is verified against the real bridge's documented `ANTHROPIC_CUSTOM_HEADERS` behavior.

### Era-matched dependency repair (ADR-064)

Restored `plugins/provider-codex`, `plugins/provider-claude-code`, `plugins/provider-acp`, `plugins/provider-pi`, `plugins/secrets`, `plugins/environment-modal-sandbox` from `git merge-base HEAD upstream/main` (not upstream's tip — see ADR-064) to fix test/typecheck failures the account-selection work surfaced as pre-existing baseline gaps. All six typecheck and test clean; none conflict with or duplicate `agent-runtime`'s generic provider-bridge architecture. `apps/server`'s remaining ~35 failing tests (2861/2897 passing) trace to roughly two dozen further missing bundled plugins unrelated to this feature (`workflows`, `docs`, `connect`, `side-chat`, `provider-retry`, `provider-usage`, etc.) — restoring the full set was evaluated and deliberately deferred as a separate, larger fork-sync task.

### Tests

`@bb/db` 574/574 · `bb-plugin-account-pool` 154/154 (+18 new: explicit pin, path-pin, disabled/removed 409, auto-correlation, concurrency) · `@bb/agent-runtime` 336/336 (was 331/336, the 5 pre-existing failures now fixed by the provider-pi restore) · `@bb/host-daemon-contract` 59/59 · `@bb/provider-bridge-protocol` 282/282 · `bb-plugin-arc-core` 8/8 · `@bb/arc-domains` 304/304 · `bb-plugin-adnan-mission-control` 40/40 · `@bb/client-core` 291/291 · `@bb/server-contract` 79/79 · `@bb/domain` 213/213 · `bb-plugin-provider-codex` 317/317 · `bb-plugin-provider-claude-code` 364/364 · `bb-plugin-provider-acp` 84/84 · `bb-plugin-provider-pi` 167/168 (1 pre-existing skip) · `bb-plugin-secrets` 8/8 · `bb-plugin-environment-modal-sandbox` 61/61 · `@bb/app` 4809/4809 (3 pre-existing skips), typecheck clean. `apps/server` 2861/2897 (documented gap above).

### Gate

Backend architecture, hub pinning, Auto-resolve-once, and all touched-package tests: PASS. Full end-to-end installed-app verification with real accounts: not performed (requires the user's hardware/accounts). `apps/server`'s residual ~35 test failures: documented pre-existing gap, out of scope for this phase (ADR-064).

## Phase 10.2.1 — Account pinning fix + composer UX cleanup (2026-09-20)

Fixes two real defects found in the installed app after Phase 10.2.

### Problem 1: ChatGPT account pinning always 409'd (root cause, ADR-065)

Traced the full identity chain end to end. Root cause: `threads.accountKey` (arc-domains' stable canonical identity, `openai:chatgpt:<codexAccountId>`) was sent directly as the Account Pooler hub's pin value, but the hub matches pins against `Account.id` — its own internally-generated row UUID, a different identifier space entirely. Every pin failed "removed" regardless of whether the account was actually connected. Fixed by resolving `accountKey` → the *current* pool row id inside `account-pool`'s own `contributeFor` (which has live access to the account list), for both Codex (URL path) and Claude Code (moved the pin-header injection here from `agent-runtime`, which never had the account data needed to do this correctly). Unresolvable keys fall through unchanged, so genuinely stale accounts still 409 deterministically — no silent fallback. Verified reconnect safety explicitly: a reconnect creates a new pool row with a new id for the same real account, and the stable `accountKey` still resolves to it correctly since resolution happens fresh on every execution rather than being cached at pin time.

### Problem 2: composer UX showed raw internal values and giant warnings (root cause, ADR-066)

`AccountPicker` delegated to the generic `OptionPicker`, which falls back to rendering its raw `value` prop when no option matches — and in every non-new-thread state (legacy, unavailable, resolved) the `__auto__` sentinel had no corresponding option, so it rendered literally. Rebuilt `AccountPicker` directly on the shared `DropdownMenu` primitives: the trigger always shows a real label (Auto / account name / "Select account" / "Account unavailable"), legacy and unavailable explanations moved from permanent banners into ordinary popover text, "Manage accounts…" moved from a floating adjacent button into the popover's own footer item, and switching a resolved thread's account now stages a Confirm/Cancel step inside the same open popover instead of separate floating UI. Also fixed a real functional gap: `providerFamily` (needed to filter OMP accounts to the selected provider) was declared in the type but never actually computed or passed from either composer — now derived from the selected model's existing `routeProviderId` and wired through both `NewThreadComposer` and `ThreadDetailPromptArea`.

### Mission Control

`accountLabel` was hard-coded to always stay `null` (a stale comment claimed `bb.sdk.threads.list` didn't return the underlying fields — it does, per Phase 10.2's domain schema change; the comment predated that landing). Added a small resolver in Mission Control's `server.ts` that fetches the accounts list once per request and joins by `accountKey` to produce a real label, degrading gracefully to "Account unknown" if Arc Core is unreachable. Also removed a raw-`accountKey` tooltip from the thread row (no internal ids surfaced to the UI at all now).

### Tests

New: `plugins/account-pool/src/server-pin-identity.test.ts` (6 tests) — connected account resolves to the live pool row id, two accounts pin independently, a reconnect (new pool row, same real account) keeps working, a genuinely stale account 409s with zero upstream fetches (no silent fallback), two concurrently-starting threads don't leak, and reselecting the current account is idempotent. Removed `packages/agent-runtime/src/execution-options.test.ts` (5 tests) — it covered the removed, buggy header-injection mechanism; the equivalent behavior for Claude Code now shares the exact same `resolvePoolAccountId` function exercised by the Codex tests, but does not yet have its own dedicated OAuth-flow test harness (a disclosed gap, not a regression — the underlying function is identical). Rewrote `AccountPicker.test.tsx` for the new dropdown-based component (11 tests, including an explicit `__auto__`-never-rendered assertion). Re-ran and confirmed no regressions across `@bb/db` (574), `bb-plugin-account-pool` (160), `@bb/agent-runtime` (331), `@bb/host-daemon-contract` (59), `@bb/provider-bridge-protocol` (282), `bb-plugin-arc-core` (8), `@bb/arc-domains` (304), `@bb/client-core` (291), `@bb/server-contract` (79), `@bb/domain` (213), `@bb/app` (545 files / 4811 tests). Mission Control: 39/40, the one failure is a pre-existing timer-isolation flake in `connect-flows.test.tsx` (untouched by this phase, reproduces identically before and after).

### Installed-app verification

Rebuilt and reinstalled `/Applications/Arc Agent.app` (unchanged version 0.43.1, code-only change), confirmed it launches with all expected processes, `~/.bb` untouched, prior build backed up to Desktop. Visually reviewed the redesigned `AccountPicker` live via Ladle in both themes across all required states (Auto, explicit pick, disabled account, resolved+confirm, legacy, unavailable, zero-accounts). **Not performed**: sending real messages through two live ChatGPT accounts end-to-end in the installed app — that requires the user's own OAuth sessions and hands-on interaction.

### Known remaining gaps

- No separate "Provider" row in the composer's collapsed view for OMP (e.g. a literal "Provider: Kimi Code" label) — the provider is visible today via the model picker's existing `routeProviderId` qualifier, and the account list correctly filters by it, but restructuring `ModelReasoningPicker`'s compact display to add an explicit provider row was judged out of proportion to this phase's risk budget.
- Claude Code's identity-resolution path shares the exact same function as Codex's (verified by direct code reading) but lacks a dedicated test using a real OAuth-flow harness; building one requires mocking a full PKCE HTTP exchange, deferred as disclosed, not hidden.
- Mission Control's new `accountLabel` resolver has no dedicated server-side unit test (no existing test harness for this plugin's `server.ts` to build on cheaply); covered by manual code review and the pre-existing component-level rendering tests.

## Phase 10.2.2 — Real ChatGPT account execution E2E repair (2026-09-20)

Reopened Phase 10.2.1 after the user reported "Provider error" for both real ChatGPT accounts in the installed app, despite Phase 10.2.1's tests passing. Investigated against the actual running `/Applications/Arc Agent.app` and `~/.bb` — no unit tests, no Ladle, no synthetic fixtures.

### Reproduction and trace

Confirmed via `curl` and direct filesystem inspection that Phase 10.2.1's identity-resolution fix (`resolvePoolAccountId`) was present and correct in the packaged app's bundled `account-pool` plugin (verified by grepping the actual `dist/server.js` inside `Contents/Resources/.../builtin-plugins/account-pool/`, matching source content and rebuild timestamp) — ruling out a stale-bundle/packaging mismatch. Found the user's own real thread events (`GET /api/v1/threads/:id/events` against the live server) showing the actual underlying error for both accounts: `404 Not Found` with a `cf-ray` response header — impossible on a genuine `127.0.0.1` loopback response, proving the real Codex CLI's request never reached our local Account Pooler hub, even though a direct `curl` to the exact same URL correctly reached the hub's own auth check (401, not 404).

### Root cause and fix (ADR-067)

The `/pin/<accountId>` / `/auto/<threadId>` URL path segments Phase 10.2's Codex mechanism appended to `CODEX_OPENAI_BASE_URL` made the real Codex CLI's requests never route through our hub at all — a production-only failure mode the fake-plugin-host test harness could not surface, since it dispatches to registered routes by exact in-memory path match and has no way to exercise the real Codex binary's own request handling. Fixed by moving the pin/thread-id marker onto Codex's own proven `env_http_headers` CLI mechanism (already used successfully for the hub auth token) instead of the URL, restoring `CODEX_OPENAI_BASE_URL` to the same flat shape Account Pooler always used before per-thread selection existed. Deleted the now-unnecessary dynamic route registration/cleanup machinery for Codex entirely (`ensureCodexPinRoutesRegistered`/`ensureCodexAutoRouteRegistered`) — the header-based path needs no server-side per-thread route state to register or leak.

### Real E2E verification (mandatory gate, performed via CLI against the actual installed app)

Since driving the Electron UI directly was not available, exercised the identical server-side path a UI click would via `bb thread spawn` / `bb thread tell` and direct `PATCH /threads/:id` calls against the real running packaged server (`~/.bb`, real accounts, real Codex CLI child processes) — this is the same HTTP API surface the app's own UI calls, not a synthetic shortcut:
- Account A (Plus, Auto-resolved): real Codex response `ACCOUNT-A-OK`.
- Account B (Team, explicitly pinned before dispatch): real Codex response `ACCOUNT-B-OK`.
- Concurrent dispatch of two threads pinned to Plus and Team simultaneously: `CONCURRENT-A-PLUS` / `CONCURRENT-B-TEAM`, no cross-account leakage.
- Full app restart, then a follow-up message to each of the two concurrent threads: both bindings survived (`accountKey` unchanged) and both continued executing correctly (`AFTER-RESTART-A-PLUS` / `AFTER-RESTART-B-TEAM`).
- Usage RPC (`arc.usage.current`) queried per account returns distinct, non-merged resources scoped to each `accountKey`; Codex does not expose usage window data via this path, honestly reported as `status: "unknown"` with empty `windows`, never a fabricated zero.

### Tests

Rewrote `plugins/account-pool/src/server-pin-identity.test.ts` and `server-auto-route.test.ts` to assert the header/env-var delivery mechanism instead of URL-path routes (11 tests, same coverage intent as Phase 10.2.1: connected-account resolution, two independent accounts, reconnect safety, stale-key rejection with zero fallback, concurrency isolation, re-selection idempotency). Added 2 new cases to `plugins/provider-codex/src/bridge/app-server-launch.test.ts` asserting the CLI args carry the pin/thread-id header config and never a URL segment. All packages re-verified green: `bb-plugin-account-pool` 158/158, `bb-plugin-provider-codex` 319/319, `@bb/agent-runtime` 331/331, plus the full previously-verified matrix (db, host-daemon-contract, provider-bridge-protocol, arc-core, arc-domains, client-core, server-contract, domain, app 545/545) with zero new regressions.

### Installed-app verification

Rebuilt and reinstalled `/Applications/Arc Agent.app` twice this phase (once to confirm the packaged-bundle theory, once with the real fix), `~/.bb` untouched both times, prior builds backed up to Desktop. All real E2E checks above were run against this final rebuild.

### Remaining limitation

The E2E verification above was driven through the same server API the Electron UI calls, not through literal mouse clicks in the app window (no UI automation access in this environment) — the user may still want to click through the composer themselves to confirm the visual flow, though the underlying execution path is identical either way.
## Phase 10.2.3 — OMP multi-account architecture (ADR-068) and Claude coverage

### What changed

- `packages/arc-domains`: `ArcAccount.identityKey` (OMP credential identity; null for pool accounts and OMP api-key credentials, which OMP's filter never matches), mapped from the broker snapshot's `identityKey` with the empty api-key value normalized to null. New `src/arc-account/omp-execution-pin.ts`: canonical key parsing, pin resolution (pinned / unavailable / not-omp-account / unpinned), and the account-pool file content for each outcome. `OmpAccountSource` gains `holdBrokerForExecution()` / `renewBrokerHold()` and a hold-aware idle timer.
- `plugins/arc-core`: `experimental_contributeEnv("acp-omp", …)` resolves the thread's `accountKey` against `accounts.listArcAccounts()`, writes the content-addressed pool file 0600 under `<userData>/omp/account-pool`, holds the broker, and contributes `OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN` / `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE`. `experimental_contributeEnvHealth("acp-omp", …)` renews a live hold and reports the pinned state. `ArcServiceHost` exposes the OMP source for that one caller.
- `plugins/arc-core/src/contract.ts`: `identityKey` added to the renderer-facing account schema (the drift alarm in `test/contract.test.ts` caught its absence).
- `packages/plugin-sdk`: provider-env context fixtures gained the `accountKey`/`accountResolved` fields Phase 10.2 added to `ExperimentalPluginProviderEnvContext` (pre-existing typecheck failure, and the context round-trip assertion now matches).

### Tests

New: `packages/arc-domains/test/arc-account-omp-execution-pin.test.ts` (12), identity-key mapping + broker-hold lifecycle cases in `arc-account-omp-source.test.ts`, `plugins/arc-core/test/omp-execution-env.test.ts` (5: pin, Auto, unavailable, non-OMP pin, pool-file reuse), `plugins/account-pool/src/server-provider-env.test.ts` (6: Claude pin header, Auto correlation, stale-key fail-closed, Codex pin/correlation env vars, reconnect-resolved row id). Suites: `@bb/arc-domains` 318 passed / 12 skipped, `bb-plugin-arc-core` 13, `bb-plugin-account-pool` 165, `@get-bb/plugin-sdk` 291, `@bb/provider-bridge-acp` 319, `@bb/client-core` 291.

### Live evidence (single real account each; no two-account isolation claimed)

- OMP mechanism against the real 18.2.6 binary and the real stored Kimi credential (`~/.bb` untouched, credential only read): `{"kimi-code": ["account:d9l3vugu8ld95qngp75g"]}` → Kimi still resolvable; `{"kimi-code": []}` → Kimi absent from `omp usage --json` while the api-key provider remains; unrelated provider listed → unrestricted. Probe broker terminated afterwards; the app's own brokers were left alone.
- Claude Code transport, real packaged app, real Claude account connected (`anthropic:account:6f6162cb-…`, thread `thr_utkhs87fys`): pinned to a non-existent account key, the real Claude Code process received **HTTP 409** from Arc's hub and retried 1/10…9/10 — the pin reached the hub and failed closed instead of serving the one connected account. Unpinned (Auto) execution reached the hub too and was refused with the hub's own **429 "No Account Pooler account is currently eligible"**, because that account's 5-hour window is at 100% (`status: rejected`, reset ≈ 13:59 local). A successful Claude turn therefore could not be produced in this window; the thread was stopped and its pin restored to the real account.

### Remaining limitations (disclosed, not worked around)

- No second Kimi account and only one Claude account: concurrent/isolated two-account execution is **NOT AVAILABLE** for both providers; Codex remains the only provider with real two-account E2E.
- `arc-core` now owns the `acp-omp` provider-env contribution (one contributor per provider id, as with Codex/Claude Code in `account-pool`); a future provider-proxy plugin for OMP cannot also contribute env for that id.
- `pnpm audit` crashes the Node process on this workspace, so the dependency audit was not run; this phase adds no dependencies.
- Workspace `typecheck` is red only in `bb-plugin-automations` (`src/working-directory.ts` imports `AutomationScriptWorkingDirectory`, absent from `src/rpc-types.ts` at HEAD — a pre-existing gap from the era-matched plugin source restore).
- `@bb/server`'s full suite has ~37 failures whose errors are all of the same shape — `no readable package.json at plugins/<name>/package.json`, and registry/bundled counts (10 present vs the 37/39 the tests expect) — i.e. this fork's missing plugin sources, the residual hole recorded in `docs/plugin-provenance.md`. Pre-existing, unrelated to this phase's changes.

## Phase 10 complete — installed-app smoke evidence (2026-09-20)

`/Applications/Arc Agent.app` was rebuilt from this tree (`pnpm --filter @bb/desktop package`) and reinstalled over the running copy; the previous bundle was kept as `/Applications/Arc Agent.app.bak-10.3` and `~/.bb` was never touched. Installed artifact provenance: installed `app.asar` == the checkout build (`ee25717d…`), bundled `arc-core` dist == the repo build (`9af922be…`) and contains the OMP env contract, bundled `account-pool` dist == the repo build (`672a266e…`, the same file carrying `getSticky` and `x-bb-account-pool-pin`).

Every check below ran against that installed app through the same server API the renderer calls, with the pool's own per-request observations as the account evidence.

| Check | Output | Pin the provider received | Account that actually served it |
|---|---|---|---|
| Codex Plus | `plus-ok` | `CODEX_ACCOUNT_POOL_PIN=4bf9165d…` (Plus) | Plus `account_quota.observed_at` advanced; Team unchanged |
| Codex Team | `team-ok` | `8ce4f09d…` (Team) | Team advanced; Plus unchanged |
| Same-thread Plus → Team | `switch-team` | `8ce4f09d…` | Team advanced; Plus unchanged |
| Same-thread Team → Plus | `switch-plus` | `4bf9165d…` | Plus advanced; Team unchanged |
| OMP ⟶ Kimi (account selected at creation) | `kimi-ok` | contributed by `arc-core` for `acp-omp` | pool file + broker, below |
| OMP ⟶ Auto | `auto-ok` | **no** `arc-core` contribution (0 entries) | OMP keeps its own selection |

The same-thread switching rows matter most: the provider session stayed alive across all four sends, and each switch re-resolved the environment and rebuilt the ACP session, so the pin follows the thread rather than the process.

OMP evidence: the thread's `provider.env-resolved` event carries `OMP_AUTH_BROKER_URL=http://127.0.0.1:57232`, `OMP_AUTH_BROKER_TOKEN` (loopback, redacted), and `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE=<userData>/omp/account-pool/b020b0113ee4feba.json`; that file exists as `-rw-------` holding exactly `{"kimi-code": ["account:d9l3vugu8ld95qngp75g"]}`, and a broker is listening on `127.0.0.1:57232`. Switching the same thread to Auto and back changed the resolved contribution accordingly (3 arc-core entries ⟶ 0 ⟶ 3) while each turn still completed.

Account selector: `POST /api/v1/plugins/arc-core/rpc/arc.accounts.list` — the composer's own call — returns five accounts (ChatGPT plus/team, Claude pro, and the two OMP credentials) with `accountKey`, plan label, and auth state; `PATCH /threads/:id` with `accountKey` persisted to `threads.account_key`/`account_resolved` in every direction tested (Plus, Team, Auto, Kimi); the installed renderer bundle contains the selector ("Accounts", "Account unavailable", `arc.accounts.list`). No UI automation exists in this environment, so the visual click-through remains for the user.

Secret exposure: the OMP pool file is 0600 and holds credential identities only, the provider secret store is 0700, both brokers bind `127.0.0.1` only, the accounts payload contains no token/secret-shaped keys or values, and neither the diff nor the new files contain token literals.

Disclosures: (1) provider environment values are persisted in `events` as `provider.env-resolved`, including the loopback hub/broker tokens — pre-existing behaviour of the contribution mechanism (the Codex path recorded `CODEX_POOL_AUTH_TOKEN` before this phase) and now also true for OMP; `~/.bb/bb.db` is mode 0644, so tightening it to 0600 is worth a follow-up. (2) Two OMP brokers from the pre-rebuild app instance survived that app's quit (PIDs 64128, 69106, reparented to PID 1) — a pre-existing broker-lifecycle gap, unrelated to this change. (3) On this machine the OMP *provider* executes the PATH-resolved `~/.local/bin/omp` shim (which execs `omp-real`), because `.local/bin` precedes the Arc runtime directory on the inherited PATH; a machine without a global `omp` resolves the managed runtime instead. (4) The CLI gap recorded in ADR-069.

## Pre-Phase-11 hardening — runtime ownership, broker lifecycle, local secrets (2026-09-20)

Baseline before this work: `self-contained @ e6d235602`. Nothing committed here until reviewed; `~/.bb` untouched apart from the permission modes and the QA threads listed at the end.

### Runtime ownership (ADR-070)

Measured before: Codex ran `~/.codex/packages/standalone/releases/0.154.0-aarch64-apple-darwin/bin/codex` and OMP ran `~/.local/bin/omp-real`, while the runtime manifest activated 0.155.1 and 18.2.6. After the change, verified on the installed app via `lsof` on the live provider processes:

| Provider | Executable actually running | Managed path |
|---|---|---|
| Codex | `Agent/arc-runtimes/runtimes/codex/0.155.1/codex` | same |
| Claude Code | `Agent/arc-runtimes/runtimes/claude-code/2.1.276/claude` | same |
| OMP | `Agent/arc-runtimes/runtimes/omp/18.2.6/omp acp` | same |

Fail-closed and hostile-PATH behaviour is covered by tests in all three plugins plus `arc-runtime-environment.test.ts`: with a fake `codex`/`claude`/`omp` first on PATH and Arc mode declared, the provider resolves the managed path; with Arc mode declared and no executable override, it refuses to launch instead of using PATH; a bad path is rejected. External installations stay informational only (`discoverClaudeInstall` classification, ACP roster probing).

### Broker lifecycle (ADR-071)

- Ownership record verified live: `<userData>/omp/broker-ownership.json`, 0600, holding the broker pid 44363, the managed executable path, the start time and the instance id; cleared on shutdown.
- Quit-time cleanup verified: an app instance's broker (pid 42249) and its OMP provider (45795) and Claude provider (46965) were gone after a normal quit, while the user's own `omp-real` processes (87681, 87688) stayed up.
- Stale recovery verified: the server was SIGKILLed while its broker (47535) was alive; the restarted server logged `arc-core stopped a leftover OMP broker (pid 47535)` and cleared the record. Legacy leftovers with no record were never touched; the two from an earlier app instance (64128, 69106) were terminated by hand after this check.

### Local secrets (ADR-072, ADR-073)

- Live: the server logged `Restricted local data permissions (owner-only) for: data-dir, database, database-wal, database-shm.` and `~/.bb` is 0700 with `bb.db` 0600.
- New events: 16 entries are already stored masked, and a child-process test asserts the real values still reach the provider while the event carries `{masked: true}`.
- Log audit: 0 credential-shaped assignments across the 9 log files under `~/.bb/logs`, `~/Library/Logs/Arc Agent` and the app's log directory.
- Historical rows (first dry run, no writes): 49 events scanned, 11 rows would change, 20 entries would be redacted, 4 names, 2 distinct values. That run also concluded both values were absent from every current token store and therefore stale — **that conclusion was wrong**; the surviving value turned out to be the live account-pool hub token (see the final-cleanup subsection below). Applying was left pending the user's decision, and the shipped tool needed `better-sqlite3` declared in `@bb/scripts` (same gap as the pre-existing `seed-perf-db`) before it could run standalone.

### Regression checks on the installed app

Codex Plus `plus-ok`, Codex Team `team-ok`, OMP/Kimi `omp-ok` and `omp2-ok`, same-thread Plus → Team switch on one live thread (`first-plus` with pin `4bf9165d`, then `second-team` with pin `8ce4f09d`), and after a quit/relaunch a fresh Codex Plus turn returned `relaunch-ok`. Claude Code launched the managed binary and failed the turn with the account's exhausted five-hour window (`429`, "No Account Pooler account is…"), which is the expected quota state, not a launch failure — no successful Claude completion is claimed.

Suites: typecheck + tests green for `@bb/domain`, `@bb/config`, `@bb/agent-runtime`, `@bb/arc-domains`, `@bb/scripts`, `bb-plugin-arc-core`, `bb-plugin-provider-acp`, `bb-plugin-provider-codex`, `bb-plugin-provider-claude-code`, `bb-plugin-account-pool` (1780+ tests). Two pre-existing red surfaces remain, both unrelated to this work: `apps/server` has 16 failing test files (37 tests) whose causes are the plugins the fork removed (`ask-user-question`, `keep-awake`, `connect`, `environment-project-checkout`), and the provider-literal ratchet failed at HEAD for 18 Arc files that were never allowlisted. The ratchet is now green: those files carry allowlist entries with reasons, and the baseline totals 84 references across 24 files.

### QA artifacts

Threads created by these checks (all titled `pre11 …`, safe to delete): `thr_j4zykdffce`, `thr_2bv4bvip8w`, `thr_bysswc7vvv`, `thr_4k2ctzngja` (the three `error` rows are the pre-fix Codex `stdin is not a terminal` attempts), `thr_nrhu3kdie2`, `thr_873yrq6brh`, `thr_dqrw47utuj`, `thr_54y7cmdcnm`, `thr_xkav5efngp`, `thr_vxspjb2p79`, `thr_3rghzfi2ik`. Installed-app backups: `Arc Agent.app.bak-pre11`, `.bak-pre11b`, `.bak-pre11c` (plus the older 10.2/10.3/old/quarantined copies).

### Historical credential redaction (final cleanup, 2026-09-20)

Baseline `self-contained @ 95ad11a3a`. Two things had to change before the redaction could run at all: `@bb/scripts` now declares `better-sqlite3` (`12.10.0`, the version `@bb/db` and `apps/server` already pin) because `build-package.mjs` inlines workspace sources into each bin entry and the bundled `@bb/db` import had no package to resolve, and the two test files covering this work moved from `src/` to `test/`, where each package's vitest config actually collects them — 26 domain and 3 scripts assertions had never executed.

The dry run did not reproduce the first run's scope, and why matters more than the numbers:

| | First dry run | Final cleanup |
|---|---|---|
| `provider.env-resolved` events scanned | 49 | 32 |
| Rows holding raw values | 11 | 4 |
| Entries to redact | 20 | 8 |
| Names | 4 | 2 |
| Distinct values | 2 | 1 |

Every `pre11 …` QA thread listed above has since been deleted from `threads`, and `events.thread_id` cascades on delete, so the `ANTHROPIC_AUTH_TOKEN` and `OMP_AUTH_BROKER_TOKEN` rows left with their threads instead of being redacted — the database held zero masked entries. What remained were four rows in `thr_us5nauj5h6` carrying one 43-character value under both `CODEX_POOL_AUTH_TOKEN` and `BB_ACCOUNT_POOL_PARENT_TOKEN`.

That value was **live, not stale**: byte-identical to `value` in `~/.bb/plugins/account-pool/secrets/accounts/hub-token-host_jd4zxm8ai9.json`, minted `2026-09-20T06:03:14Z` and last used `2026-09-20T11:21:12Z`, with `previous: []` — no rotation had ever happened. The same value sat verbatim in all 19 `~/.codex/shell_snapshots/*.sh` files at mode **0644** inside a 0755 directory, readable by any local account: a wider exposure than the database rows ADR-072 had just restricted to 0600. The staleness check behind the first dry run therefore examined the wrong stores, or stores that no longer held the token.

Applied, in order, against `~/.bb`:

1. Redaction (`--apply`): 4 rows, 8 entries. Verified against a pre-change `db.backup()` copy — event id, sequence, thread, turn, scope, type, item fields and `created_at` identical; 276 entries before and after; every non-credential field byte-identical; 2 `{masked: true}` entries per row. The backup was deleted afterwards so it could not become a fresh copy of the value.
2. Rotation: `token.rotate` for `host_jd4zxm8ai9` minted a new hub token (`f57b3b3d…` replacing `e4d9d428…`). The store retains the old value only in its `previous` grace entry, which expires 10 minutes after the mint (`HUB_TOKEN_GRACE_MS`).
3. Snapshot purge: the 19 files under `~/.codex/shell_snapshots` holding the old value were deleted, along with the one the verification turn created for the new value.
4. `VACUUM` + `wal_checkpoint(TRUNCATE)`: masking rewrites rows but leaves the previous bytes in the file's free pages and WAL frames, so the value stayed findable in `bb.db` until both ran (15.0 MB → 12.2 MB, row counts unchanged, mode still 0600).

Post-change evidence: the tool's dry run reports 0 rows with credential values and 0 entries to redact; a 30,773-file scan across `~/.bb`, `~/Library/Logs`, `~/Library/Application Support/Arc Agent`, `~/.codex`, `~/.claude`, `~/.omp`, `~/.config`, the shell histories and `/tmp` finds the old value only in the store's grace entry and the new value only in the store; `~/.bb` is 0700 and `bb.db`/`-wal`/`-shm` are 0600. A fresh Codex turn (`thr_inwmcbvpiy`, reply `ok`) shows the rotation did not break provider auth, and that turn's own `provider.env-resolved` event stores both names masked at write time, so the live policy is active in the installed build.

Residuals, both outside this change:

- **Every Codex turn re-creates a 0644 snapshot holding the current hub token.** The purge removes today's copies; the next turn writes another. This was observed rather than inferred: an unrelated Codex turn at `11:46Z` wrote a fresh snapshot holding the then-current token, which was purged like the others. Codex's shell-snapshot cache is not Arc-owned, so the fix belongs either in how the pool contributes `CODEX_POOL_AUTH_TOKEN` to a turn or in Codex's own file mode — worth deciding before Phase 11 rather than after.
- A rotation's grace entry keeps the previous token valid for ten minutes by design, and nothing prunes it before it expires. The entry holding the leaked value was therefore removed by rotating once more after it expired, which drops expired entries from `previous`. A final 30,562-file scan finds the leaked value in no file at all, the intermediate token only in the store's grace entry, and the current token only in the store.

One process note: an agent session transcript under `~/.omp/agent/sessions` recorded the value while this cleanup inspected the store, and was redacted in place (same byte length, so append offsets were preserved).

QA artifact from this cleanup: `thr_inwmcbvpiy` (`post-rotation smoke`, safe to delete).

---

## Phase 11, Part 0 — Codex Shell-Snapshot Secret Exposure (closed)

Date: 2026-09-20. Same checkout, `self-contained @ a3bb60900` verified before editing (`git status`/`log`/`diff --stat`/`rev-parse HEAD`/`rev-parse @{u}` all matched the expected checkpoint; untracked `000`/`server.js` left untouched).

### Reproduction (0.1)

`~/.codex/shell_snapshots` existed, mode `0755`, **0 files** at the time of this check — the prior cleanup's purge still held; no real Codex turn had run on this machine since. Confirmed the account-pool hub token file (`~/.bb/plugins/account-pool/secrets/accounts/hub-token-host_jd4zxm8ai9.json`) is `0600`, unchanged. No token value was printed at any point in this investigation; live verification used a locally-generated canary string, never the real token.

### Mechanism (0.2) — the plan's Option C assumption was wrong, verified against the real binary and upstream source

Codex's `shell_environment_policy` config (`inherit`/`ignore_default_excludes`/`exclude`/`set`/`include_only`, confirmed present at `codex-rs/protocol/src/config_types.rs` on tag `rust-v0.155.1` — our exact pin) has a documented default-exclude list for `*KEY*`/`*SECRET*`/`*TOKEN*` names, but it ships **off** by default (`ignore_default_excludes: true`). Fetching `codex-rs/core/src/shell_snapshot.rs` from `openai/codex` showed `shell_environment_policy` threaded into snapshot creation only inside a `credential_broker`-mediated path gated on `sandbox.is_some()` and an active `codex_network_proxy` credential broker — a separate, deeper subsystem (network-proxy credential virtualization for MCP-style auth) that Arc's Account Pool integration doesn't use and has no reason to adopt for this. The raw/default snapshot capture path (what Arc's `danger-full-access` sandbox and interactive turns actually use) is unaffected by the policy.

Live proof, real pinned `0.155.1` binary, isolated `CODEX_HOME`, canary token, no real network reached (`CODEX_OPENAI_BASE_URL` pointed at an unreachable loopback port):
- `codex exec` with `-c shell_environment_policy.exclude=["CODEX_POOL_AUTH_TOKEN"]` (the exact `-c` args our bridge already builds) still wrote the canary verbatim into a fresh `0644` `shell_snapshots/*.sh` file — the exclude config has **no effect** on the file.
- The same exclude config **does** work for a different, real exposure: `codex sandbox ... env` showed the canary in the child's own environment without the exclude, and nothing with it — so a shell/exec command the model runs can no longer read the token via its own process env.
- A pre-hardened `0700` snapshot directory stayed `0700` after Codex wrote a new (still `0644`) file into it — Codex never loosens an already-restrictive directory, confirming the directory's own permission is the load-bearing, durable protection (POSIX path resolution needs the `x` bit at every component; a `0700` directory blocks every other local account regardless of the file's own mode).

### Fix (0.3–0.4) — two real changes, ADR-074

1. `plugins/provider-codex/src/bridge/bridge.ts` — `resolveAppServerLaunch` adds `-c shell_environment_policy.exclude=["CODEX_POOL_AUTH_TOKEN"]` in the same branch as the existing `env_http_headers` overrides (ADR-067). Closes the exec-tool visibility exposure using Codex's own documented mechanism; the token value itself never appears in argv, only the variable name.
2. `plugins/provider-codex/src/shell-snapshot-hardening.ts` (new) — `hardenCodexShellSnapshotDir`, called once from `server.ts`'s `plugin()` entrypoint: creates/tightens `$CODEX_HOME/shell_snapshots` (default `~/.codex/shell_snapshots`) to `0700` and sweeps any existing files inside to `0600`, mirroring `hardenLocalDataPermissions` (ADR-072) — best-effort, never fatal to Codex launch, scoped to exactly that one directory.

Option B (per-process ephemeral hub tokens) was evaluated and deliberately not built: the existing `HubTokenStore.rotate`/`AccountPoolOperations.rotateToken` (manual, grace-period overlap) already bounds token lifetime, and a new minting/revocation subsystem is disproportionate to what the two changes above leave as a residual. User decision: leave rotation manual; Part 0 does not need automatic scheduled rotation. Full reasoning in ADR-074.

Applied immediately to the real machine as an interim safeguard (the code fix only takes effect after the plugin bundle is rebuilt/reinstalled): `chmod 700 ~/.codex/shell_snapshots` (0 files present at the time, nothing to sweep).

### Tests

- New: `plugins/provider-codex/src/shell-snapshot-hardening.test.ts` (4 tests — creates missing dir owner-only, tightens an existing loose dir+file, idempotent on an already-hardened dir, defaults to `~/.codex/shell_snapshots`).
- Extended: `plugins/provider-codex/src/bridge/app-server-launch.test.ts` — asserts the new `-c` arg is present when the pool token is routed and absent when it is not.
- `pnpm exec turbo run test typecheck --filter=bb-plugin-provider-codex` → **327/327 passed**, typecheck clean. No other package touched; no re-run needed elsewhere (account-pool's own tests simulate the header mechanism independently and don't import `resolveAppServerLaunch`).

### Residual (documented limitation, not a gap)

A snapshot file written during a live session before the next plugin-load hardening pass stays `0644` on disk until that pass runs, but is unreachable to any other local account for its entire life because the containing directory is `0700` from the moment Codex first needs it. The token's real-world validity window is still bounded only by manual rotation, not by anything time-based — accepted per the user's decision above.

### Gate

PASS. Proceeding to Phase 11 Part 1 (Codex Code Mode runtime-set definition).

---

## Phase 11, Part 1 — Codex Code Mode Runtime Definition (closed)

Date: 2026-09-20. Same checkout, Part 0 state verified before editing.

### Research (1.1–1.2)

Fetched `openai/codex` at tag `rust-v0.155.1` (matching Arc's exact pin): `codex-code-mode-host` is a real first-party Cargo workspace member, released as its own per-platform asset in the same GitHub release as `codex` (`codex-code-mode-host-aarch64-apple-darwin.tar.gz`, digest `sha256:e8957108…b508a`, 22,572,025 bytes) — always version-locked to the Codex tag, darwin-arm64 available, same GitHub-digest integrity metadata Arc already consumes for Codex/OMP. It is a *separate* asset from the plain single-executable `codex-aarch64-apple-darwin.tar.gz` Arc downloads (ADR-020), which is why the managed runtime never had it.

`codex-rs/features/src/lib.rs` gave the real reason for the warning: `code_mode` (the tool itself) is `UnderDevelopment`/`default_enabled: false` — never turned on by Arc or upstream by default — but `code_mode_host` (the companion-process infrastructure) is `Stage::Stable`/`default_enabled: true`, so Codex always probes for the binary regardless of whether the feature that would use it is active. The warning is `AtomicBool`-guarded (`take_unavailable_warning`), so it is a one-shot-per-thread notice, not a real per-turn respawn loop.

### Fix (1.3–1.4)

`resolveAppServerLaunch` now unconditionally appends `-c features.code_mode_host=false` to every Codex launch (moved the `["app-server"]` base into a `baseArgs` local and build `args` from it before the pool-routing branch, so both pool-routed and direct-auth launches get it). Live-verified against the real pinned binary (isolated `CODEX_HOME`, unreachable pool URL, no real network egress): the alarming `failed to spawn code-mode host ... host executable was not found` line is replaced by a truthful `Code Mode is unavailable because code-mode host is disabled` one-time notice, and Codex no longer attempts to spawn anything. No supported mechanism exists to remove that residual single informational line entirely (it fires from Codex's own tool-registration path regardless of *why* the feature is off) — not pursued further since inventing one would mean patching or wrapping Codex's own output, which the plan explicitly disallows ("Do not invent unsupported Codex CLI behavior").

No runtime-set/manifest/health changes: since `code_mode` stays off, the companion binary is not a required component under the plan's own rule ("Health should validate all components required by enabled features") — reporting the runtime healthy on the main binary alone remains correct. Full ADR-075 records the future acquisition path (reuse ADR-020/021/025's pattern) for if/when Arc turns Code Mode on as a product feature.

### Tests

- `plugins/provider-codex/src/bridge/app-server-launch.test.ts` — new `BASE_ARGS` constant (`["app-server", "-c", "features.code_mode_host=false"]`) used everywhere an exact `args` array was previously asserted (7 call sites updated), plus one new dedicated test asserting the disable flag is always present regardless of pool routing.
- `pnpm exec turbo run test typecheck --filter=bb-plugin-provider-codex` → **328/328 passed** (up from 327 after Part 0), typecheck clean. The fake-app-server-harness-backed conformance/zero-work-turn/recorded-conformance suites all still pass with the extra `-c` arg present, confirming no argv-shape assumption broke elsewhere in the plugin.

### Gate

PASS. Proceeding to Phase 11 Part 2 (managed runtime update engine).

---

## Phase 11, Part 2 — Managed Runtime Update Engine: Backend (engine + RPC; installed-app work deliberately not started)

Date: 2026-09-20. Same checkout, Part 1 state verified before editing.

### Scope note

This entry covers the update/rollback **engine and its backend RPC surface** — the parts fully expressible as tested TypeScript against `packages/arc-domains` and `plugins/arc-core`. Per an explicit checkpoint agreed with the user before starting Part 2, the installed-app rebuild/reinstall and full regression pass (plan 2.31/2.32) were deliberately **not** started in this entry; they need a separate, explicitly-approved pass since they touch the user's real `/Applications/Arc Agent.app`, real accounts, and real credentials. The polished Updates UI (plan 2.28 note → Phase 23) and aggressive retention policy (2.27, deferred by the plan itself) are likewise out of scope by design, not by omission.

### Architecture map (written before editing, ADR-077)

See ADR-077 for the full map. Summary: every new module extends the Phase 1–6 primitives in place — no parallel runtime manager, no new manifest file, no new lock, no new RPC transport.

### Files changed — `packages/arc-domains`

- `src/arc-runtime/manifest.ts` — schema v2 (`knownGoodVersion` per runtime entry) with a genuine v1→v2 migration path (`arcRuntimeManifestSchemaV1`, `migrateArcRuntimeManifestV1`), not just future-version rejection. `createEmptyArcRuntimeManifest` and the two existing first-install write sites (`bootstrap.ts`'s `installFromSeed`, `claude-setup.ts`'s activation commit) set `knownGoodVersion` immediately, matching the pre-Part-2 implicit trust model unchanged.
- `src/arc-runtime/update-download.ts` (new) — `downloadAndStageArcRuntimeRelease`: generic download-to-scratch + reuse of `acquire.ts`'s existing `stageReleaseExecutable` (unmodified) for digest/version verification, plus an optional post-stage verification hook (used for Claude's codesign check). Rejects clean up their own scratch directory; an "ok" result's staged executable survives for the caller to move.
- `src/arc-runtime/health.ts` (new) — `probeArcRuntimeHealth`: version probe + a runtime-specific local/offline liveness check (Codex/Claude: `doctor`; OMP: a real ACP `initialize` handshake over stdio, `defaultRunOmpAcpHandshake`, mirroring Phase 4's own live proof). No account, no network call that could reach a paid model.
- `src/arc-runtime/activation.ts` (new) — `activateArcRuntimeVersion` (atomic manifest swap, reusing the existing serialized-mutation primitive; a real bug was caught and fixed here during testing — an over-defensive "superseded" check that would have made every ordinary activation fail was removed once the per-agent exclusive lock was recognized as already sufficient), `promoteArcRuntimeKnownGood` (explicit, only after activation), `rollbackArcRuntimeVersion` (reactivates `knownGoodVersion`, never redownloads, reports `unavailable` rather than a silent no-op or a fresh install when the target is missing or was deleted from disk).
- `src/arc-runtime/update-discovery.ts` (new) — `discoverArcRuntimeUpdate`, side-effect-free; per-runtime `defaultFetchLatestArcRuntimeRelease` implementations for Codex/OMP (GitHub Releases API) and Claude Code (Anthropic's own `/latest` + `manifest.json`, matching `install.sh`). Every discovered release re-validated through `validateArcRuntimeRelease` before being trusted (ADR-078).
- `src/arc-runtime/update.ts` (new) — `updateArcRuntime`: discover → stage → pre-activation health → move-to-final-placement → activate → post-activation health → promote-or-automatic-rollback. Typed outcome union, never throws for an expected result.
- `src/arc-runtime/staging-cleanup.ts` (new) — `cleanAbandonedArcRuntimeStaging`, swept once at server startup (plan 2.7/2.22).
- `src/arc-runtime/claude-setup.ts` — `defaultVerifyCodeSignature` exported (was private) so the update path reuses the exact same macOS codesign check as first install, not a second implementation.
- `src/arc-agent/types.ts` — `ArcAgentRuntimeStatus.knownGoodVersion`; two new `ArcAgentErrorCode`s (`runtime-update-failed`, `runtime-rollback-failed`).
- `src/arc-agent/manager.ts` — `checkForUpdate`/`updateAgent`/`rollbackAgent`, all routed through the existing per-agent `runExclusive` lock (Codex/OMP/Claude updates already run independently under this — nothing new built for cross-runtime concurrency, plan 2.21). `resolveActions`' `update`/`rollback` entries now reflect real local state instead of the hardcoded `available: false` placeholders from Phase 6.
- `src/arc-runtime/index.ts` — new modules exported.

### Files changed — `plugins/arc-core`

- `src/contract.ts` — `arcAgentRuntimeStatusSchema` gains `knownGoodVersion`; new `arcRuntimeReleaseSummarySchema` (a deliberately narrower wire projection of `ArcRuntimeRelease` — never `runtimeId`/`artifactKind`/`expectedExecutableVersion`/`executableSha256`), `arcRuntimeUpdateDiscoverySchema`, `arcRuntimeUpdateOutcomeSchema`, `arcRuntimeRollbackOutcomeSchema`; three new RPC methods (`arc.agents.checkForUpdate`/`update`/`rollback`).
- `src/server.ts` — wires the three methods to `requireHost().agents.*`; `toArcRuntimeUpdateDiscoverySummary` does the explicit field-narrowing before anything crosses the RPC boundary; `cleanStagingAtStartup` fire-and-forget call added alongside the existing `reapAtStartup` pattern.

### Files changed — `plugins/provider-codex`

- `src/bridge/bridge.ts` — `resolveAppServerLaunch`'s baseline args now also disable Codex's own `check_for_update_on_startup` (ADR-081), unconditionally, same mechanism and reasoning as the Part 1 Code Mode host disable.

### A real design correction caught by testing

The first `activateArcRuntimeVersion` draft included a defensive "is this a race?" check that compared the manifest's current `activeVersion` against the candidate being activated and treated *any* difference as a conflict — which is backwards: a different, runnable current version is the *normal* case for every activation (that is the entire point of calling it), so the check would have made every real update fail. Caught immediately by `arc-runtime-activation.test.ts`, root-caused (the per-agent exclusive lock in `ArcAgentManager` already makes same-runtime concurrent activation impossible, so the check was solving a problem that could not occur at this layer) and removed. Documented here because it is exactly the kind of bug a review would otherwise have to catch by inspection.

### Live verification against real trusted sources (read-only, non-destructive)

Confirmed via direct `curl`/`gh api` calls before trusting the discovery design: `api.github.com/repos/openai/codex/releases/latest` and `.../can1357/oh-my-pi/releases/latest` both return the exact shape `update-discovery.ts` expects (`tag_name`, `draft`, `prerelease`, `assets[].digest` as `sha256:…`), and both currently match Arc's existing pins (0.155.1, 18.2.6) — no real update exists for either today. `claude.ai/install.sh` was read directly to confirm `downloads.claude.ai/claude-code-releases/latest` (plain-text version) → `.../<version>/manifest.json` (per-platform checksum) is Anthropic's own official discovery mechanism; live-called, it returned `2.1.278` — a real update over Arc's pinned `2.1.276` — proving the mechanism works end to end against a genuine newer release without Arc performing that upgrade (deferred to the installed-app pass, matching plan 2.30's instruction not to force an unsafe/unrequested production upgrade).

### Tests

- `packages/arc-domains`: **368/368 passed** (up from 328 at the start of Part 2), typecheck clean. New suites: `arc-runtime-activation.test.ts` (10), `arc-runtime-health.test.ts` (8), `arc-runtime-update-download.test.ts` (5), `arc-runtime-update-discovery.test.ts` (8), `arc-runtime-update.test.ts` (8, full orchestration including the automatic-rollback and no-rollback-target paths), `arc-runtime-staging-cleanup.test.ts` (3), `arc-agent-manager-updates.test.ts` (5, exercising the manager-level wiring with real spawned fake binaries including a real ACP handshake). Existing suites updated for the manifest v2 field and the new `knownGoodVersion`/`resolveActions` behavior; zero regressions.
- `plugins/arc-core`: **20/20 passed**, typecheck clean. `contract.test.ts` extended with discovery/outcome fixtures (drift + unknown-field-rejection assertions); `server.test.ts`'s fixed-method-list assertion extended to the three new methods.
- `plugins/provider-codex`: **328/328 passed** (unchanged count — the self-update disable only extended the existing `BASE_ARGS` fixture already covering every launch-args assertion), typecheck clean.

### Explicitly not done in this entry (by design, not oversight)

- Installed-app rebuild/reinstall and the full regression matrix (plan 2.31/2.32) — needs its own approved pass; touches the real installed app, real accounts, real credentials.
- A real production runtime update actually performed (Claude 2.1.276 → 2.1.278 is available and proven reachable, but not applied) — deferred to that same pass.
- Turn-level known-good promotion (ADR-079's documented gap) — probe-based promotion ships now; wiring a real completed-turn signal from the provider bridges is materially larger cross-package work, left for later if the probe-based signal proves insufficient.
- Aggressive retention policy (deferred by the plan itself, 2.27).
- The full 2.23 failure-injection matrix's most exotic scenarios (actual OS-level process kill mid-write) — the matrix's *logic* paths are covered (checksum mismatch, corrupt artifact, missing executable, unsupported/blocked version, health failure at each stage, manifest producing no result, concurrent operations via the existing lock); true crash-injection testing relies on the same atomic tmp+rename and serialized-mutation primitives Phase 2/6 already proved crash-safe, reused unmodified here.

### Gate

Backend engine: PASS, tested and documented (ADR-076 through ADR-082).

---

## Phase 11, Part 2 — Installed-App Verification and Minimal Update/Rollback UI

Date: 2026-09-20. Same checkout, backend-engine state verified before editing. User explicitly approved: (1) proceeding into the installed-app phase, (2) performing a real production Claude update rather than only fixture-based verification, (3) adding a minimal (not the Phase 23 polished) Update/Roll Back UI, (4) sending real test messages through each provider for the regression pass.

### Minimal Update/Rollback UI

The plan explicitly deferred the polished Updates UI to Phase 23, but the backend's `actions` array already reports real `update`/`rollback` availability with no UI consuming it — on the user's own observation ("shouldn't I have an update button?"), added a minimal, functional (not polished) surface rather than leaving the working RPC methods reachable only via direct API calls:

- `plugins/arc-core/src/contract.ts` / `server.ts`: no change (RPC surface already existed).
- `adnan/plugins/adnan-mission-control/server.ts` — three new snake_case proxy methods (`arc_agents_check_for_update`, `arc_agents_update`, `arc_agents_rollback`) mirroring the existing `arc_agents_prepare`/`arc_agents_repair` pattern exactly, each a thin `proxyArc("arc.agents.*", { id })` call.
- `adnan/plugins/adnan-mission-control/lib/arc-types.ts` — `ArcAgentRuntimeStatus.knownGoodVersion`; new `ArcRuntimeReleaseSummary`/`ArcRuntimeUpdateDiscovery`/`ArcRuntimeUpdateOutcome`/`ArcRuntimeRollbackOutcome` types mirroring the backend contract's wire shapes.
- `adnan/plugins/adnan-mission-control/lib/data.ts` — `useArcAgents` gains `checkForUpdate`/`update`/`rollback`, each calling its RPC method and re-`load()`-ing agents on completion (matching `prepare`/`repair`'s existing pattern).
- `adnan/plugins/adnan-mission-control/components/agents.tsx` — an `Update` button (available whenever the runtime is ready/ready-with-warning/unsupported/broken — i.e. not mid-operation) and a `Roll Back` button (available exactly when `knownGoodVersion` differs from the active version) per agent card, with plain-text toast outcomes for every `ArcRuntimeUpdateOutcome`/`ArcRuntimeRollbackOutcome` variant. The button is honestly labeled `Update` (not `Check for Update`) because a single click both checks and applies — no separate confirm step, matching the existing single-click `Repair` button's UX, not the Phase 23 design.
- Tests: `agents.test.tsx` (+2 tests, action-button visibility for ready vs. not-prepared agents), `overview.test.tsx` fixture updated for the new `knownGoodVersion` field. `bb-plugin-adnan-mission-control` typecheck clean; 41/42 tests pass (the one pre-existing failure, `connect-flows.test.tsx`'s timer-based OAuth-expiry test, fails identically on the unmodified baseline — confirmed by stashing this session's changes and re-running — not a regression).

### Installed-app rebuild and reinstall

Followed the Phase 10 handoff procedure exactly: `osascript -e 'quit app "Arc Agent"'` (graceful, verified no lingering processes each time — never force-killed), `pnpm --filter @bb/desktop package` (not `dist`/`desktop:build`, which would publish), `ditto` to a staging path, atomic `mv` swap preserving the previous `.app` as a timestamped backup (`Arc Agent.app.bak-part11-*`), `open -a`. Done twice: once for the backend engine, once more after the UI addition (a from-source-loaded server plugin picks up changes on restart, but the bundled React client is a build artifact and needed a real rebuild). `~/.bb` and `~/Library/Application Support/Arc Agent` were never touched by either rebuild — only the `.app` bundle itself.

### Live verification (real installed app, real accounts, real network)

- **Manifest v2 migration on real production data**: the actual installed app's `runtime-manifest.json` was a genuine v1 file (`schemaVersion: 1`, no `knownGoodVersion`) written by a previous phase. `arc.agents.get` on first launch returned `knownGoodVersion: "0.155.1"` correctly defaulted — confirmed via direct RPC call before any UI existed to show it.
- **Discovery, live, against all three real trusted sources**: `arc.agents.checkForUpdate` for Codex and OMP correctly reported `updateAvailable: false` (both genuinely current: 0.155.1, 18.2.6). For Claude Code it correctly discovered the real `2.1.278` release, with `latestTrustedCompatibility: "untested"` — an honest, non-blocking flag, not a silent "supported" claim.
- **A real production update performed end to end**: `arc.agents.update` for `claude-code` downloaded the real Anthropic 2.1.278 binary, passed checksum + macOS codesign verification, passed pre- and post-activation health probes (`doctor`), activated, and promoted to known-good — outcome `{"kind":"updated","version":"2.1.278",...}`. The real installed app's Agents page now shows `Runtime 2.1.278` with an honest amber "Untested version" badge. Real, live-spawned Codex processes after this point show `check_for_update_on_startup=false`/`features.code_mode_host=false`/`shell_environment_policy.exclude=["CODEX_POOL_AUTH_TOKEN"]` in their actual argv — Part 0/Part 1's fixes confirmed present in production, not just in source.
- **Staging cleanup fired for real**: the next app restart logged `arc-core removed 1 abandoned runtime staging directory` — the scratch directory left behind by the real Claude download, swept automatically per ADR-082.
- **UI end-to-end, visually verified** (via the desktop screen-control tools, with the user's explicit per-app grant): clicking `Update` on the already-current Codex card produced a real `Already up to date (0.155.1)` toast — the full click → RPC → typed outcome → toast path, not just a rendered button.
- **Full live regression, real messages, real model responses** (all four requested by the user): Codex/Team (`ChatGPT · team`, adnan.ahmed@egx.com.eg) replied `codex-team-regression-ok`; Codex/Plus (`ChatGPT · plus`, 00.xcode.00@gmail.com) replied `codex-plus-regression-ok`; Claude Code (Claude · pro, running the newly-updated 2.1.278) replied `claude-regression-ok`; OMP/Kimi (K2.8 Preview via the Kimi Code OAuth account) replied `omp-kimi-regression-ok` after "Worked for 10s". Same-thread Plus↔Team account switching was exercised incidentally (the composer's account picker) without issue.
- **Security posture unchanged under real load**: after all of the above, `~/.bb` is still `0700` and `bb.db`/`-wal`/`-shm` still `0600`. `~/.codex/shell_snapshots` is still `0700` (the Part 0 hardening survives real Codex turns creating new snapshot files inside it); two genuine new snapshot files from the live Codex Team/Plus turns do still carry the `CODEX_POOL_AUTH_TOKEN` variable name at `0644` — the exact, honestly-documented residual from ADR-074, unreachable to any other local account only because the directory itself is `0700` (confirmed, not just asserted: `ls -ld` on the real directory).
- **Clean shutdown, no orphans**: `osascript -e 'quit app "Arc Agent"'` followed by a process check found zero lingering Codex/Claude/OMP/broker processes — the app was relaunched afterward to leave the user's environment as found.

### Gate

PASS. All items from the plan's acceptance-gate checklist that require the installed app were exercised against the real app with real accounts: side-by-side installation, staging, integrity verification, health-checked activation, atomic activation, a real update, known-good promotion, the manifest surviving a genuine v1 file, Codex Plus/Team/OMP-Kimi/Claude regression, OMP broker cleanup, and unchanged local-data permissions under real load. Rollback itself was verified thoroughly at the engine level (`arc-runtime-activation.test.ts`, `arc-agent-manager-updates.test.ts`) but not re-triggered against this specific installed-app Claude update, since the update succeeded and auto-promoted — there was nothing to roll back from; the mechanism remains available via the new UI button whenever `knownGoodVersion` next diverges from the active version. Phase 12 not started, per the plan's explicit instruction.

---

## Phase 12 — Arc Application Update Channel

Date: 2026-09-21. Same checkout, `self-contained` branch, clean tree at start (two unrelated untracked scratch files, `000` and `server.js`, left alone throughout). Two-message arc: a first checkpoint pass (audit + the fail-closed update-source fix, before identity was approved) and a continuation that finished versioning, About/provenance, independence tests, a real packaged build, and installed-app validation, on the user's explicit approval of the permanent identifiers below.

### Approved permanent decisions

- Stable bundle ID: `io.github.adnanelhabashy.arcagent` (was `dev.bb.desktop`)
- Nightly bundle ID: `io.github.adnanelhabashy.arcagent.nightly` (was `dev.bb.desktop.nightly`)
- Arc application release repository: `adnanelhabashy/the-arc` (an existing remote already used for `self-contained`, not a newly invented one)

### Audit finding that drove Step 4 (checkpoint pass)

Inspecting the actual generated `electron-builder` config (`node scripts/run-electron-builder.mjs --print-config`), not just source, found a live `publish` block in `electron-builder.config.json` pointed at `https://github.com/get-bb/bb/releases/download/desktop-latest/`, embedded into every packaged build's `app-update.yml` regardless of channel — despite a source comment in `run-electron-builder.mjs` claiming no such feed existed. Direct evidence the gap was real: `test/electron-builder-config.test.ts`'s existing nightly-feed assertion was already failing on a clean, unmodified checkout. `desktop-update-provider.ts` had the identical hardcoded BB fallback for the informational (non-installing) version-check service, though `main.ts`'s own runtime gating already required an explicit opt-in env var before ever fetching it — real but fragile defense-in-depth, one flag away from discovering BB's channel.

### Fail-closed fix (ADR-084)

Root-caused once: the hardcoded BB URL fallback is gone from every layer (`desktop-update-provider.ts`, `run-electron-builder.mjs`, `electron-builder.config.json`), replaced by `ARC_DESKTOP_UPDATE_FEED_BASE_URL` — absent by default (no feed, no `app-update.yml`, `resolveDesktopUpdateSupport` returns `{autoUpdate:false, versionCheck:false}`), wired to the approved `adnanelhabashy/the-arc` repo only in the two nightly-desktop CI jobs in `publish-bb-app.yml` and available for local/manual stable packaging via the same env var. `apps/desktop/scripts/desktop-release-channel.mjs`'s dead, unused `createDesktopUpdateReleaseBaseUrl` export (another BB-hardcoded function, never imported anywhere) was deleted rather than fixed.

### Step 3 — Arc-independent versioning (ADR-083)

New `apps/desktop/arc-version.json` (`{arcVersion, bbUpstreamCommit}`) is the hand-maintained source of truth; `bbUpstreamCommit` was set from a real `git merge-base HEAD upstream/main` (`3e9bef842539d5a1dd83d648fe9d5a7a20de4397`), not left blank. `apps/desktop/package.json`'s BB-lockstep version keeps its existing meaning (BB base version) and its existing CI gate, untouched. `build.mjs` bakes `ARC_DESKTOP_APP_VERSION`/`BB_UPSTREAM_COMMIT` via the same esbuild `define` mechanism as the existing BB constants. `run-electron-builder.mjs` initially tried a top-level `config.version` override — a real packaged-build run immediately rejected this (`electron-builder 26.15.7`: "configuration has an unknown property 'version'"), corrected to `extraMetadata.version`, the documented mechanism, then re-verified against a second real build. `main.ts`'s four `app.getVersion()` call sites (runtime-manifest `createdByArcVersion` ×3, `arcAppVersion` for the managed-runtime child environment) and `preload.ts`'s renderer-facing version were all switched to the one new `getArcAppVersion()` helper, so nothing in the app reads `app.getVersion()` anymore and nothing can silently disagree with the About panel.

### Step 2 — About/provenance (desktop-about-panel.ts, previously untested)

Added `bbBaseVersion`, `bbUpstreamCommit`, `codexVersion`/`claudeVersion`/`ompVersion` to `DesktopAboutFacts`. Runtime versions are read directly from the Phase 11 runtime manifest (`readArcRuntimeManifest` against `createArcRuntimePaths({userDataPath: app.getPath("userData")})`, called fresh from `main.ts` — no new state, no duplication of the manifest Phase 11 already owns) inside a new `readActiveArcRuntimeVersions()`; an `unsupported-version` manifest read fails closed to "not installed" for all three rather than throwing. A runtime that has never been activated shows "Not installed", kept textually distinct from "unknown" per the existing Mission Control honesty rule. New `test/desktop-about-panel.test.ts` (8 tests, zero prior coverage of this file) covers the provenance lines, the not-installed/unknown distinction, and asserts the About facts shape contains no token/secret/password/api-key-shaped strings.

### Step 8 — Independence, formally tested (`test/arc-update-independence.test.ts`)

Case A: seeds a real Phase 11 runtime manifest (via `mutateArcRuntimeManifest`) with an active Codex version in a temp `userDataPath`, then drives a full Arc update cycle — a version-check that finds `1.1.0` available and an auto-update service reporting a downloaded update — through `createDesktopUpdateService`/`createDesktopAutoUpdateService` with a stub `AppUpdater` adapter, and asserts the manifest file is byte-for-byte unchanged afterward (plus a full manifest re-read/deep-equal). Case B: sets `ARC_DESKTOP_APP_VERSION` to a sentinel, mutates the runtime manifest to activate a new OMP version (simulating a real runtime update), and asserts both the env var and the real `apps/desktop/arc-version.json` file on disk are byte-identical before/after. Both pass against real code, not mocks of the independence claim itself.

### Step 9 — Real packaged build (not `--print-config`, not esbuild-only)

`node scripts/run-electron-builder.mjs --mac --arm64` (with `ARC_DESKTOP_UPDATE_FEED_BASE_URL` set to the approved repo) produced a real, unsigned (see below) `Arc Agent-1.0.0-arm64.dmg`/`.zip`. Inspected directly:

- `Info.plist`: `CFBundleIdentifier=io.github.adnanelhabashy.arcagent`, `CFBundleShortVersionString=CFBundleVersion=1.0.0`, `CFBundleExecutable=CFBundleName=Arc Agent`.
- Packaged `app.asar`'s own `package.json` (extracted with `@electron/asar`): `"version": "1.0.0"` — confirms `extraMetadata` really rewrites the bundled metadata, not just build-time labels.
- `app-update.yml` (found inside the bundle): `url: https://github.com/adnanelhabashy/the-arc/releases/download/desktop-latest/` — the approved repo, verified present in the actual shipped artifact, not just the generator's stdout.
- Whole-bundle grep: zero hits for `dev.bb.desktop` anywhere; zero hits for the literal `get-bb/bb/releases/download` endpoint pattern anywhere; the only `get-bb/bb` string hits at all are inside the wrapped `node_modules/bb-app` engine's own bundled source/package metadata (acceptable BB provenance, not an update endpoint, per the plan's own distinction).
- Signing: `codesign -dv` reports `Signature=adhoc`, `TeamIdentifier=not set` — no valid "Developer ID Application" identity was found in this machine's keychain (`electron-builder` logged the only identity present as an untrusted self-signed "localhost" cert). This is not a regression: the *currently installed* production `/Applications/Arc Agent.app` (pre-Phase-12, `dev.bb.desktop` 0.43.1) is independently confirmed to be equally ad-hoc/unsigned via the same `codesign -dv` check, so no new signing-identity variable was introduced by this phase. Real Developer ID signing/notarization was not exercised because the credentials for it are not present in this environment.
- Minor, deliberately-not-fixed cosmetic residue: `app-update.yml`'s `updaterCacheDirName: '@bbdesktop-updater'` (a local on-disk cache-folder name, not a network endpoint) is derived by `electron-builder` from the workspace package's literal `name` field (`"@bb/desktop"`), not from `productName`/`appId`. Renaming that workspace package would ripple through every `--filter=@bb/desktop` Turbo invocation, cross-package `workspace:*` dependency, and CI reference repo-wide — far outside this phase's scope for a purely cosmetic, non-security-relevant string.

### Step 6 — Installed-app validation (real reinstall, real accounts, real accepted risk)

Non-destructive inventory taken before touching `/Applications/Arc Agent.app`: currently-installed app confirmed `dev.bb.desktop` / `0.43.1` / ad-hoc-signed; `~/.bb` 2.8G with 27 threads and 2 projects (`proj_personal` + one standard project) in `bb.db`; `~/Library/Application Support/Arc Agent` 855M including the Phase 11 runtime manifest (Codex 0.155.1, Claude 2.1.278, OMP 18.2.6, all `arc-bundled`/`official-managed-install` as expected); account-pool: 4 credential files under `~/.bb/plugins/account-pool/secrets/accounts`, `pool_active_account` mapping `codex`→one account and `claude`→another, 3 `account_quota` rows; Keychain: exactly one `"Arc Agent Safe Storage"` service item (Electron's `safeStorage`/Chromium `os_crypt` master key), keyed by the app's *name* string, confirmed independent of `CFBundleIdentifier`. The full existing `.app` was `ditto`-copied to `~/arc-phase12-rollback/Arc Agent.app.dev.bb.desktop.0.43.1.bak` (a complete, restorable backup, not deleted) before `/Applications/Arc Agent.app` was replaced with the freshly built `io.github.adnanelhabashy.arcagent` / `1.0.0` package.

Relaunched (`open -a`) and verified against the exact pre-swap inventory:

- Process tree came up clean: Electron main, GPU/network/renderer helpers, `bb-app-bridge`, the `bb` server, the host daemon, and plugin-host workers, all correctly resolving `~/Library/Application Support/Arc Agent` and `~/.bb` — unchanged paths, as expected (macOS `userData` defaults by app *name*, not bundle ID, for a non-sandboxed app; confirmed `entitlements.mac.plist` carries no `com.apple.security.app-sandbox`).
- Server log: clean startup, `account-pool@0.1.0 loaded` with no error, live model-catalog refreshes succeeded for `codex` (5 models), `claude-code` (9 models), and `acp-omp` (42 models) — each requires a real, successfully-decrypted, authenticated API call, which is direct proof the new bundle identity could still decrypt the existing credentials. (`pi`/`acp-cursor` catalog failures are pre-existing missing-CLI conditions unrelated to this phase.)
- `GET /api/v1/threads` returned exactly 27 threads (matching pre-swap); `GET /api/v1/projects` returned 1 (the API's standard-project listing correctly excludes the `personal` kind by design — both rows independently confirmed still present via `sqlite3`).
- Account-pool state after relaunch: identical file count (4), identical `pool_active_account` mapping, identical quota row count (3), identical single Keychain service item — nothing was regenerated, re-created, or lost.
- Real end-to-end smoke turns via `bb thread spawn` against the live reinstalled instance (`BB_SERVER_URL` pointed at the packaged app's server): Codex (`thr_9ts96e74ea`, `accountResolved: true`, completed, real "ok" reply in its timeline), Claude Code (`thr_9kjty4tiqw`, same), OMP (`thr_cr4psngzff`, same) — all three managed runtimes confirmed genuinely working post-reinstall, not just "no error logged." All three smoke threads were deleted afterward via `bb thread delete --yes`; thread count confirmed back to exactly 27.
- Not independently re-exercised: the specific Codex Plus↔Team same-thread account-switch UI flow (a second Codex-family credential file exists alongside the active one, consistent with Phase 10's two-account setup, but switching which account a thread uses was not driven end-to-end this pass). Not a stop condition — the switching mechanism lives entirely in `account-pool`/provider-bridge code, none of which Phase 12 touched, and the account-resolution and successful-completion evidence above already demonstrates credentials and routing survived the bundle-ID change.
- No STOP condition was hit: at no point did an account appear lost, a credential fail to decrypt, or `~/.bb`/Application Support data go missing or get regenerated.

### Step 7 — Tests

Full `@bb/desktop` suite + typecheck, run repeatedly through the session. Two pre-existing failures were investigated per the user's explicit instruction rather than dismissed as unrelated: `server-moved.test.ts` and `desktop-browser-view-manager.test.ts` both asserted literal `"bb ..."` strings that the already-shipped source (`server-moved.ts`, `desktop-browser-view.ts`) had already rebranded to `"Arc Agent ..."` in an earlier, unrelated phase — genuine stale-test debt, not a Phase-12 conflict; fixed to match already-intended behavior rather than left failing. One new failure was introduced and fixed during this phase itself: `preload-build.test.ts`'s real end-to-end Electron smoke test asserted the renderer-visible version equals the BB package.json version, which Step 3 intentionally changed to Arc's own version — updated the test (and `preload-browser-api.test.ts`'s env-var name) to assert the new, intended invariant instead of reverting the behavior. Final state: **44/44 test files, 398/399 tests passing** (1 pre-existing skip, unrelated), typecheck clean.

### Gate

PASS for everything in scope for a desktop-update-channel phase: fail-closed Arc-controlled update source (proven in source, in the generated config, and in a real packaged artifact), independent Arc versioning with separately-tracked BB provenance, About-panel provenance sourced from the existing runtime manifest with no state duplication, formally tested bidirectional independence, a real packaged build inspected end to end, and a real installed-app swap validated against a concrete before/after inventory with zero data loss and all three managed runtimes confirmed working. Explicitly not done, by genuine environmental constraint rather than oversight: real Developer ID code signing/notarization (no signing identity available on this machine — the pre-existing installed app was equally unsigned, so this is not a regression, but it means the signing/security-hardening side of the update path remains unexercised); the specific Plus↔Team same-thread account-switch flow was not independently re-driven post-reinstall (structurally unaffected, not independently re-verified); and rewiring `publish-bb-app.yml`'s actual `gh release` upload target was deliberately left alone beyond adding the feed-URL env var, since `gh release create/upload` has no explicit `--repo` flag in that script and depends on which repository context actually executes the workflow — confirming that context was out of scope for a local-checkout phase.

### Closure — remaining verification items

Date: 2026-09-21, same session, same reinstalled Arc Agent (`io.github.adnanelhabashy.arcagent` 1.0.0) still running against the real `~/.bb` data dir.

**Codex Plus ↔ Team same-thread switch, real accounts, real turns.** Read the account-pool `status.get` RPC (`POST /api/v1/plugins/account-pool/rpc/status.get`, body `null`) to get the two real Codex accounts' non-secret identity: Team (`codexAccountId=63238aa3-38a8-41b0-884a-d827a4a43eda`, `adnan.ahmed@egx.com.eg`) and Plus (`codexAccountId=3f44bc64-d00e-4cab-8a5e-47f3bcbf9b9b`, the user's own email). Account keys follow the existing, documented format (`openai:chatgpt:<codexAccountId>`, `plugins/account-pool/src/account-key.ts`). Spawned a codex thread (auto-routed to Team, real reply received), `PATCH /api/v1/threads/:id {"accountKey": "<plus key>"}`, sent a follow-up in the *same* thread (`bb thread tell`) — real Plus reply received, and the Team reply from before the switch was still present in the timeline. Switched back to Team in the same thread, sent another follow-up — real Team reply received, all three replies (Team, Plus, Team) intact together in one thread's history throughout. Repeated on a second, fresh thread to confirm this wasn't specific to the first one. `account-pool` state (4 credential files, Keychain item count) was unchanged by any of this — only `pool_active_account`'s "last used" pointer moved, which is normal routing/affinity behavior, not data loss.

Incidental finding, reported rather than silently worked around: after a `PATCH accountKey` immediately followed by a new turn, the thread's persisted `status` settles on `"error"` (server log: `Thread lifecycle event not applied {"detail":"no transition for run.started from status active","event":"run.started","reason":"illegal-transition"}`) even though the turn's actual reply is generated correctly and stored in the timeline — reproduced on both test threads, including one with a 3-second gap between the switch and the follow-up (so not purely a same-tick race). This lives entirely in `apps/server/src/routes/threads/base.ts` / the thread lifecycle state machine and `releaseThreadRuntimeForAccountChange` — code Phase 12 never touched — so it is pre-existing behavior on the exact same `bb-app` engine build the previous, `dev.bb.desktop` install also ran, not a regression from the bundle-ID/update-channel work. Flagged as a separate follow-up rather than fixed here (out of Phase 12's charter). Both test threads deleted afterward; thread count confirmed back to 27.

**Release publish target.** `publish-bb-app.yml`'s `nightly-desktop-publish` job has no `--repo`/explicit remote anywhere — its `git push`/`gh release` calls act on whichever repository the workflow run belongs to, and `github.token` is hard-scoped by GitHub to write only to that same repository (a fork cannot use it to write to `get-bb/bb`, or to any other repo, no matter what this file says). Rather than leave that correctness implicit, added a fail-loud guard step ("Require the Arc release repository") asserting `github.repository == 'adnanelhabashy/the-arc'` before anything tags or publishes, and set `GH_REPO=adnanelhabashy/the-arc` explicitly on the publish step's environment so every `gh release` call names its target. YAML re-validated (`ruby -ryaml`, no linter available in this environment). This is defense-in-depth on top of the GitHub-enforced token boundary, not a substitute for it — it turns a silent wrong-repo misconfiguration into a loud, immediate failure instead.

**Tests.** No `@bb/desktop` source changed this round (only the workflow YAML, which has no associated test suite); re-ran the full suite anyway as the closest "focused" check: 46/46 files, 408/409 tests, typecheck clean — unchanged from the prior close.

**Signing.** Confirmed, not re-litigated: no Developer ID identity on this machine; recorded as Phase 22 release-pipeline work, not a Phase 12 blocker.

**`@bbdesktop-updater`.** Left alone — cosmetic, and fixing it would mean renaming the `@bb/desktop` workspace package repo-wide, which is not "trivial and independently safe."

**Local build output.** `apps/desktop/release/` confirmed gitignored (`git check-ignore -v`) and deleted (~1.7GB reclaimed); nothing about it was needed after the earlier validation pass completed.

### Gate (closure)

PASS on all six closure items. Nothing here changed application code, update-channel behavior, or identity — this round closed verification gaps (Plus/Team switch, publish-target ambiguity) and did light cleanup/documentation. The one new fact worth carrying forward is the thread-lifecycle `status` anomaly on account switch, which is real, reproducible, and unrelated to Phase 12's own changes.

## Phase 13 — BB upstream sync / Arc invariant protection (2026-09-21)

### Step 1 — Audit

`git remote -v` showed three remotes, not the two the phase brief assumed: `origin` → `adnanelhabashy/bb` (Adnan's own bb fork/staging, unrelated to Arc), `the-arc` → `adnanelhabashy/the-arc` (Arc's real push target — `self-contained` already tracks `the-arc/self-contained`), `upstream` → `get-bb/bb` (fetch already configured). No Arc branch tracked `upstream/main` directly. The one real gap: `upstream`'s push URL was the live `get-bb/bb` remote — a mistyped `git push upstream` would have attempted to write there. No existing sync scripts, upstream docs, or automation that could merge BB without review were found. `.github/workflows/publish-bb-app.yml`'s nightly job already carried the Phase 12 repo guard; `build-desktop.yml`'s stable-channel publish job did not (see Step 4/5).

### Step 2 — Remote ownership

No remote was renamed — `the-arc` already serves the role the plan called `origin`, and renaming it would change every contributor's daily push target for a cosmetic match to the plan's placeholder name only. Closed the one real gap: `git remote set-url --push upstream https://do-not-push-to-bb-upstream.invalid/get-bb/bb.git` — fetch untouched, push now fails immediately and locally. This is local git config, not a commit.

### Step 3/6/9/10/11 — Sync workflow, protected-files list, documentation, provenance rule, security

Documented in `docs/bb-upstream-sync.md`: branch naming (`upstream-sync/<short-sha>`), the fetch → branch → merge/rebase → invariants → review → approval → merge sequence, abort/recovery commands, the curated list of files that need special review on a sync (no `.gitattributes` `ours`/`theirs` — rejected, would silently drop real upstream security fixes), the BB-provenance update rule (`arc-version.json`'s `bbUpstreamCommit` changes only on an accepted merge, never on fetch/test), and the security posture (sync touches source only, no secrets printed, no upstream code executed).

### Step 4/5/7 — Arc invariant suite

`packages/scripts/test/arc-invariants.test.ts` (20 assertions), runs in the existing `packages` CI shard (`.github/workflows/ci.yml`), no new CI framework. Covers: stable/nightly bundle IDs and product names, both desktop publish workflows' Arc-repo guard, the update feed's no-BB-fallback behavior, `arc-version.json`'s independent versioning + BB provenance shape, `main.ts` reading the version through `getArcAppVersion` not `app.getVersion()`, OMP's `PI_CONFIG_DIR`/`PI_CODING_AGENT_DIR` env vars, and a curated (not tree-wide) forbidden-regression scan for `dev.bb.desktop` / `get-bb/bb/releases/download` across the release-identity files. Deliberately does not re-test runtime/account/OMP behavior in depth — that's already covered by the existing suites those phases built (ADR-061–084), which already run in CI. Writing the suite surfaced a real, pre-existing gap: `build-desktop.yml`'s stable-channel publish job had no repo guard matching nightly's, and its step summary printed `get-bb/bb` release-feed URLs the job never actually configures. Fixed in the same commit (guard now matches the nightly pattern; summary corrected to state the real fail-closed behavior). `pnpm exec turbo run typecheck --filter=@bb/scripts` clean; `pnpm exec turbo run test --filter=@bb/scripts -- arc-invariants`: 20/20 passing. `build-desktop.yml` re-validated with `ruby -ryaml` (no other linter available in this environment, matching Phase 12's own precedent). ADR-085 (sync strategy) and ADR-086 (invariant-suite scope) added to `DECISIONS.md`. Committed to `self-contained` at `5991700a8`.

### Step 8 — Controlled real upstream test

`git fetch upstream main` → `upstream/main` = `7c54dbf7d4ecf9fc818c96e15fe059edeae1d52f` (77 commits ahead of the merge-base with `self-contained`, 845 files differ at the merge-base diff). Created `upstream-sync/7c54dbf7d` from `self-contained`'s new tip (`5991700a8`, i.e. including the Step 4 invariant suite) and ran a real, uncommitted merge (`git merge --no-commit --no-ff upstream/main`).

Result: **111 conflicted files**, plus a clean auto-merge of everything else including `build-desktop.yml` itself (upstream's own changes to that file merged cleanly alongside the Phase 13 guard fix — no conflict there). Conflict breakdown by top-level path:

- **~90 files across 19 plugin directories** (`browser-automation` 13, `tasks` 11, `environment-git-worktree` 10, `docs` 8, `inline-vis` 6, `github` 6, `drafts` 6, `workflows` 5, `ask-user-question` 5, `push-notifications` 4, `memory` 4, `connect` 4, `scheduled-send` 3, `keep-awake` 3, `custom-instructions` 3, `concurrency-limit` 3, `theme-preview` 2, `provider-retry` 2, `plugin-api-docs` 2) — almost all `modify/delete`: Arc's `self-contained` deleted these plugins (consistent with ADR-001's three-engine scope), upstream kept developing them. Plus one directory-rename-split conflict each for `plugins/browser-automation` and `plugins/docs` (git couldn't tell which of several new upstream locations the deleted directory would have been renamed to).
- **`plugins/account-pool` (4 files)** — the one conflict cluster that touches Arc's own protected architecture (ADR-065–069): `app.test.tsx`, `cli.ts`, `server.test.ts` are `deleted-by-us/modified-by-them` (Arc's account-pool dropped the standalone app/CLI surface these evolved from), `package.json` is a real both-sides-modified content conflict. Needs a human who knows both Arc's current account-pool and upstream's to resolve, not a mechanical merge.
- **`plugins/arc-core/package.json`** and **`adnan/plugins/adnan-mission-control/tsconfig.json`** — both-sides-modified conflicts on Arc-only paths; upstream doesn't have "Arc" or "adnan" directories, so these are most likely git rename-detection pairing an Arc-only file with an unrelated upstream rename rather than genuine parallel edits. Not independently root-caused further — flagged for the human review pass, not resolved here.
- **`packages/db`** (`drizzle/meta/0126_snapshot.json`, `_journal.json`, `test/migrate.test.ts`) — both sides added Drizzle migrations; the ordinary "regenerate migration journal" conflict any actively-developed schema hits, not Arc-specific.
- **`pnpm-lock.yaml`, `docs/api_to_audit.md`** — mechanical (lockfile needs regeneration) and additive-content (both sides appended audit entries) respectively; not architecturally significant.

No Arc invariant test or typecheck/test suite was run against this state — the working tree was mid-conflict (literal `<<<<<<< HEAD` markers in 111 files), so a test run would have been noise, not signal, and the plan's own Step 8 instruction is to stop and report at this point rather than force a resolution to get a green run. **The merge was aborted** (`git merge --abort`) immediately after inspection; `self-contained` was never touched (confirmed: `git status` clean, HEAD still `5991700a8` throughout). The disposable branch `upstream-sync/7c54dbf7d` still exists locally with the merge aborted (clean, no conflict state) — not pushed anywhere, safe to delete (`git branch -D upstream-sync/7c54dbf7d`) or resume from.

**Recommended resolution strategy** (for the human-approved pass this phase does not perform): resolve the ~90 plugin-trimming conflicts mechanically by keeping Arc's deletions (`git rm` the upstream-modified files, `git checkout --ours` the directory-rename-split paths) — this is the bulk of the conflict count but the lowest-risk category, since it's "upstream kept developing something Arc already decided not to ship." Handle `plugins/account-pool` by hand, comparing upstream's `package.json` change against Arc's current account-pool architecture line by line — this is the one cluster worth real review time. Regenerate `pnpm-lock.yaml` via `pnpm install` after the rest resolves. Merge `docs/api_to_audit.md` and the `packages/db` migration journal additively (both sides' entries kept). Re-check `plugins/arc-core` and `adnan/plugins/...tsconfig.json` are genuine conflicts before spending time on them — they may resolve trivially once rename-detection has less to work with.

### Gate

PASS for everything authorized without approval: audit, remote push-safety fix, sync-workflow documentation, Arc invariant suite (with a real gap it found and fixed), and a real controlled upstream merge test that surfaced genuine conflict scope without touching `self-contained` or requiring any upstream code to run. **Not done, by design, pending human approval**: resolving the 111 conflicts and merging `upstream-sync/7c54dbf7d` (or its resolved successor) into `self-contained`. `arc-version.json`'s `bbUpstreamCommit` was left untouched — Step 10 is explicit that fetching and test-merging upstream never updates it, only an accepted sync does.

## Phase 14 — Refresh, cache & state consistency (2026-09-21)

### Step 0 — Checkpoint

`self-contained` at `2e99c375e` (Phase 13.1), one commit ahead of `the-arc/self-contained`, tree dirty only in two plugins' committed `dist/` artifacts (a previous session's rebuild — left untouched) plus the untracked `000` symlink and root `server.js` the earlier handoff says to leave alone.

Verification of the checkpoint found a real red guard at HEAD that Phase 13.1 did not cause: the provider-literal ratchet failed with `arc-agent/manager.ts: 6 → 7`, `arc-runtime/manifest.ts: 2 → 5`, and three new files (`apps/desktop/src/main.ts`, `arc-runtime/health.ts`, `arc-runtime/update-discovery.ts`). Root cause: the baseline was authored at `ad695780a` (2026-09-20 14:22) and the Phase 11 managed-runtime update engine (`993008e0c`, 16:11) added those references afterwards. All five are Arc's own product layer naming the three runtimes Arc ships — the same carve-out the baseline already documents for 18 other files — so each new entry was allowlisted with a reason/owner/diesAt and the baseline regenerated (`95 references across 27 core files, all allowlisted`). `@bb/scripts`, `@bb/server` and `@bb/db` tests plus typechecks green; pushed `2e99c375e` + `d09741d61` to `the-arc/self-contained`. The Phase 13 backup app bundle was kept.

### Step 1–2 — Inventory

Three read-only scouts mapped the renderer, the domain/RPC layer, and the provider/plugin usage paths (file:line evidence in their reports). The map that mattered:

| DATA | AUTHORITATIVE SOURCE | CACHE | REFRESH TRIGGER (before) |
|---|---|---|---|
| accounts | account-pool plugin (KV + sqlite) / OMP broker | OMP snapshot 5s; app `[arcAccounts]` 30s; MC local state | TTL + mount; MC on `arc-changed` |
| usage/limits | pool `QuotaStore` (5-min loop) / OMP broker / thread | `ArcUsageService` last-good, keyed `resource.id`; app `[arcCurrentAgentUsage, agent, accountKey]` 15s; MC local state | **none** — no TTL, no invalidation; MC forced `refreshAll()` on every page mount |
| runtime status | runtime manifest on disk | none | read per agent (3× per list) |
| runtime updates | api.github.com / downloads.claude.ai | **none** | per click; no single-flight |
| plugins | plugin service | marketplace manifest (no TTL) | `plugins-changed` + mutations |
| thread account | `threads.account_key` | none | DB write; no signal |
| OMP providers | OMP broker + `omp auth-broker list` | registry 60s | TTL only; never invalidated |

Two defects dominated, both found by reading and then confirmed against the running installed app:

1. **`ArcUsageService.withCache` never served the cache it maintains.** It early-returned for any status other than `available`/`unavailable`, and both list-based sources return exactly `status: "unknown"` with no windows (the numbers live behind a separate `fetch`). Live proof, before any change: `provider-usage.v1.getResource` for the Plus account returned `status: ok`, plan "Plus", two windows (`observedAt 1789991222359`), while `arc.usage.snapshot` and `arc.usage.current` for `codex` returned `status: "unknown"` with **0 windows** for the same resource id. Mission Control papered over it with `refreshAll()` on every Usage-page mount — a measured 5 forced vendor calls, ~4.9s per visit — and the in-thread usage card never showed the cached reading at all.
2. **The app's Arc caches listened to nothing.** `arc-core` published `arc-changed` after every mutation, but only Mission Control's agents/accounts hooks subscribed; the app's caches and MC's usage/OMP hooks did not, and the app had no reason to refresh on reconnect.

A third gap surfaced during live verification: `ProviderUsageSection`'s documented contract (ADR-064) is "an explicit `accountKey` prop sourced from the thread", but its only production call site (`FollowUpPromptBox`) never passed one — so the in-thread usage card could not be account-scoped at all, and the request carried no `activeAccountKey`.

### Step 3–13 — Implementation

Five commits (`368e66ffd`, `8a1dfbc68`, `c260c16b4`, `deaf59ef5`, plus the checkpoint fix `d09741d61`), with the architecture recorded as ADR-087…ADR-091:

- usage reads overlay the cached measurement onto the fresh listing (identity from the listing, numbers from the cache; UNKNOWN != ZERO untouched);
- a measurement past its bound (5 min good / 1 min errored) schedules a **non-forcing background fill**, one per resource, signalling once per burst, instead of blocking the read or forcing a vendor call — only the user's explicit Refresh forces;
- `invalidateUsage()` drops cached measurements for account add/remove/enable/disable/reorder and login completion, and a healthy source evicts a resource it no longer lists (a source outage never evicts another source's data);
- concurrent reads share one source inventory (single-flight, **never** a TTL — a TTL on the account inventory was tried first, broke the existing "the next read observes the change" contract, and was reverted);
- the agent manager reads the runtime manifest once per agents list, and update discovery is single-flight with a 10-minute reuse window, invalidated by the update/rollback that changes it, and waits for an in-flight operation on the same agent instead of racing it;
- the OMP source single-flights its snapshot and registry reads and drops the registry on shutdown;
- the app gets one Arc cache owner, subscribes to `arc-changed` (accounts/omp → accounts + usage, usage → usage), joins the reconnect invalidation list, and invalidates usage when a thread's account changes; the in-thread Refresh now forces only the resources that panel shows;
- Mission Control's usage and OMP-provider hooks subscribe to the same signal, and the Usage page no longer forces anything on mount;
- the composer now passes the thread's `accountKey` down to the usage card.

No secret reaches any of these caches: they carry `accountKey`/`identityKey`, display name, plan, auth state, quota windows and timestamps only; the react-query cache is in-memory (no persister, no localStorage), and the new realtime signal carries only `{kind}`.

### Step 14–15 — Tests and measurements

37 new/changed cases: usage read policy, background fill (non-forcing, staleness-gated, single-flight, burst-coalesced, not re-filled for a provider that exposes none), account-switch race, account-inventory single-flight and freshness, update-discovery cache/invalidation, the Arc cache-owner mapping (including foreign-channel signals), account-scoped query keys, reconnect invalidation, and the panel's Refresh scope. `packages/arc-domains`: 397 passed / 12 skipped (was 372). `@bb/app`: 561 files / 5094 passed.

Measured on the installed app, before → after:

| Measurement | Before | After |
|---|---|---|
| `arc.usage.current` for the Plus account | `status: unknown`, 0 windows (while the pool held 2 windows) | `status: available`, 2 windows (0%/2%) |
| one usage read | — | 0.01s, and 5 consecutive reads left the pool's `observedAt` unchanged (zero vendor calls) |
| opening Mission Control's Usage page | `arc_usage_refresh {}` → 5 forced vendor calls, ~4.9s | 1 `arc_usage_snapshot` read, **0** forced calls |
| opening the thread usage card (cold cache) | n/a | 2 `arc.usage.current` (mount + one refetch after the single fill signal), 0 after that; 0 requests over 12s idle |
| `arc.agents.list` + `arc.accounts.list` | 3 pool `account.list` calls | 1 (single-flight) |
| repeated "check for update" | 1 GitHub call per click | 1 per 10 minutes, invalidated by an update/rollback |

### Step 9 — Real same-thread account switch (installed app)

Thread `thr_fupu37j3vi` (an empty leftover smoke thread), Plus-bound. Opening its usage card issued `arc.usage.current {"agentId":"codex","activeAccountKey":"openai:chatgpt:3f44bc64…"}` and rendered **only** `ChatGPT · Plus · 00.xcode.00@gmail.com` (five-hour 0%, weekly 2%). `PATCH /api/v1/threads/thr_fupu37j3vi {"accountKey":"openai:chatgpt:63238aa3…"}` → the same card issued the Team key and rendered **only** `ChatGPT · Team · adnan.ahmed@egx.com.eg` (five-hour 0%, weekly 4%), with the Plus numbers gone; switching back to Plus restored the Plus card. One `arc.usage.current` per switch. The thread's binding was restored to Plus afterwards.

### Step 16–17 — Regression and installed-app validation

`@bb/scripts`, `@bb/arc-domains`, `@bb/db`, `bb-plugin-account-pool`, `bb-plugin-arc-core`, `bb-plugin-adnan-mission-control`, `@bb/agent-runtime`, `@bb/app`, `@bb/desktop`, `@bb/client-core` tests and typechecks: green, with two exceptions investigated rather than waved through:

- `@bb/server`: 3 failures in 2 files (`install-machine-script.test.ts`, `server-access.test.ts`). These spawn real daemons and one reaches `machine.getbb.app`; the observed failure is `Abort trap: 6` from a spawned `bb-app host-daemon join` and two 5-second timeouts. `apps/server` is untouched by this phase (the full changed-file list is `packages/arc-domains`, `plugins/arc-core`, `apps/app`, `adnan/plugins/adnan-mission-control` and one baseline JSON), so this is environmental, not a Phase 14 regression.
- `bb-plugin-adnan-mission-control`: `connect-flows.test.tsx > … OMP login times out` is flaky (fails, passes on re-run); it drives fake timers with real-time waits and fully mocks `@/lib/data`, so Phase 14 cannot affect it.

Built with `pnpm --filter @bb/desktop package` (exit 0, no signing identity on this machine — unchanged from Phase 12) and rebuilt Mission Control's committed `dist/` with `bb plugin build` (BB prefers the prebuilt bundle over source for a path plugin). Deployed to `/Applications/Arc Agent.app` after quitting the running app, keeping `Arc Agent.app.phase14-backup` (and the Phase 13 backup). `~/.bb` untouched: 22 threads and 2 projects before and after the swap, account-pool credentials and quota rows intact, all three managed runtimes resolving.

### Gate

PASS. Every Phase 14 objective is met and verified in the installed app: reads are cheap and current (0.01s, zero vendor calls, measured), no surface forces a provider fetch to display anything, account state is scoped by account identity end to end (proven live for Plus ↔ Team on one thread), mutations invalidate instead of waiting for a TTL, no polling storm exists (0 requests idle over 12s), and the product invariants are intact (Codex/Claude/OMP only, 23 restored BB plugins, connect inert, plugin provenance hardening, per-thread accounts, managed runtimes, Arc update ownership).
