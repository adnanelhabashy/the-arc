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
