# Arc Productization — Architecture Decision Record

Initialized from `ARC_AGENT_PRODUCTIZATION_EXECUTION_PLAN.md` §37 during Phase 0 (2026-09-18).
Status legend: Accepted · Pending verification · Blocked.
Every later architectural deviation requires adding or updating an ADR here.

## ADR-001 Arc exposes three agent engines only: OMP, Codex, Claude Code

Status: **Accepted** (verified against source)
Upstream registers `codex`, `claude-code`, `acp-omp` plus `pi` (own plugin) and ACP known agents `acp-opencode`, `acp-cursor`, `acp-grok`, `acp-hermes-agent`. Arc will gate presentation of the non-target agents; provider IDs `codex` / `claude-code` / `acp-omp` stay stable to protect persisted threads and role mappings.

## ADR-002 Codex and OMP are intended as Arc-managed runtimes

Status: **Accepted** (with implementation notes)
Codex is Apache-2.0, OMP is MIT; both provide standalone darwin-arm64 release artifacts with digests. Arc-managed copies live under Application Support, seeded from the signed bundle, verified by digest + `--version`.
Implementation notes from Phase 0: Codex needs a small plugin patch (env passthrough for `BB_CODEX_BRIDGE_APP_SERVER_COMMAND/_ARGS` + a `codexExecutable()` probe helper) for honest health/status; OMP resolves via child-PATH (`omp acp` bare command), so PATH injection suffices without a plugin patch.

## ADR-003 Claude Code uses an Anthropic-supported managed installation until redistribution rights are confirmed

Status: **Accepted**
Claude Code is © Anthropic PBC, all rights reserved / Commercial Terms — NOT redistributable. Arc drives Anthropic's official installer through the existing host-daemon PTY install channel (already streams progress to UI, no Terminal needed) and pins the result via `BB_CLAUDE_CODE_EXECUTABLE` (verified: sole declared passthrough, X_OK-validated, honored by execution/probe/health/install/usage). Open item: sign-in is currently a hint string only; an authenticate action over the same PTY channel is required later.

## ADR-004 Arc does not modify the user's global PATH

Status: **Accepted**
No writes to `.zshrc`/`.bashrc`/`~/.profile`; no global installs as the product design. Verified: no existing code path does this.

## ADR-005 Arc may inject its own runtime paths into its owned child processes

Status: **Accepted** (verified seam)
`spawnOwnedRuntime` (apps/desktop/src/main.ts:1965) constructs the owned BB child env (`{...process.env, APP_SURFACE: desktop}`). Private runtime bin dirs will be prepended there — child's PATH only, user shell untouched.

## ADR-006 Underlying systems remain owners of credentials

Status: **Accepted**
Codex credentials → Codex / Account Pool; Claude credentials → Claude / Account Pool; OMP credentials → OMP auth storage/broker. Mission Control KV stores metadata only. Verified: Account Pool secrets are 0600 files outside plugin KV; providers keep their own auth stores.

## ADR-007 Account Pool is reused for Codex/Claude multi-account functionality

Status: **Accepted** (verified)
Account Pool upstream provides both providers' login flows (Codex device-code, Claude PKCE + import), 0600 atomic secret storage, enable/disable, priority/reorder, per-account usage refresh, routing hub, and stable identity (`accountUuid`, `codexAccountId`). Arc builds presentation ("AI Accounts") on top; no rewrite.

## ADR-008 OMP remains owner of OMP provider accounts

Status: **Accepted**
Arc gets an `OmpAccountAdapter`, not per-vendor services. OMP owns provider auth and exposes machine-readable account/usage interfaces; exact CLI/API surface must be verified against the pinned Arc-managed OMP binary before parsing (plan §3.5).

## ADR-009 Usage becomes source-agnostic

Status: **Accepted** (resolved in Phase 9)
The generic `provider-usage.v1.listResources` / `getResource` contract arrived locally with the Phase 7 Account Pool import (`plugins/account-pool/src/usage-contract.ts`) and is consumed as-is by the Arc usage service (ADR-052); Mission Control's old direct+pool dashboard stays untouched until Phase 10 migrates it onto `ArcUsageService`.

## ADR-010 Accounts are deduplicated only using trustworthy canonical identity, never by email alone

Status: **Accepted**
Canonical keys verified available: `openai:chatgpt:<accountId>`, `anthropic:account:<accountUuid>`. OMP-side equivalence must be proven against real OMP output before merging OMP-exposed accounts with direct/pool ones; email alone never merges.

## ADR-011 Arc update channel is independent from BB

Status: **Pending verification** (currently VIOLATED at source level)
Generated Electron config still contains `publish.url = https://github.com/get-bb/bb/releases/download/desktop-latest/` and `appId = dev.bb.desktop`. Runtime auto-update is disabled by default (`BB_DESKTOP_AUTO_UPDATE=1` gate) and the installed app ships no app-update.yml, so no live overwrite risk today — but the config-level fix is mandatory in Phase 12. Arc identity (appId, release tags, feed URL) pending user approval.

## ADR-012 BB upstream updates are maintainer-controlled syncs, never end-user updates

Status: **Accepted** (verified)
`upstream` remote exists → get-bb/bb. Sync flow: upstream/main → sync branch → Arc integration/tests → Arc release. No auto-merge into production. Arc invariant checker (plan §13) to be added.

## ADR-013 No automatic quota-driven model rerouting in v1

Status: **Accepted**
Role Router keeps current mappings; account/usage health is advisory metadata only. Pooled routing is opt-in and visible, never silent rotation to evade limits.

## ADR-014 First polished target is macOS Apple Silicon

Status: **Accepted**
Local dev machine darwin-arm64; desktop config builds dmg/zip arm64 only; entitlements/hardenedRuntime configured. Linux AppImage path exists upstream but is out of v1 polish scope.

## ADR-015 Arc-managed Claude executable wins for Arc-owned runtimes; otherwise existing override untouched

Status: **Accepted** (implemented in Phase 1)
`buildArcManagedRuntimeEnvironment` (apps/desktop/src/arc-runtime/environment.ts) sets `BB_CLAUDE_CODE_EXECUTABLE` only when an active verified Arc-managed Claude runtime exists, and that value overrides any pre-existing environment value for the Arc-owned BB child process. When no Arc Claude is active, a user-supplied `BB_CLAUDE_CODE_EXECUTABLE` in the environment passes through untouched. Codex and OMP have no env override in Phase 1: Codex relies on prepended private PATH (explicit override deferred to the Codex provider-source port), OMP resolves `omp acp` via private PATH.

## ADR-016 Runtime manifest is authoritative for activation, but filesystem existence is required

Status: **Accepted** (implemented in Phase 2)
A runtime is active only when `runtime-manifest.json` names an `activeVersion` AND the resolved executable exists, is a regular file, and is executable (X_OK on POSIX). A manifest entry whose binary is missing is stale metadata: it is skipped, diagnosed, and never activated. The manifest lives at `<userData>/arc-runtimes/runtime-manifest.json` (schema version 1, Zod-validated), written atomically (tmp file with `wx` + rename, mode 0600) following the `packages/config/src/managed-json-file.ts` pattern. `createdByArcVersion` temporarily records the desktop app version (`app.getVersion()`) until independent Arc version metadata exists.

## ADR-017 Unmanaged binaries are never auto-activated

Status: **Accepted** (implemented in Phase 2)
A runtime binary on disk without a manifest `activeVersion` is never activated. Activation is explicit managed state only. This protects rollback and staging semantics (`staging/`, previous-version dirs).

## ADR-018 Newer-than-tested runtime versions are "untested", not automatically supported

Status: **Accepted** (implemented in Phase 2)
`evaluateArcRuntimeCompatibility` (apps/desktop/src/arc-runtime/compatibility.ts, semver-based) returns: below minimum → blocked; explicit known-bad list → blocked; newer than `maximumTested` → untested; within a recorded tested range → supported. No `maximumTested` recorded → untested. Malformed versions and runtimes without policy → untested, never crash, never silently "supported". The shipped bootstrap policy records only Codex `minimum: 0.136.0` (source: upstream `plugins/provider-codex` `minimumSupportedVersion`, fetched during Phase 0; provider sources absent locally). Tested maximums are pinned when runtimes are introduced in Phases 3–5 — no untested version is claimed supported.

## ADR-019 Future manifest schema versions are never overwritten by an older Arc release

Status: **Accepted** (implemented in Phase 2)
`readArcRuntimeManifest` returns a distinct `unsupported-version` result when `schemaVersion` exceeds the release's supported version; the file is preserved byte-for-byte, no managed runtimes are activated, and startup continues on system PATH. Missing/malformed/invalid manifests recover to a default empty manifest without crashing the desktop app.

## ADR-020 Codex ships as an immutable verified seed; Arc executes a userData copy, never the seed

Status: **Accepted** (implemented in Phase 3)
The signed application bundle carries the pinned Codex executable as a read-only seed at `Contents/Resources/arc-runtimes/codex/0.155.1/codex`. On first launch Arc copies it to `<userData>/arc-runtimes/runtimes/codex/0.155.1/codex` and executes only that copy. This keeps the signed bundle immutable while allowing later independent runtime updates and rollback without touching the app bundle.

## ADR-021 Runtime assets are digest-verified and version-probed before packaging and before activation; manifest activation is the last step

Status: **Accepted** (implemented in Phase 3)
Build acquisition (`scripts/prepare-arc-runtimes.mts` → `src/arc-runtime/acquire.ts`) verifies the downloaded archive SHA-256, rejects unexpected archive structure (single-entry enforcement, no absolute paths, no `..`, exact expected entry name, regular-file check after extraction), renames the executable to exactly `codex`, and probes `<binary> --version` against the pinned expected version before staging. Runtime bootstrap (`src/arc-runtime/bootstrap.ts`) repeats seed digest + probe, then verifies the staged copy's digest + probe, moves it into place, and only then writes the runtime manifest. Any failure leaves the manifest unchanged.

## ADR-022 The bundled seed never force-downgrades a valid managed runtime; a broken different-version runtime is not silently replaced

Status: **Accepted** (implemented in Phase 3)
If the manifest records a valid active Codex version different from the bundled pin, the existing runtime is kept (seed is a bootstrap fallback, not a downgrade mechanism). If a different active version is broken (executable missing), Arc reports a `kept-broken` diagnostic state and leaves recovery to the explicit repair/update flow (Phase 11). Same-pin damage (active version equals the pin but binary missing/broken) is repaired from the trusted seed with full re-verification.

## ADR-023 Codex uses the Arc child PATH; no explicit executable override is added in Phase 3

Status: **Accepted** (verified against the installed provider artifact)
The prebuilt provider-codex host artifact resolves a bare `"codex"` command from `process.env.PATH` at launch, version probe, and health sites (verified by inspecting `~/.bb/plugin-host-artifacts/provider-codex/*/host.mjs`). Phase 1's private PATH injection therefore suffices; no provider source was ported and no new env override invented. Honest install-source/health cosmetics (npm-global detection) remain a known gap for a later provider-source phase.

## ADR-024 Steady-state startup trusts the recorded manifest digest; full verification runs on install, repair, and anomaly

Status: **Accepted** (implemented in Phase 3)
On a normal launch with the pinned version already active and its executable present and runnable, Arc reuses the managed copy without re-hashing the ~229 MB binary or re-probing it; the digest recorded in the manifest at install time is the integrity anchor, and the runtime directory lives privately under userData. If the executable is missing/broken, or the manifest digest is absent, full verification (re-hash and/or re-probe) runs before any manifest change. Security never relies on filename alone: activation still requires manifest state plus filesystem checks.

## ADR-025 The runtime release model supports both archive and direct-executable artifact kinds in one pipeline

Status: **Accepted** (implemented in Phase 4)
Pinned release metadata carries an `artifactKind` of `"archive"` (Codex `.tar.gz`, single extracted executable) or `"executable"` (OMP standalone binary, staged directly). Download caching, SHA-256 verification, version probing, seed publishing, bootstrap, and manifest activation are shared; only the staging step branches on the kind. For direct assets `sha256` and `executableSha256` are the same file and must be identical. No parallel OMP-only pipeline was created. Trusted download URL allowlists are per-runtime; runtimes without a recorded origin are rejected at validation.

## ADR-026 Arc-managed OMP is config-isolated via OMP's own verified path overrides, set only on Arc's child environment

Status: **Accepted** (implemented in Phase 4)
Arc's managed OMP receives `PI_CODING_AGENT_DIR=<userData>/omp/agent` and, when the userData directory sits inside the user's home (the macOS case), `PI_CONFIG_DIR` as the home-relative path to `<userData>/omp`. Both variables are verified oh-my-pi v18.2.6 overrides (`packages/utils/src/dirs.ts`); no invented `OMP_*` variables are used. They are set exclusively on the Arc-owned BB child environment, so the user's standalone OMP installation and normal terminals are untouched. External `~/.claude`/`~/.codex`/`~/.gemini` model-config reads remain capability-gated and shared by design.

## ADR-027 OMP compatibility is exactly the first tested pin until evidence exists

Status: **Accepted** (implemented in Phase 4)
No minimum OMP version is verifiable from the BB ACP integration, so the policy records `18.2.6` as both minimum and tested maximum: exactly `18.2.6` is "supported", newer is "untested", older is "blocked" from auto-activation. The range is widened only with per-version compatibility evidence, never because a release is newer.

## ADR-028 The prebuilt ACP provider launches Arc OMP through the private child PATH; no provider source is ported

Status: **Accepted** (verified in Phase 4)
The installed provider-acp host artifact declares `acp-omp` with launch `command: "omp"`, `args: ["acp"]`, and resolves commands against the process PATH (bundled `resolveCommand`/`which` machinery). Arc's Phase 1 PATH injection therefore suffices end to end; the integration is proven at protocol level by an ACP `initialize` handshake against the real pinned binary running from the Arc runtime directory. Provider-acp source remains unported, consistent with ADR-023.

## ADR-029 Claude Code is never bundled or redistributed inside Arc; it is obtained directly from Anthropic on the user's machine

Status: **Accepted** (implemented in Phase 5)
`anthropics/claude-code` is © Anthropic PBC, all rights reserved, subject to Anthropic Commercial Terms — not redistributable. The Arc DMG/app bundle contains no Claude executable and never will unless explicit redistribution rights are verified. Arc's setup downloads the exact pinned build directly from Anthropic's official release endpoint (`downloads.claude.ai/claude-code-releases/<version>/<platform>/claude`) at runtime on the user's machine — download-by-end-user, not redistribution. Option A (official private install prefix) does not exist: the native installer hardcodes `~/.local` via `claude install` and supports no custom destination. Option B was chosen; Option C (running the official installer to the standard user-local destination) is the documented fallback if the direct endpoint changes.

## ADR-030 Arc pins Claude Code 2.1.276 with the checksum from the GPG-signed release manifest; runtime verification needs no gpg

Status: **Accepted** (implemented in Phase 5)
At Arc release-engineering time the full chain was verified: Anthropic's published signing key (fingerprint `31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE`, matched) verifies `manifest.json.sig` over `manifest.json`, and the pinned darwin-arm64 SHA-256 (`9de364db…6329`) was extracted from that signed manifest. Arc ships the version + checksum pin; at user setup time the downloaded binary must match the pinned checksum, pass macOS code-signature verification (Developer ID Application: Anthropic PBC, Team ID Q6L2SF6YDW), and report the exact pinned version — otherwise it is never activated. Runtime verification therefore needs no gpg on the user's machine; the GPG evidence is baked into the pin.

## ADR-031 Claude lives in the standard Arc runtime path with source `official-managed-install`; no manifest schema change

Status: **Accepted** (implemented in Phase 5)
The Arc-managed Claude is installed at the derived path `<userData>/arc-runtimes/runtimes/claude-code/2.1.276/claude`, so Phase 2's manifest v1 schema (`source: "official-managed-install"`, digest, installedAt) represents it without an `executablePath` field or schema bump. Executable paths still come only from backend discovery/setup, never from the renderer.

## ADR-032 Arc-owned Claude execution cannot silently self-update; external Claude installs are never modified

Status: **Accepted** (implemented in Phase 5)
Arc's child environment sets `DISABLE_AUTOUPDATER=1` and `DISABLE_UPDATES=1` (officially documented controls, doctor-confirmed) whenever an Arc-managed Claude is active, so the runtime under Arc's manifest cannot mutate underneath it; Arc decides when updates happen (Phase 11). These variables exist only on Arc's owned BB child environment — the user's independent Claude installations, terminals, and update behavior are untouched. Discovery classifies external installs (official-native, homebrew, npm-legacy, explicit-override, broken-launcher, arc-managed) and Arc never deletes, downgrades, or rewrites them; a valid newer external version is never downgraded.

## ADR-033 Claude credentials and settings remain Claude-owned

Status: **Accepted** (implemented in Phase 5)
Phase 5 is runtime setup only. Arc never touches `~/.claude`, `~/.claude.json`, project `.claude/`, or `.mcp.json`, stores no tokens or account data in the runtime manifest, and implements no login. Runtime readiness and account readiness remain separate states.


## ADR-034 The Arc product catalog is closed to exactly three agents

Status: **Accepted** (implemented in Phase 6)
`ARC_AGENT_CATALOG` (apps/desktop/src/arc-agent/catalog.ts) is an explicit, statically defined list of exactly three agents — OMP, Codex, Claude Code — in a fixed documented order. Arc never enumerates upstream BB providers and filters by display name, so a newly added upstream provider cannot become an Arc product agent by drift. Pi, OpenCode, Cursor, Grok, and Hermes keep their BB/plugin sources and persisted provider IDs untouched; only their later presentation gating is affected. ArcAgentId (`"omp"`) remains separate from the BB provider ID (`"acp-omp"`); no BB provider is renamed.

## ADR-035 Agent status separates runtime, provider, and account readiness; unknown is never reported as ready

Status: **Accepted** (implemented in Phase 6)
`ArcAgentStatus` models three independent axes: runtime (manifest + filesystem + compatibility), provider (injectable `ArcProviderStatusSource`), and account (placeholder in Phase 6). Provider health is not cleanly queryable from the desktop layer, so the default source reports `unknown` rather than fabricating readiness; account state is `unknown` because Phase 6 performs no credential inspection. Overall state is deterministic: `ready` requires account `connected`; a runnable runtime with unknown/not-connected account is honestly `runtime-ready`. Broken (manifest intent unfulfilled), unsupported (compatibility blocked), and untested (`ready-with-warning`) are distinct states — never collapsed to booleans, never auto-repaired from status inspection.

## ADR-036 Prepare and repair are explicit, idempotent, per-agent single-flight actions; repair is never an update

Status: **Accepted** (implemented in Phase 6)
Runtime changes happen only through explicit `prepareAgent`/`repairAgent` calls; status reads are side-effect-free (test-asserted). Actions inherit the lower-level guarantees: healthy runtimes are reused (`already-active`), same-pin damage is restored from the trusted seed/official flow, valid different-version runtimes are never downgraded or upgraded, and a broken different-version runtime is reported (`runtime-repair-failed`) rather than silently replaced. Repair never changes the active version and never touches credentials. Duplicate same-agent operations are single-flight (joined, not raced); different agents run concurrently.

## ADR-037 Runtime manifest mutations are serialized; concurrent agent operations cannot lose each other's updates

Status: **Accepted** (implemented in Phase 6)
Atomic tmp+rename protected the manifest from torn writes but not from lost updates: two services reading then writing disjoint runtime entries would drop one change. All manifest read-modify-write cycles (Codex/OMP bootstrap, Claude activation commit, digest backfill) route through `mutateArcRuntimeManifest`, an in-process serialized mutation chain per manifest path. The Claude commit re-validates manifest state inside the lock after its download so a concurrent activation is never clobbered. No-op decisions skip the write (no manifest is created by a no-op). Desktop v1 needs no distributed locking; the chain entry is retained per path for the process lifetime.

## ADR-038 The Arc account model is source-agnostic and credentials never cross into Arc

Status: **Accepted** (implemented in Phase 7)
Arc accounts are modeled in `apps/desktop/src/arc-account/` behind an `ArcAccountSource` interface: `AccountPoolSource` ships now and Phase 8 adds an OMP source without rewriting the service. ArcAccount carries metadata only (identity, email, plan label, auth state, availability); access/refresh tokens, OAuth codes, API keys, and credential JSON remain owned by the underlying system (Account Pool's own 0700/0600 atomic secret store). Nothing is copied into the runtime manifest, Mission Control KV, desktop-store, logs, or Arc userData, and a permanent test scans every serialized account and login challenge for credential material.

## ADR-039 Canonical account identity is provider-issued; email is never identity; unknown stays unknown

Status: **Accepted** (implemented in Phase 7)
`accountKey` is built only from provider-issued identifiers: `openai:chatgpt:<account_id>` for ChatGPT (from the JWT `https://api.openai.com/auth` claim) and `anthropic:account:<uuid>` for Claude (Anthropic account uuid). Email is display metadata only — never used for identity, dedup, or join. Accounts lacking a trustworthy canonical id keep `accountKey = null` and remain distinct; cross-source dedup (Phase 9) may key only on canonical accountKey, never on email, plan, or provider name. UNKNOWN plan is represented as `null`, never as "free".

## ADR-040 Account Pool backs Arc's ChatGPT and Claude account handling; it is imported server-only and default-enabled for Arc

Status: **Accepted** (implemented in Phase 7)
Arc reuses Account Pool's existing backend (device login, OAuth/PKCE, credential storage, multi-account, priority/reorder, usage refresh) instead of rebuilding authentication. The plugin source is imported server-only from pinned upstream commit `93344e0` with documented Arc modifications: no pool React UI (Arc builds its own Accounts UI in Phase 10 against the ArcAccount model; `@bb/shared-ui` does not exist in this fork), no `bb pool` CLI (requires plugin-sdk ≥0.4.102 CLI APIs absent from the fork's 0.4.99 SDK), and the CLI-coupled upstream server test suite is dropped with it. The enable gate on `BB_ACCOUNT_POOL_PARENT_URL` is removed: that variable configures optional parent-pool proxying, it is not an enable condition, and Arc Accounts require the pool as default-enabled builtin infrastructure. Account Pool remains infrastructure — it never appears in the ArcAgentManager catalog (still exactly OMP, Codex, Claude Code).

## ADR-041 Multi-account support is preserved and no quota-driven silent account rotation is added

Status: **Accepted** (implemented in Phase 7)
Arc assumes and preserves multiple accounts per provider family (ChatGPT Personal/Work, Claude Personal/Team). Enable/disable are distinct from remove (disabling never deletes credentials). Priority and ordering delegate to Account Pool's existing semantics (`account.setPriority`/`account.reorder`); Arc invents no routing algorithm. Quota states (held/exhausted) affect neither auth state (accounts stay `connected`) nor agent readiness, and Arc performs no automatic account switching to evade limits — routing behavior remains exactly the pool's explicit configuration.

## ADR-042 Login is initiated by Arc but authentication occurs on official provider surfaces

Status: **Accepted** (implemented in Phase 7)
Connect ChatGPT starts the pool's official OpenAI device flow (`verificationUri` + `userCode`, polled to completion, cancellable); Connect Claude starts the pool's official Anthropic OAuth/PKCE flow (browser opens the `authorizeUrl`; the paste callback completes the session — the pool does not expose its session TTL, so Arc reports `expiresAt: null` rather than inventing one). Arc never presents an email/password form, never captures provider passwords, and login challenges expose presentation data only. Duplicate starts are per-provider single-flight (joined, not raced), terminal poll/complete/cancel clears local pending state, and failed or expired sessions never block a retry.

## ADR-043 Agent account readiness is real for Codex and Claude Code; OMP stays account-unknown

Status: **Accepted** (implemented in Phase 7)
`ArcAgentManager` gains an injectable `ArcAgentAccountStatusSource`: ≥1 enabled, connected ChatGPT account makes Codex `connected`; ≥1 enabled, connected Claude account makes Claude Code `connected`; zero accounts is honestly `not-connected`; source failure is `unknown`. Pool accounts never make OMP connected — OMP remains `unknown` until Phase 8. Overall state gains `account-required` (runtime ready + definitively no account); expired/error/unknown accounts stay conservative `runtime-ready`, and provider health remains a separate axis (still honestly `unknown`). `connect-account` is advertised exactly when the runtime is ready and the account is not-connected/expired/error for Codex/Claude Code only.

## ADR-044 OMP providers never become Arc agents

Status: **Accepted** (implemented in Phase 8)
The Arc agent catalog stays closed at exactly OMP, Codex, Claude Code. OMP's 75 supported providers (Kimi, Gemini, DeepSeek, OpenRouter, Anthropic, ...) are OMP-internal provider/account dimensions surfaced through the single OMP agent (`availableThrough: ["omp"]` only). A permanent regression test pins the catalog; upstream provider drift cannot create Arc agents.

## ADR-045 Supported provider definitions and authenticated accounts are distinct

Status: **Accepted** (implemented in Phase 8)
`omp auth-broker list` is the static OAuth provider registry (75 entries in 18.2.6) and is never rendered as accounts; connected accounts come exclusively from observed stored credentials (broker `/v1/snapshot`). Arc's `ArcOmpProvider.connectionState` is derived from stored credentials only, and a permanent test proves registry entries with an empty credential store produce zero accounts. UNKNOWN != EMPTY.

## ADR-046 Arc uses OMP's official auth interfaces; OMP owns its provider credentials

Status: **Accepted** (implemented in Phase 8)
Arc drives `omp auth-broker login/logout/serve/token/list` and the broker's `/v1/snapshot` — never the SQLite store directly, never a reimplemented OAuth flow. Credentials live in OMP's `agent.db`; Arc's snapshot mapping reads an explicit metadata allowlist and discards everything else. API keys pass only through the OMP child's stdin on key-style logins. Arc models the exact 18.2.6 capability surface and invents nothing: no enable/disable, no priority/reorder, provider-wide logout only.

## ADR-047 The OMP account source is lazy and creates no permanent background process

Status: **Accepted** (implemented in Phase 8)
Inventory uses a loopback auth broker started lazily on the first account operation, bound to an ephemeral `127.0.0.1` port, and idle-stopped after 60 seconds. Account/status reads never launch `omp acp` and never leave an OMP process running; a permanent test proves idle shutdown kills the broker and that a cold read can start a fresh one. Snapshot reads are cached in-process for 5 seconds to keep status sweeps cheap.

## ADR-048 Broker bearer token and snapshot secrets stay backend-only

Status: **Accepted** (implemented in Phase 8)
The broker token is obtained via `omp auth-broker token` and used only in `Authorization` headers against the loopback address Arc bound itself; a broker-reported non-loopback address fails closed before the token is used. Snapshot access/refresh tokens and api keys never enter `ArcAccount`, logs, or any UI surface — a permanent test scans serialized accounts for planted secrets, and a non-loopback test proves no HTTP call happens when the bind check fails.

## ADR-049 OMP account records are available through OMP only; pool and OMP accounts are never merged

Status: **Accepted** (implemented in Phase 8)
OMP-owned accounts report `sourceKind: "omp"` and `availableThrough: ["omp"]` exclusively — never Codex or Claude Code availability. Pool and OMP records remain separate even with identical emails; only a trustworthy provider-issued canonical `accountKey` may later (Phase 9) correlate resources, and records without one stay distinct.

## ADR-050 Arc OMP operations run only against the Arc-managed runtime; standalone ~/.omp stays isolated

Status: **Accepted** (implemented in Phase 8)
Every OMP child resolves through the runtime manifest and the Phase 4 environment builder (`PI_CODING_AGENT_DIR` absolute under Arc userData, `PI_CONFIG_DIR` relative under the user home), so a global `omp` on PATH can never win and Arc operations never read or write the user's standalone `~/.omp`. A permanent resolver test pins the managed executable path and the private state root.

## ADR-051 OMP capability gaps are reported honestly, never papered over

Status: **Accepted** (implemented in Phase 8)
Where 18.2.6 has no equivalent of a pool capability, Arc reports a typed error instead of inventing semantics: enable/disable and priority/reorder throw `unsupported-provider`; per-account removal on a multi-account provider throws `disconnect-failed` rather than silently dropping the provider's other accounts. Auth method is reported as `oauth`/`api-key` only when evidenced (registry membership + stored credential type); OMP exposes no richer machine-readable auth-method field and Arc invents none.

## ADR-052 Usage is modeled as provider/account resources over a generic source contract

Status: **Accepted** (implemented in Phase 9)
Arc's "Usage & Limits" backend is `apps/desktop/src/arc-usage/`: one `ArcUsageService` over pluggable `ArcUsageSource`s (Account Pool, OMP, thread context) with a generic resource/window model. The Account Pool adapter consumes the already-bundled upstream `provider-usage.v1.listResources`/`getResource` contract over the existing HTTP RPC seam — the upstream generic pattern is adopted where it already exists locally instead of inventing a second protocol, and no pool code is rewritten. Provider plugins whose sources are absent from this fork (direct codex/claude-code) contribute nothing; their accounts are covered through the pool.

## ADR-053 UNKNOWN usage is never represented as zero; last-good data survives refresh failure as stale

Status: **Accepted** (implemented in Phase 9)
A provider without a usage endpoint reports `status: "unavailable"` + `unavailableReason: "not-exposed"` with empty windows — never 0%. Auth/install states are `not-connected`, fetch failures are `error`, and provider-side credential blocks are `disabled` (distinct from both). A failed refresh keeps the previous successful reading marked `stale: true`; nothing is erased and replaced with zeros. Percentages are derived only from true fractions (explicit fraction or used/limit with a real denominator); unbounded amounts (credits, dollars) stay amount-only. Reset timestamps pass through or stay null — never guessed.

## ADR-054 Context-window occupancy is a separate usage domain from provider quota

Status: **Accepted** (implemented in Phase 9)
Thread context usage (`usedTokens`/`modelContextWindow`, BB's own signal) is modeled as `sourceKind: "thread"` with its own resource, computed from a real denominator, and can never merge into provider/account quota resources. Provider quota informs the user; it never makes routing or model decisions — no automatic account rotation, no model switching (ADR-013/041 unchanged).

## ADR-055 Usage reads are observational and the OMP broker stays lazy

Status: **Accepted** (implemented in Phase 9)
Listing or refreshing usage never logs in, switches accounts, changes routing, enables/disables credentials, modifies the runtime manifest, or starts `omp acp`. OMP usage rides the Phase 8 lazy loopback broker (started on demand, idle-stopped after 60s; live-verified clean exit); the broker has no force-refresh parameter, so a refresh is an attempt bounded by OMP's five-minute server cache — stated, not hidden. Usage history and capacity aggregates are deliberately out of scope (plan §48).

## ADR-056 Cross-source usage association requires identical canonical identity and equivalent semantics

Status: **Accepted** (implemented in Phase 9)
Resources merge only on identical non-null canonical `accountKey` (issuer namespace + account id). Email is never identity; null accountKeys are always source-local. Because pool and OMP issue different namespaces (`openai:chatgpt:<id>` vs `omp:openai-codex:<id>`), pool↔OMP duplicates stay separate until a trustworthy mapping is proven — never assumed from email or provider name. Merged resources retain provenance (`sources`, per-window `source`, agentIds union); same-semantics window conflicts resolve to the newer `observedAt`, distinct semantics stay side by side; values are never averaged.

## ADR-057 Arc domains live in a shared package; the server hosts the Arc services through a fixed RPC contract

Status: **Accepted** (implemented in Phase 10)
`arc-runtime/arc-agent/arc-account/arc-usage` moved from the desktop package to `packages/arc-domains`, consumed by both the desktop and the bundled `arc-core` server plugin. All renderer access goes through a fixed 22-method `bb.rpc` contract with strict zod schemas (unknown fields rejected, secret-shaped values rejected by permanent tests). Arc mode is env-declared by the desktop shell; a standalone server reports `arc-unavailable` instead of fabricating state. No arbitrary command/path/env RPC exists.

## ADR-058 The normal agent picker exposes exactly the three Arc agents

Status: **Accepted** (implemented in Phase 10)
In Arc mode the server filters execution options to OMP, Codex, and Claude Code. Pi/OpenCode/Cursor/Grok/Hermes and other non-Arc providers are hidden from normal selection; historical threads remain readable because the filter applies to options, not thread rendering. BB provider IDs are unchanged and non-Arc plugin sources are not deleted — the Arc catalog is a product abstraction over the unchanged provider layer.

## ADR-059 Renderer-facing wire values must be JSON-clean; optional fields are omitted, never explicit-undefined

Status: **Accepted** (implemented in Phase 10)
Domain objects crossing the RPC boundary are validated as strict JSON: an absent optional field is omitted from the object, not present with value `undefined` (which the wire validator rejects and which `JSON.stringify` would drop silently). Agent action `reason` is the first application; the rule applies to all future contract fields.

## ADR-060 OMP child processes in the server are spawned only against the manifest-pinned managed runtime

Status: **Accepted** (implemented in Phase 10)
The `OmpSpawn` seam injected by `arc-core` is backed by `node:child_process` and is only ever invoked with the executable resolved from the Arc runtime manifest (`createArcOmpRuntimeResolver`). The spawn function is not reachable with caller-supplied paths, so it is not an arbitrary-command surface. Process lifecycle follows ADR-047: lazy start, 60-second idle stop, verified live.

## ADR-061 Per-thread account binding rides existing pool primitives via an explicit pin, never a new routing layer

Status: **Accepted** (implemented in Phase 10.2)
`threads.accountKey`/`threads.accountResolved` (nullable, additive migration) store the canonical `accountKey` a thread is bound to. Execution passes this key down through `agent-runtime`'s `ProviderExecutionContext` to the Account Pool hub as an explicit pin (`x-bb-account-pool-pin` header for Claude Code via `ANTHROPIC_CUSTOM_HEADERS`; a `${HUB_BASE_PATH}/pin/<accountId>` URL-path form for Codex, whose CLI has no custom-header passthrough). A pin bypasses priority/affinity selection entirely for that request but does not replace them — unpinned calls keep exactly today's behavior. A pinned account that is disabled or removed returns HTTP 409 with a distinct `x-bb-account-pool-pin-unavailable` reason; the hub never silently substitutes another account (no code path exists that would).

## ADR-062 Auto resolves once, is recorded via a bounded per-thread correlation route, and is never re-run

Status: **Accepted** (implemented in Phase 10.2)
A thread created with `accountKey: null` (Auto) is not pinned on its first execution — the pool's ordinary priority/affinity selection runs, and the hub correlates the outcome back to the thread via a thread-scoped marker (a header for Claude Code, a `${HUB_BASE_PATH}/auto/<threadId>` path segment for Codex, registered on demand and torn down on first consumption or a 5-minute timeout — bounded by concurrently-starting Auto threads, not by total threads ever created). The server reads the resolution once (`account.getResolved`, consume-on-read) and calls `setThreadAccount` exactly once, guarded by re-checking `getThreadAccountState` immediately before the write to avoid clobbering a concurrent explicit pick. After that, the thread is pinned like any explicit selection; Auto never re-runs for it.

## ADR-063 Account-scoped usage and the composer's account state derive from the thread row, not a global account context

Status: **Accepted** (implemented in Phase 10.2)
`ProviderUsageSection`/`ThreadContextWindowIndicator` take an explicit `accountKey` prop sourced from the thread, not from any ambient "current account." Absent a resolved account, they render "Active account unknown" — never a zero — per the existing `unknown != zero` rule (ADR-supported since Phase 6). `AccountPicker` similarly renders one of four states purely from `{accountKey, accountResolved, hasHistory}` plus the live `arc.accounts.list` result: Auto (new thread only), resolved-compact-with-explicit-confirm, legacy-unknown-blocks-send, or pinned-but-unavailable-blocks-send. The blocking behavior activates only when at least one connected, compatible account actually exists for the thread's agent — with zero connected accounts there is no real choice to gate on, so generic non-Arc threads are never blocked by a feature that isn't active for them.

## ADR-064 Restoring source for a bundled plugin missing from this fork must use the fork's actual divergence commit, never upstream's tip

Status: **Accepted** (Phase 10.2 process decision, applies to all future restorations)
This fork is missing numerous bundled-plugin source directories present upstream (`provider-codex`, `provider-claude-code`, `provider-acp`, `provider-pi`, `secrets`, `environment-modal-sandbox`, and roughly two dozen more) — never deliberately removed, simply never merged in. Restoring any of them from `upstream/main`'s tip risks pulling in commits made *after* this fork's actual divergence point, which can require newer shared-package APIs the fork doesn't have (observed directly: `upstream/main`'s `plugins/secrets` needs `plugin-sdk` exports — `PluginCliError`, `cliCommand`, `defineCli`, an interaction `presentation` field — that post-date `git merge-base HEAD upstream/main`). The fix is to restore from `git merge-base HEAD upstream/main` specifically, then verify: typecheck, full test suite, and that the plugin registers under its stable canonical id with no competing implementation (checked directly against `agent-runtime`'s `provider-registry.ts`, which is generic bridge-spawning plumbing with no hardcoded per-provider logic — restoring a plugin fills a real gap, it cannot create a duplicate). Every plugin restored this way in Phase 10.2 (`provider-codex`, `provider-claude-code`, `provider-acp`, `provider-pi`, `secrets`, `environment-modal-sandbox`) typechecks and tests clean at the merge-base commit; `secrets` specifically failed at upstream's tip for exactly the reason above. Restoring the remaining ~24 missing plugins to fully green `apps/server` was evaluated and deliberately deferred — most are unrelated to any Arc feature and the cost/scope was judged out of proportion to Phase 10.2.

## ADR-065 The Account Pooler hub's pin/select logic matches its own row id; `accountKey` must be translated at the boundary, never sent to the hub directly

Status: **Accepted** (implemented in Phase 10.2.1, fixes a real installed-app defect)
Phase 10.2 sent the thread's stable `accountKey` (`openai:chatgpt:<codexAccountId>` / `anthropic:account:<accountUuid>`) directly as the Account Pooler hub's pin value, but `hub.ts`'s `select()` matches pins against `Account.id` — the pool's own internally-generated row UUID, a completely different identifier space. This made every pin attempt fail with a 409 "removed" response, even for accounts that were genuinely connected (the exact bug reported against the installed app). The fix resolves `accountKey` to the *current* pool row id inside `plugins/account-pool/src/server.ts`'s `contributeFor`, right before it reaches the hub (`resolvePoolAccountId`, matching on `codexAccountId`/`accountUuid`), for both Codex (URL path) and Claude Code (`ANTHROPIC_CUSTOM_HEADERS`, moved here from `agent-runtime` which has no access to the live account list and could not have performed this translation). When resolution fails — the account was genuinely disconnected — the original `accountKey` is passed through unresolved, which deterministically fails the hub's existing "removed" check; there is no fallback path. `threads.accountKey` itself is never changed to a pool row id, because a reconnect that creates a fresh pool row for the same real account must not orphan the thread's selection — resolution happens fresh on every execution, not once at persistence time.

## ADR-066 The composer's account UI is a self-contained dropdown, not a generic option-picker wrapper, so it can show contextual explanation and a footer link in one popover

Status: **Accepted** (implemented in Phase 10.2.1)
The installed app rendered the internal Auto sentinel (`__auto__`) as visible text, and legacy/unavailable thread states as permanent full-width warning banners, because `AccountPicker` delegated its trigger/menu to the generic `OptionPicker` and passed it a `value` that had no corresponding option in non-new-thread states (`OptionPicker` falls back to rendering the raw value string when nothing matches). `AccountPicker` is now built directly on `DropdownMenu`/`DropdownMenuContent` (the same shared, responsive-drawer-backed primitives `OptionPicker` itself uses) so it fully controls its own trigger label — always a real word ("Auto", an account's label, "Select account", "Account unavailable") — and its popover content, which now carries the legacy/unavailable explanation as normal popover text and "Manage accounts…" as an ordinary trailing menu item, rather than a floating banner or a separately-placed button. Confirming an account switch on an already-resolved thread stages the pending choice and keeps the *same* popover open with a Confirm/Cancel step, instead of closing it and showing separate inline UI. For OMP, the account list now filters by `providerFamily` derived from the selected model's existing `routeProviderId` (previously never wired to `AccountPicker`, so all OMP accounts across every underlying provider showed together regardless of which provider's model was selected).

## ADR-067 Codex account pinning must ride a custom HTTP header via `env_http_headers`, never an extra `CODEX_OPENAI_BASE_URL` path segment

Status: **Accepted** (implemented in Phase 10.2.2, supersedes the path-based mechanism from ADR-061/065)
Phase 10.2.1's fix (resolving `accountKey` to the pool's own row id) was correct, and was confirmed present and correct in the packaged app's bundled `account-pool` plugin. But the real installed app, tested against two genuinely connected ChatGPT accounts, still failed every send with a 404 carrying a `cf-ray` header — proof the request never reached the local Account Pooler hub at all, despite `curl` against the exact same URL locally succeeding (401, correctly reaching the hub's auth check). Root cause: appending `/pin/<id>` or `/auto/<threadId>` to `CODEX_OPENAI_BASE_URL` gave Codex's real CLI a base URL one path segment deeper than the flat `.../http/v1` shape Account Pooler had always used before per-thread selection existed; the real Codex binary's request handling does not tolerate that shape and effectively fails to route through it, even though our own server had no trouble matching the deeper route (proven both by direct `curl` and by the existing test harness, which faithfully reproduced the (wrong) passing behavior because it dispatches by exact in-memory path match and has no way to exercise the real Codex CLI's own request handling — the gap the previous phase's tests could not have caught, and did not claim to).

The real Codex CLI already proves it supports carrying arbitrary custom headers on its outbound requests: its `-c model_providers.<id>.env_http_headers.<header>=<ENV_VAR_NAME>` config, already used and working for `CODEX_POOL_AUTH_TOKEN`, exists precisely for this. `plugins/provider-codex/src/bridge/bridge.ts`'s `resolveAppServerLaunch` now adds a second `env_http_headers` entry — `x-bb-account-pool-pin` from `CODEX_ACCOUNT_POOL_PIN`, or `x-bb-account-pool-thread-id` from `CODEX_ACCOUNT_POOL_THREAD_ID` — using the exact same header names the hub already reads for Claude Code (`plugins/account-pool/src/hub.ts`'s `PINNED_ACCOUNT_HEADER`/`THREAD_CORRELATION_HEADER`, read generically from `request.headers`, independent of how the request reached the router). `CODEX_OPENAI_BASE_URL` is now unconditionally the flat `.../http/v1` it always was; the account-pool plugin no longer registers any dynamic per-account or per-thread HTTP route for Codex, and the `ensureCodexPinRoutesRegistered`/`ensureCodexAutoRouteRegistered` machinery (along with its 5-minute route-cleanup timer) was deleted outright — headers carry no server-side registration state to leak or clean up, which is strictly simpler than the mechanism it replaces, not just a workaround.

Verified against the real installed app with both real connected ChatGPT accounts (Plus and Team): individual sends, concurrent sends on separate threads, and continued correct execution after a full app restart all returned the exact model output requested, with zero cross-account leakage and zero silent fallback on the one intentionally-stale-key case tested.

## ADR-068 OMP per-thread account selection pins one stored credential through oh-my-pi's own auth-broker account pool

Status: **Accepted** (implemented in Phase 10.2.3; mechanism live-verified with one real Kimi account — two-account isolation NOT AVAILABLE)

Arc's Account Pooler pattern does not extend to OMP: the pool is a *proxy* (it rewrites the provider's base URL and credentials and picks the account server-side), while OMP runs its own agent binary against its own credential store. What OMP does offer, verified in oh-my-pi v18.2.6 source (`packages/ai/src/auth-broker/remote-store.ts`, `discover.ts`), is a **client-side credential allowlist**: `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` names a JSON object `{ "<omp provider id>": ["<credential identityKey>"] }`; a provider absent from the file stays unrestricted, an empty array excludes that provider's OAuth credentials, and API-key credentials are never filtered. The filter only applies in broker mode, so the pinned process must also be pointed at Arc's loopback broker (`OMP_AUTH_BROKER_URL`/`OMP_AUTH_BROKER_TOKEN`), and an unreachable broker fails OMP startup loudly rather than falling back to the local store.

`arc-core` therefore registers `bb.providers.experimental_contributeEnv("acp-omp", …)`: the thread's `accountKey` (`omp:<provider>:<accountId>`) is resolved against Arc's own OMP account list to that credential's `identityKey`, and the contribution returns the broker URL, token, and a content-addressed pool file written 0600 under Arc's private `<userData>/omp/account-pool`. An **Auto** thread (no `accountKey`) contributes nothing, so OMP keeps its own selection; a pin that no longer resolves excludes its whole provider, and a pin that is not an OMP account excludes every stored provider — OMP then reports the provider as unauthenticated instead of Arc silently running a different account. The failure modes are therefore closed in the same direction as the pool's own "removed" 409.

`ArcAccount.identityKey` carries OMP's credential identity (null for pool accounts and for OMP api-key credentials, which OMP's filter never matches). The broker is held open by a deadline (`holdBrokerForExecution`, renewed by later resolutions and by the provider-health read) because the provider process outlives the env resolution that created it; past the deadline the broker returns to its normal idle shutdown rather than living forever.

Live evidence (single account, real binary, real stored Kimi credential): with `{"kimi-code": ["account:d9l3vugu8ld95qngp75g"]}` the real binary still resolves the Kimi credential; with `{"kimi-code": []}` it disappears from `omp usage --json` while the unrelated api-key provider stays; with an unrelated provider listed, nothing is filtered. Two-account isolation and concurrent Kimi A/B threads remain unverified for lack of a second Kimi account.

## ADR-069 Per-thread account selection ships on the composer and the SDK; the CLI has no account flag yet

Status: **Accepted, deviation recorded** (Phase 10.2/10.2.3)

The repository rule is that every end-user feature is usable through the SDK and `bb` CLI as well as the UI. Account selection satisfies the SDK half — `threads.spawn`/`threads.update` carry `accountKey`, and the server route schema validates it — and the composer drives exactly those calls. The CLI does not expose it: `bb thread spawn`/`update` have no `--account` flag, so a CLI-created thread starts on Auto. This is a deliberate deferral, not an oversight: the CLI spawn path also needs an account *listing* surface to be useful (`bb account list`), and that belongs with the account-management surface rather than bolted onto the spawn flag set. Until then, scripted runs pin accounts through the SDK. Anyone adding `--account` must add the listing command in the same change, and the discoverable-surface docs listed in `docs/cli-guide-and-skill.md`.

## ADR-070 Arc names its managed runtime executables explicitly; PATH never decides which binary executes

Status: **Accepted** (pre-Phase-11 hardening)

Arc manages three runtimes, and until now only Claude Code had an explicit hand-off: the desktop built `<userData>/arc-runtimes`, prepended those directories to the child `PATH`, and the providers resolved `codex`/`claude`/`omp` by name. On a machine where the user also has these tools installed, PATH order decided execution — measured on this Mac: the Codex provider ran `~/.codex/packages/standalone/releases/0.154.0-*/bin/codex` while the manifest activated 0.155.1, and the OMP provider ran `~/.local/bin/omp-real` (a user shim) while the manifest activated `arc-runtimes/runtimes/omp/18.2.6/omp`. The provider environment's PATH had the user's shell directories ahead of Arc's, so "Arc manages its own runtimes" was not true for the executables that actually ran.

Decision: Arc publishes the resolved managed executable for every active runtime and each provider consumes it explicitly — `BB_CODEX_BRIDGE_APP_SERVER_COMMAND` (Codex bridge, existing variable), `BB_CLAUDE_CODE_EXECUTABLE` (existing), and `BB_OMP_EXECUTABLE` (new; the ACP provider rewrites the shipped `acp-omp` launch command from it). PATH stays as the resolution mechanism for *children* of an agent, never for the agent executable itself.

The contract is fail-closed in Arc mode: when `BB_ARC_RUNTIME_ROOT` is present (the desktop started this server) and the executable variable is missing or not executable, the provider refuses to launch and says the managed runtime is unavailable and must be repaired in Arc's agents view. Falling back to PATH there would silently run a binary Arc does not control, which is the exact failure this decision removes. Standalone bb (no Arc declaration) keeps PATH discovery, and external installations remain *informational*: `discoverClaudeInstall` still classifies them for diagnostics, and the ACP agent roster still probes for them, but nothing executes them inside Arc.

The Codex bridge also gained one semantic clarification while implementing this: `BB_CODEX_BRIDGE_APP_SERVER_ARGS` defaults to `["app-server"]` when unset, so overriding the *executable* no longer silently drops the subcommand. That defect was observed live: the first hardened build launched the managed Codex with no argv and it exited with "stdin is not a terminal".

## ADR-071 Arc owns its OMP broker process: recorded ownership, disposal on shutdown, verified reaping of leftovers

Status: **Accepted** (pre-Phase-11 hardening)

The OMP auth broker is a loopback child of the bb server, and its only terminator (`OmpAccountSource.shutdown()`) had no production caller. The in-process idle timer was therefore the whole lifecycle: any exit that beat the 60 s idle window — normal quit, plugin reload, crash, force-kill — left the broker reparented to PID 1. Two such leftovers were found running on this machine from an earlier app instance, still holding their (dead) tokens.

Decision: ownership is explicit and verifiable.

- `arc-core` registers `bb.onDispose` and disposes the OMP source (broker plus any interactive login child). An open login is deliberately *not* killed by idle shutdown, because an interactive login can outlive the idle window.
- `OmpAccountSource` stops the broker gracefully — SIGTERM, bounded wait (5 s), SIGKILL only if the process ignores it — instead of fire-and-forget SIGTERM.
- While a broker is alive, `<userData>/omp/broker-ownership.json` (0600) records the pid, the managed executable path, the start time and the owning server instance id. The record is cleared on shutdown, and any runtime repair/prepare resets the broker so a replaced binary is not served by the old process.
- At startup, arc-core reaps a recorded broker from a *previous* instance only when all three checks pass: the pid is alive, its `ps` command line contains the recorded executable path *and* the `auth-broker` marker, and the process start time agrees with the record within 60 s. Anything else is left running and reported as "could not be proven to belong to Arc". A process with no record (the two legacy leftovers) is never touched, and the record can never target the current instance because it carries the instance id.

## ADR-072 Local data is owner-only, enforced at startup

Status: **Accepted** (pre-Phase-11 hardening)

`~/.bb` was 0755 and `~/.bb/bb.db` 0644 on this machine, and that database holds thread history together with the provider environment values of every turn (see ADR-073). Any local account could read it.

Decision: `hardenLocalDataPermissions` runs from `initDb` before and after the database is opened, and restricts only Arc-owned paths: the data directory to 0700 and `bb.db` plus its `-wal`/`-shm` sidecars to 0600. It never walks arbitrary user files, tolerates missing targets, is idempotent, and reports failures through the server logger by target label and errno only — never by echoing file contents. A repair the process cannot perform is reported, not fatal.

## ADR-073 Credential-shaped environment values are withheld from the diagnostic view, never from the child

Status: **Accepted** (pre-Phase-11 hardening)

`provider.env-resolved` records the environment a turn resolved, and it was persisted verbatim: 20 raw values across 11 rows in this machine's database, covering `ANTHROPIC_AUTH_TOKEN`, `BB_ACCOUNT_POOL_PARENT_TOKEN`, `CODEX_POOL_AUTH_TOKEN` and `OMP_AUTH_BROKER_TOKEN`. The event is the diagnostic artifact; the child process environment is separate, so redaction belongs only on the event side.

Decision: one policy, one place. `isSensitiveEnvName`/`redactEnvValue` live in `@bb/domain` and mark a value `{masked: true}` when the name carries a credential word (`TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL(S)`, `API_KEY`, `KEY`) or is `AUTHORIZATION`/`COOKIE`/`*_AUTH`. Word-boundary matching keeps useful diagnostics intact: `OMP_AUTH_BROKER_URL`, `CODEX_ACCOUNT_POOL_PIN`, `ANTHROPIC_BASE_URL` and `PATH` stay readable. `resolveThreadEnvironment` applies it to the entries it emits while leaving `envVars` — what the provider process actually receives — untouched, which a test asserts in both directions.

Historical rows are handled by an explicit, opt-in tool: `bb-script-redact-stored-env-secrets` is dry-run by default, rewrites only `entries[].value` for credential-shaped names, preserves event identity, names, sources and ordering, prints counts rather than values, and requires `--apply`. It is not run automatically.

## ADR-074 Codex shell-snapshot exposure of the Account Pool hub token is closed at the config layer for exec visibility and at the filesystem layer for the persisted snapshot; token lifetime is bounded by the existing manual rotation, not a new ephemeral-token subsystem

Status: **Accepted** (Phase 11 Part 0)

Every real Codex turn writes `CODEX_POOL_AUTH_TOKEN` — the long-lived Account Pool hub token — into Codex's own process environment, because Codex's `env_http_headers.<header>=<ENV_VAR_NAME>` mechanism (used since ADR-067) reads the named variable from its own process env at request time; there is no way to hand Codex that header value without the variable existing in its environment. Codex separately maintains a persistent "shell snapshot" (`$CODEX_HOME/shell_snapshots/<session>.<nonce>.sh`, default `~/.codex/shell_snapshots`) that replays a captured interactive shell for speed across tool calls. Verified against the real pinned 0.155.1 binary and the upstream `openai/codex` source at tag `rust-v0.155.1`: this raw capture is a *different* code path from the one governed by the documented `shell_environment_policy` config (inherit/exclude/include_only) — the policy is threaded only into a credential-broker-mediated snapshot mode gated on `sandbox.is_some()` and an active `codex_network_proxy` credential broker (an unrelated, deeper subsystem for MCP/network-proxy credentials), which Arc's Account Pool integration does not use and should not adopt just to solve this. Live end-to-end reproduction (a canary token, a real spawned `codex exec`, a temp `CODEX_HOME`) confirmed the policy has zero effect on what the raw capture writes; the plan's original assumption that Option C alone would close the file-based leak was wrong.

The same reproduction also confirmed `shell_environment_policy.exclude` **does** work for a real, separate exposure: without it, any shell/exec command the model runs inherits `CODEX_POOL_AUTH_TOKEN` in its own subprocess environment and could read or echo it (`codex sandbox ... env` showed the token; with the exclude it did not). This is real and worth keeping even though it does not touch the snapshot file.

Decision, two layers:

1. `plugins/provider-codex/src/bridge/bridge.ts`'s `resolveAppServerLaunch` adds one more `-c` override alongside the existing account-pool `env_http_headers` overrides: `shell_environment_policy.exclude=["CODEX_POOL_AUTH_TOKEN"]`, applied in the exact branch where the token is actually present. This closes the model-shell-visibility exposure using Codex's own documented mechanism, with no new argv-carried secret (the value itself is never passed as a CLI argument, only the variable *name*, matching the existing `env_http_headers` pattern's own safety property).
2. `plugins/provider-codex/src/shell-snapshot-hardening.ts` (`hardenCodexShellSnapshotDir`, called once from the plugin's `server.ts` entrypoint) applies the plan's own documented "minimum fallback" for what the config layer cannot reach: creates/tightens `$CODEX_HOME/shell_snapshots` to 0700 and sweeps existing files inside to 0600, following the exact `hardenLocalDataPermissions` (ADR-072) pattern — best-effort, never fatal to Codex launch, never touches files outside that one directory. Verified against the real binary that Codex does not loosen a pre-hardened 0700 directory when it writes a new snapshot into it (a fresh run left the directory at 0700 with the new file still 0644 underneath) — so the directory's own permission, not the per-file mode, is the load-bearing protection: on a standard POSIX filesystem a 0700 directory blocks every other local account from resolving a path into it at all, regardless of what mode the file inside carries. The one-time startup sweep therefore only needs to catch pre-existing loose files; it does not need to re-run per turn, and does not claim every file is 0600 at every instant — that residual (a session's new snapshot files stay 0644 until the next hardening pass, but are unreachable to other accounts through the 0700 directory the whole time) is the documented limitation, not a silent gap.

Token lifetime: `plugins/account-pool/src/store.ts`'s `rotate`/`operations.ts`'s `rotateToken` already exist (manually invoked, with a grace-period overlap via `previous`) and were used during the incident this ADR follows up on. Building a new ephemeral, per-Codex-process token system (the plan's Option B) was evaluated and deliberately deferred: it is a materially larger change to the hub's trust model (minting, a growing validity set, revocation tied to process lifecycle) for a residual whose blast radius the two changes above already bound to "the current token value, readable only by the local account, until the next manual rotation" — disproportionate to build unprompted per the plan's own "do not build an overcomplicated security subsystem just for this" guidance. Automating `rotateToken` on a schedule is a smaller, real option for shrinking that residual further and is left as an open question rather than built silently.

## ADR-075 `codex-code-mode-host` is an official, separately-released, version-locked companion binary that Arc does not install; the startup warning is closed by disabling the always-on host probe, not by shipping an unused ~22 MB binary

Status: **Accepted** (Phase 11 Part 1)

The installed app showed `Code Mode is unavailable because failed to spawn code-mode host .../codex-code-mode-host: host executable was not found` on every new Codex thread. Verified against `openai/codex` at the pinned tag `rust-v0.155.1`:

- `codex-code-mode-host` is a genuine first-party Cargo workspace member (`codex-rs/code-mode-host`), built and released from the same commit/tag as `codex` itself — always version-locked 1:1 to the Codex release, never independently versioned. It ships as its own per-platform GitHub release asset (`codex-code-mode-host-aarch64-apple-darwin.tar.gz`, darwin-arm64 available, GitHub-computed digest `sha256:e8957108…b508a`, same integrity-metadata shape ADR-020/025 already consume) — a separate asset from the plain `codex-aarch64-apple-darwin.tar.gz` single-executable archive Arc downloads today, which is why Arc's managed Codex never had it.
- Two distinct feature flags govern it (`codex-rs/features/src/lib.rs`): `code_mode` (the actual code-execution tool the model would call) is `Stage::UnderDevelopment`, `default_enabled: false` — Arc has never turned this on. `code_mode_host` (the companion-process *infrastructure*) is `Stage::Stable`, `default_enabled: true` — independently of whether `code_mode` itself is used, Codex always probes for the host binary and reports availability once per new Codex thread (an `AtomicBool`-guarded, take-once warning — not a real per-turn spawn loop, contrary to what "repeated" in the plan implied; still worth closing because the message ("host executable was not found") reads as a defect).
- Confirmed empirically against the real pinned binary (`codex exec` against an isolated `CODEX_HOME`, unreachable pool URL so no real network egress) that Codex's own `-c`/`--disable` mechanism (already used for the account-pool overrides, ADR-067) applies uniformly to `app-server` too: `-c features.code_mode_host=false` changes the one-time notice from the alarming "failed to spawn ... host executable was not found" to the honest "Code Mode is unavailable because code-mode host is disabled" — and stops Codex from attempting to spawn anything at all. A residual single informational line still appears once per thread (Codex's own code always calls `take_unavailable_warning` from the tool-registration path regardless of why the feature is off); no supported mechanism to suppress that specific advisory line entirely was found, and none was invented.

Decision: since `code_mode` (the feature that would actually consume the host) is off both upstream and in Arc, installing, verifying, staging and version-pinning a ~22 MB companion binary purely to silence a warning about infrastructure nothing uses would be disproportionate (plan's own "do not build an overcomplicated subsystem" standard). `plugins/provider-codex/src/bridge/bridge.ts`'s `resolveAppServerLaunch` now unconditionally appends `-c features.code_mode_host=false` to every Codex launch (not just pool-routed ones — this is unrelated to account-pool routing). This is the literal "feature disabled → Codex must not repeatedly attempt to spawn it" outcome the plan asked for. `arc.agents.prepare`/`repair`/health need no change: they already report the runtime healthy on the main binary alone, and that remains correct because the companion is not required by any feature Arc enables.

If Arc later decides to ship Code Mode as a real product feature, the acquisition path is already proven end to end by ADR-020/021/025 and needs no new mechanism — pin `codex-code-mode-host-aarch64-apple-darwin.tar.gz` from the same release tag as the active Codex version (never a different tag — the plan's "install/activate/rollback the entire Codex version directory as one unit" requirement, deferred to Part 2, applies directly here), stage it beside `codex` in the runtime directory, drop the `-c features.code_mode_host=false` override, and extend health to require the companion whenever `code_mode`/`code_mode_host` is enabled. That work is explicitly out of scope until Arc makes that product decision.

## ADR-076 The runtime manifest gains a `knownGoodVersion` field, migrated forward from every real v1 manifest instead of discarding it

Status: **Accepted** (Phase 11 Part 2)

The plan's update engine needs three distinct concepts per runtime — installed, active, known-good — and the existing manifest (ADR-016, schema v1) only had `activeVersion`/`previousVersion`. `activeVersion` alone cannot represent "this candidate is running but has not yet proven itself": collapsing that into `activeVersion` would mean either delaying activation until after a real provider turn succeeds (contradicting atomic activation, ADR-011 below) or treating every activation as instantly trustworthy (contradicting the plan's explicit "candidate does not become known-good simply because download succeeded").

Decision: `packages/arc-domains/src/arc-runtime/manifest.ts` bumps `ARC_RUNTIME_MANIFEST_SCHEMA_VERSION` to 2 and adds `knownGoodVersion: string | null` per runtime entry. Critically, `readArcRuntimeManifest` does not simply reject a v1 file the way it already correctly rejects a *future* schema version (ADR-019) — a v1 file is a real prior release's manifest, not corrupt data, and discarding it would silently forget every already-verified, already-active runtime and force a redundant reinstall on every user's next launch. A parallel `arcRuntimeManifestSchemaV1` schema is kept for exactly this migration path: a file that fails the current schema is retried against v1, and on success is upgraded in memory (`knownGoodVersion` defaults to that entry's `activeVersion`, since every v1 activation was implicitly trusted with no promotion step). The migrated shape is returned as an ordinary `"ok"` read result; it is not written back until the next real mutation, at which point it naturally persists as v2 through the existing atomic tmp+rename path. Tested directly: a hand-written v1 JSON fixture (codex active, omp active, claude-code never installed) migrates with every field preserved and `knownGoodVersion` correctly defaulted per entry.

## ADR-077 The update engine is layered entirely on top of the Phase 1–6 runtime primitives; no parallel runtime manager was created

Status: **Accepted** (Phase 11 Part 2)

Architecture map, written before any code per the plan's own instruction:

```
manifest (schema v2: activeVersion, previousVersion, knownGoodVersion, source, digest, installedAt)
  → ArcRuntimePaths.executablePath(id, version) resolves the managed binary
  → environment.ts injects BB_CODEX_BRIDGE_APP_SERVER_COMMAND / BB_CLAUDE_CODE_EXECUTABLE / BB_OMP_EXECUTABLE
  → provider bridges launch exactly that executable (ADR-070, unchanged)

trusted release (releases.ts: one pinned ArcRuntimeRelease per runtime, origin/asset-shape validated)
  → NEW: update-discovery.ts asks the same trusted origin for the latest release (GitHub Releases API for
    codex/omp, downloads.claude.ai's own /latest + manifest.json for claude-code — the exact mechanism
    Anthropic's own install.sh uses), validates the result through validateArcRuntimeRelease before trusting
    it for anything, side-effect-free
  → NEW: update-download.ts downloads + reuses acquire.ts's existing stageReleaseExecutable (unchanged) to
    verify checksum/version in a scratch staging directory — this is the same staging primitive Phase 3/5
    already proved, now callable for ANY release, not just the build-time pin
  → NEW: health.ts runs a minimal, offline, no-account probe per runtime (codex: version + `doctor`;
    claude-code: version + `doctor`; omp: version + a real ACP `initialize` handshake, mirroring Phase 4's own
    live proof) before AND after activation
  → NEW: activation.ts's activateArcRuntimeVersion is exactly the atomic manifest write ADR-016/037 already
    established, parameterized for any staged version, never deleting the superseded version's directory
  → NEW: activation.ts's promoteArcRuntimeKnownGood / rollbackArcRuntimeVersion are the two new manifest
    operations the plan requires; rollback reactivates knownGoodVersion (never previousVersion directly) and
    never redownloads
  → NEW: update.ts's updateArcRuntime chains all of the above: discover → stage → pre-activation health →
    activate → post-activation health → promote-or-automatic-rollback

ArcAgentManager (arc-agent/manager.ts, unchanged class, extended)
  → the existing per-agent single-flight lock (runExclusive) now also guards checkForUpdate/updateAgent/
    rollbackAgent — Codex and OMP updates already ran concurrently under this lock before Part 2; nothing new
    was built for cross-runtime concurrency
  → resolveActions' "update"/"rollback" entries (previously hardcoded available:false, "arrives in a later
    Arc release") now reflect real local state: update whenever the runtime is prepared, rollback exactly
    when knownGoodVersion differs from the active version — both computed from data already in ArcAgentStatus,
    no network call on an ordinary status read

arc-core plugin (unchanged files extended, not replaced)
  → contract.ts gains arc.agents.checkForUpdate/update/rollback and their strict output schemas
  → server.ts wires them to the same requireHost().agents.* methods every other agent action already uses,
    with an explicit narrow-mapping (toArcRuntimeUpdateDiscoverySummary) so only display-safe release fields
    (version/platform/releaseTag/assetName/downloadUrl/sha256/license) ever cross the RPC boundary — never
    runtimeId/artifactKind/expectedExecutableVersion/executableSha256, and never anything the renderer could
    feed back to control a future download
```

No new manifest file, no new lock, no new RPC transport, no new manager class. Every new module lives in `packages/arc-domains/src/arc-runtime/` beside the code it extends, and the only structural change to an *existing* file's behavior is the manifest schema migration (ADR-076) and `resolveActions`/`resolveRuntimeStatus` learning about `knownGoodVersion`.

## ADR-078 Update discovery reuses each runtime's already-established trusted origin; every discovered release is re-validated through the same gate a build-time pin goes through

Status: **Accepted** (Phase 11 Part 2)

`discoverArcRuntimeUpdate` (`update-discovery.ts`) is side-effect-free: it never downloads, stages, or writes. For Codex and OMP it calls `GET api.github.com/repos/<owner>/<repo>/releases/latest` (the same GitHub repos already recorded in `releases.ts`'s `TRUSTED_RELEASE_ORIGINS`) and reads the asset's own `digest` field (`sha256:…`) — no separate checksum infrastructure invented; this is the identical GitHub-computed digest ADR-020/025 already consume. For Claude Code it calls `downloads.claude.ai/claude-code-releases/latest` (a plain-text version string) then that version's `manifest.json` for the per-platform checksum — verified by reading `claude.ai/install.sh` directly: this is exactly Anthropic's own official installer's discovery mechanism (`DOWNLOAD_BASE_URL/latest` → `DOWNLOAD_BASE_URL/$version/manifest.json`), not a new endpoint Arc invented. macOS code-signature verification (ADR-030) remains the cryptographic trust gate regardless of where the checksum came from.

Whatever a discovery call returns is constructed into an ordinary `ArcRuntimeRelease` and passed through the exact same `validateArcRuntimeRelease` every pinned release already goes through (origin host/path-prefix, no `latest` aliases, https-only, exact asset-name suffix). A discovery response that tried to point anywhere else — a compromised API response, a misconfigured test seam, a bug — fails validation and is reported as `discoveryError`, never silently trusted. Tested directly (`arc-runtime-update-discovery.test.ts`): a discovered release with a doctored `downloadUrl` is rejected with `latestTrusted: null` and a `discoveryError` naming trust validation as the cause.

Live-verified against the real trusted sources (read-only, non-destructive, 2026-09-20): Codex's and OMP's `releases/latest` both currently match Arc's existing pins exactly (0.155.1, 18.2.6) — no real update exists yet for either, matching the plan's 2.30 instruction not to force one. Claude Code's `/latest` returned `2.1.278`, newer than Arc's pinned `2.1.276` — a real update exists, and the discovery mechanism found it correctly end to end (version string + manifest.json checksum both fetched and shaped exactly as `discoverClaudeLatestRelease` expects). No production Claude update was performed; that stays deliberately deferred to the installed-app verification pass (plan 2.31), which Part 2's backend work does not include.

## ADR-079 Known-good promotion is a distinct step after a post-activation health probe, not "activation succeeded" or "a real user turn happened"

Status: **Accepted** (Phase 11 Part 2)

The plan's fullest version of promotion criteria is "successful managed provider startup" — ideally a real user turn. Wiring that signal end to end would mean threading a "this runtime just completed a real turn" event from the provider bridges (provider-codex/provider-claude-code/provider-acp), through the agent-runtime execution layer, back into `ArcAgentManager` — a materially larger, cross-package change than Part 2's engine work, and one that touches code outside `arc-domains`/`arc-core` that has its own extensive existing behavior (ADR-061 through ADR-069) this phase must not regress.

Decision: `updateArcRuntime`'s promotion criterion is a local, offline, no-account health probe run immediately after activation (the same `probeArcRuntimeHealth` used pre-activation, but now against the live, activated executable path) — version match plus `doctor` (Codex/Claude) or a real ACP `initialize` handshake (OMP). This is a real, meaningful check (it proves the activated binary starts and answers its own protocol), just not the plan's most ambitious version (an actual completed coding turn). The gap is deliberate and documented here, not silently narrower than advertised: a runtime could in principle pass this probe and still fail on a real turn for reasons the probe cannot see (a genuine account/provider-level issue, which ADR-080 explicitly keeps separate from this signal on purpose). Wiring true turn-level promotion is left as explicit future work if Part 2's probe-based promotion proves insufficient in practice.

## ADR-080 Automatic rollback fires only on a local health-probe failure; account, quota, network, and provider-service failures never trigger it

Status: **Accepted** (Phase 11 Part 2)

The plan draws a hard line (2.10, 2.15): a runtime failure (missing executable, wrong architecture, immediate crash, app-server that will not start) should roll back automatically; an account/service failure (quota exhausted, OAuth expired, network outage, model unavailable) must not. `updateArcRuntime`'s only trigger for `rollbackArcRuntimeVersion` is `probeArcRuntimeHealth` reporting `unhealthy` on the newly-activated binary — a local process spawn/version-probe/doctor/ACP-handshake check that makes no account-scoped request and reaches no paid model endpoint (verified directly: the Codex/Claude checks are `--version` and `doctor`, both documented as pre-auth/read-only in Phase 5's own live evidence; the OMP check is a bare ACP `initialize` over stdio with no credentials involved, matching Phase 4's own proof that "runtime ready" is independent of "account ready"). Nothing in the update engine inspects account state, quota headers, or HTTP status codes from a provider API — those signals live entirely in the account/usage domains (`arc-account`, `arc-usage`) and are structurally unreachable from `update.ts`, so a quota exhaustion or an expired OAuth token cannot reach this code path at all, let alone trigger a rollback.

## ADR-081 Codex's own update-check and Code Mode host probe are both disabled on every Arc-managed launch; this is defense-in-depth for "Arc owns runtime version changes," not new functionality

Status: **Accepted** (Phase 11 Part 2, extends ADR-075)

Beyond the Code Mode host disable (ADR-075), Codex's `ConfigToml` carries a real `check_for_update_on_startup` key backing its own `codex update` self-update path. Confirmed against the real pinned binary that this key is accepted (`-c check_for_update_on_startup=false` parses cleanly, matching the same `-c`/`--disable` validation already proven for `code_mode_host` in ADR-075) and is unconditionally appended to `resolveAppServerLaunch`'s base args alongside the Code Mode disable — one line, same mechanism, same reasoning: Arc, not Codex itself, decides when Codex's version changes (plan 2.19), and disabling a startup check that Arc's headless `app-server` integration has no use for either way costs nothing. Claude Code already carries the equivalent protection from Phase 5 (`DISABLE_AUTOUPDATER=1`/`DISABLE_UPDATES=1`, ADR-032, doctor-confirmed live). OMP was not found to expose any self-update mechanism in the 18.2.6 CLI surface already inventoried in Phase 4/8; none was invented. All three runtimes are now covered: Codex and Claude by an explicit disable, OMP by the absence of any self-update path to disable.

## ADR-082 Retention stays conservative: side-by-side installation never overwrites, nothing beyond the active and known-good versions is ever deleted automatically

Status: **Accepted** (Phase 11 Part 2)

Matches the plan's own explicit instruction (2.27) not to build aggressive cleanup yet. `activateArcRuntimeVersion` never removes the directory a version it supersedes lives in (tested directly: after activating 0.156.0 over an active 0.155.1, the 0.155.1 version directory is untouched and its executable remains chmod-accessible). `rollbackArcRuntimeVersion` never deletes the version it rolls back *from* either — a version directory is removed only by the plan's own future retention-policy phase, never as a side effect of activation, promotion, or rollback. `cleanAbandonedArcRuntimeStaging` (plan 2.7) is the one place this phase does delete anything, and it is scoped exclusively to `runtimePaths.stagingRoot` — scratch space that, by construction, never holds an active or known-good runtime (those live under `runtimePaths.runtimeRoot`, a disjoint directory tree) — swept once at every server startup so a crash mid-download or mid-verification never accumulates disk usage across restarts, verified directly not to touch the runtimes tree in the same test that proves it clears staging.

## ADR-083 Arc's product version is a hand-maintained file, not app.getVersion() or the BB-lockstep package.json version; BB provenance is tracked as a separate, independently-updated pair of facts

Status: **Accepted** (Phase 12)

`apps/desktop/package.json` and `packages/bb-app/package.json` stay locked together by the existing `check-version-lockstep.mjs` CI gate — that mechanism is untouched, and its version (0.43.1 at this writing) now means specifically "the BB base this Arc build carries," never "Arc's own release version." Arc's own version and its exact upstream fork point live in a new checked-in file, `apps/desktop/arc-version.json`: `{ "arcVersion": "1.0.0", "bbUpstreamCommit": "<sha>" }`. Both fields are set by hand by whoever ships an Arc release or resyncs from upstream — `bbUpstreamCommit` is not recomputed at build time (a `git merge-base HEAD upstream/main` lookup would need the `upstream` remote to exist in every CI checkout, which it does not, and would silently drift on every upstream push even when Arc has not actually resynced, which is the wrong semantics for "what commit was this fork built from"). `apps/desktop/scripts/build.mjs` reads this file and bakes `ARC_DESKTOP_APP_VERSION`/`BB_UPSTREAM_COMMIT` into the Electron bundle via the same esbuild `define` mechanism already used for `BB_DESKTOP_VERSION`/`BB_DESKTOP_COMMIT` (verified: compiling with and without an env override and grepping the resulting `dist/main.js` shows exactly the expected literal baked in, nothing else). `apps/desktop/scripts/run-electron-builder.mjs` uses `extraMetadata.version` — the documented electron-builder override, confirmed against a real `electron-builder 26.15.7` run that a bare top-level `"version"` key is rejected by its config schema — so packaged artifact names, `CFBundleShortVersionString`/`CFBundleVersion`, and the asar's own bundled `package.json` all carry `1.0.0`, verified directly against a real packaged `.app` (`PlistBuddy` and an `asar extract` of `package.json`). `getArcAppVersion()` in `main.ts` is the single call site every consumer (About panel, update-check `currentVersion`, `createdByArcVersion` passed into the Phase 11 runtime manifest, `arcAppVersion` passed into the managed-runtime child environment) now reads from — `app.getVersion()` is no longer called anywhere in the desktop app's own code, removing the risk of it silently disagreeing with the injected constant.

## ADR-084 Arc's application update source is fail-closed by construction: no default ever resolves to a BB-controlled URL, and the packaged app ships no update feed at all unless a real Arc feed is configured at build time

Status: **Accepted** (Phase 12)

Auditing the actual generated `electron-builder` config (not just source) found the real, live bug this ADR closes: `electron-builder.config.json` shipped a `publish` block pointing at `https://github.com/get-bb/bb/releases/download/desktop-latest/`, embedded into `app-update.yml` on every packaged build regardless of channel, despite a source comment in `run-electron-builder.mjs` asserting no such feed existed — the assertion was aspirational, not enforced, and the pre-existing test asserting the nightly channel's feed URL (`test/electron-builder-config.test.ts`) was already failing on a clean checkout before this phase touched anything, which is direct evidence the gap was real rather than theoretical. `desktop-update-provider.ts` had the identical hardcoded fallback for the informational (non-installing) version-check service. Fix, root-caused once rather than patched per call site: `DESKTOP_RELEASE_INFO.updateReleaseBaseUrl` (and everything derived from it — `createDesktopUpdateFeedUrl`, `DESKTOP_AUTO_UPDATE_FEED_CONFIG`, the generated `electron-builder` `publish` block) is `null`/absent unless `ARC_DESKTOP_UPDATE_FEED_BASE_URL` is explicitly set at build time, with no BB fallback ever coded in; `resolveDesktopUpdateSupport` returns `{ autoUpdate: false, versionCheck: false }` whenever no feed is configured, so neither the auto-updater nor the version-check pings *any* URL, BB's or otherwise, out of the box. Verified against a real packaged build: with no env configured, the shipped `.app` contains zero `publish` key and no `app-update.yml`; with `ARC_DESKTOP_UPDATE_FEED_BASE_URL=https://github.com/adnanelhabashy/the-arc/releases/download/` set (the approved production value), the packaged `app-update.yml` reads exactly that URL, and a whole-bundle grep for `get-bb/bb` and `dev.bb.desktop` returns zero hits outside the wrapped `bb-app` engine's own provenance strings (acceptable per the plan's own distinction between provenance text and a live update endpoint). The approved permanent identifiers — stable bundle ID `io.github.adnanelhabashy.arcagent`, nightly `io.github.adnanelhabashy.arcagent.nightly`, release repository `adnanelhabashy/the-arc` — are wired through `electron-builder.config.json`, `desktop-release-channel.mjs`, and the nightly-desktop CI jobs in `publish-bb-app.yml`; a real Developer ID signing identity was not available on the machine this phase built and validated on (the currently-installed production `/Applications/Arc Agent.app` is itself ad-hoc/unsigned, confirmed via `codesign -dv`), so this ADR covers identity and update-source trust only — code-signing/notarization policy is unchanged and untested by this phase, and is explicitly deferred to Phase 22's release-pipeline work rather than treated as a Phase 12 blocker.

**Closure addendum**: `publish-bb-app.yml`'s `nightly-desktop-publish` job has no `--repo`/explicit remote of its own — `git push`/`gh release` there act on whichever repository the workflow run belongs to, and `github.token` is hard-scoped by GitHub to that same repository (it cannot write anywhere else, including `get-bb/bb`, regardless of what this file says). Rather than leave that correct-but-implicit behavior unstated, the job now fails loudly up front unless `github.repository == 'adnanelhabashy/the-arc'`, and its publish step sets `GH_REPO=adnanelhabashy/the-arc` explicitly so every `gh release` call names its target rather than relying on inferred context — defense-in-depth on top of the hard GitHub-enforced boundary, not a substitute for it.

## ADR-085 BB re-enters Arc through a disposable, immutably-named sync branch and human approval; `upstream/main` is never merged into a product branch directly

Status: **Accepted** (Phase 13)

`git remote -v` already showed three remotes, not the two the phase brief assumed: `origin` is Adnan's own `adnanelhabashy/bb` fork/staging, `the-arc` (`adnanelhabashy/the-arc`) is the Arc product/release repo every product branch actually pushes to, and `upstream` (`get-bb/bb`) already existed, fetch-configured. `self-contained` already tracks `the-arc`, not `upstream` — the dangerous path the phase brief worried about (`branch.self-contained.merge` pointing at `upstream/main`) did not exist. The one real gap: `upstream`'s push URL was the live `get-bb/bb` remote, so a mistyped `git push upstream` would have attempted to write there. Closed by pointing `upstream`'s push URL at an invalid host (`git remote set-url --push upstream https://do-not-push-to-bb-upstream.invalid/...`) — fetch is untouched, push fails immediately and locally rather than depending on GitHub's token scoping as the only backstop. No remote was renamed: `the-arc` already serves the role the plan called `origin`, and renaming it would change every contributor's daily push target for a purely cosmetic match to the plan's placeholder name.

Sync procedure (`docs/bb-upstream-sync.md`): fetch `upstream`, branch `upstream-sync/<short-sha>` (named after the fetched `upstream/main` commit, not a date, so the branch name is self-describing and collision-free) from the current `self-contained` baseline, merge or rebase `upstream/main` into it, run the Arc invariant suite (ADR-086) plus typecheck/tests, review the diff against the "files that need special review" list, get human approval, only then merge into `self-contained`. `upstream/main` is fetched and read, never merged into a product branch directly — every step up to and including the diff review happens on the disposable sync branch, which is either merged forward with approval or deleted (`git branch -D`) with nothing else touched.

No `.gitattributes` merge-strategy (`ours`/`theirs`) is applied anywhere. It was considered and rejected: forcing a whole file to "ours" on every future conflict would silently discard a real upstream security fix the next time that file changes, which is a worse failure mode than an occasional manual conflict resolution. `docs/bb-upstream-sync.md` instead lists the specific files/directories a sync is most likely to conflict on, so a human reviewer knows where to look without an automated strategy deciding the outcome for them.

## ADR-086 The Arc invariant suite guards the config surface a merge touches directly, not a tree-wide rescan of Arc's entire behavior

Status: **Accepted** (Phase 13)

`packages/scripts/test/arc-invariants.test.ts` asserts the specific facts a BB merge conflict resolution could silently flip back: the stable and nightly bundle ids/product names (`electron-builder.config.json`, `desktop-release-channel.mjs`), that both desktop publish workflows (`publish-bb-app.yml`, `build-desktop.yml`) refuse to run outside `adnanelhabashy/the-arc`, that the desktop update feed carries no built-in BB fallback URL (`desktop-update-provider.ts`), that `arc-version.json` still carries an independent `arcVersion` plus a 40-hex `bbUpstreamCommit`, that `main.ts` reads the app version through `getArcAppVersion` rather than Electron's `app.getVersion()`, and that OMP's isolation env vars (`PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR`) are still wired in `arc-runtime/environment.ts`. It runs as an ordinary Vitest file in the existing `packages` CI test shard (`.github/workflows/ci.yml`) — no new CI framework, no new workflow file.

Deliberately out of scope: re-testing runtime management, account routing, or OMP behavior in depth. Those already have extensive suites of their own across `packages/arc-domains`, `plugins/account-pool`, and `plugins/provider-acp` (ADR-061 through ADR-084), which already run in CI on every PR including a sync PR; duplicating that coverage here would be redundant rather than safer, and would make this file a second, drifting source of truth for behavior the original suites already own.

Also deliberately out of scope: a tree-wide regex scan for every historical mention of `get-bb/bb` or `dev.bb.desktop` with an allowlist for legitimate ones (the pattern `scripts/check-provider-literal-ratchet.mjs` uses for provider-id literals). That mechanism exists because provider-id literals are genuinely scattered across core by design and need per-file tracking. Arc's release identity is not scattered — it lives in a small, known set of files. The forbidden-regression checks (`dev.bb.desktop`, `get-bb/bb/releases/download`) are scoped to exactly that curated file list, so a legitimate historical mention in an ADR, a doc, or `mobile-e2e.yml`/`marketplace-v2-live.yml`'s own get-bb/bb-only scheduled-job gates (real BB-upstream CI concerns, not Arc release targets) never fails the suite. Confirmed live while writing it: this scope caught a real, pre-existing gap — `build-desktop.yml`'s stable-channel publish job had no repository guard matching the one `publish-bb-app.yml`'s nightly job already had (Phase 12), and its step summary hardcoded `get-bb/bb` release-feed URLs that the job does not actually configure (it never sets `ARC_DESKTOP_UPDATE_FEED_BASE_URL`, so the packaged stable build already shipped with no feed at all, fail-closed per ADR-084 — the summary text was simply wrong, not a live endpoint). Fixed in the same phase: the guard now matches the nightly pattern exactly (fail loud outside `adnanelhabashy/the-arc`, explicit `GH_REPO`), and the summary states the actual fail-closed behavior instead of a URL nothing publishes to.

## ADR-087 A usage read serves Arc's last known measurement; it never fetches a provider

Status: **Accepted** (Phase 14)

`ArcUsageService.listUsageResources` is a cheap metadata inventory plus the per-resource last-good cache. Its `withCache` early-returned for any status other than `available`/`unavailable`, and both list-based sources (pool, OMP) return exactly `status: "unknown"` with no windows — the numbers live behind a separate `fetch`. The cache was therefore never overlaid onto a listing, so every read reported "unknown" with zero windows even when Arc held a real measurement. Verified against the running installed app before the change: `provider-usage.v1.getResource` for the Plus account returned `status: ok`, plan "Plus" and two windows, while `arc.usage.current` for `codex` returned `status: "unknown"` with no windows for the same resource id.

Decision: a read overlays the cached measurement onto the fresh listing. Identity always comes from the listing (`accountKey`, `accountSourceId`, `providerFamily`, `providerLabel`, `agentIds`, `credentialDisabled`, `sources`), so an identity the source no longer asserts is never claimed; measurement fields always come from the cache (`windows`, `observedAt`, `status`, `unavailableReason`, `message`, and the presentation fields the measurement itself produced, `accountEmail`/`planLabel`). A resource with no cached measurement stays `"unknown"` with no windows, so UNKNOWN != ZERO (ADR-064) is untouched.

Consequence: Mission Control's Usage page no longer has to force a provider fetch on every mount to show anything (it called `refreshAll()` — five forced vendor calls per visit, measured at ~4.9s), and the in-thread usage card shows the last known reading instead of nothing.

## ADR-088 Measurement freshness is the source's policy; Arc fills in the background and never blocks a read

Status: **Accepted** (Phase 14)

A read must not wait on a vendor call, and Arc must not outpace the cache underneath it. The pool already refreshes quota on its own 5-minute interval (`DEFAULT_USAGE_REFRESH_INTERVAL_MS`, `hub.ts`) and OMP has its own usage caching; `provider-usage.v1.getResource` with `refresh: false` therefore answers from the pool's cache in the common case.

Decision: when a listed resource's cached measurement is past its bound — 5 minutes for a good reading (matching the pool's own interval), 1 minute for an errored or non-available one — the read schedules a background fill for that resource, one fill per resource id, non-forcing (`source.fetch(id, false)`), and reports through `onMeasurementsChanged` so arc-core publishes `arc-changed`. The read itself returns immediately with what Arc already has. A provider that does not expose usage at all (`unavailable`/`not-exposed`) is a stable property, not staleness: it is only re-read on an explicit request.

Only the user's explicit Refresh/Retry forces (`source.fetch(id, true)`). `stale` keeps its existing meaning — "the last refresh attempt failed, this is last-good" — and age is shown from `fetchedAt`; the two are not conflated.

## ADR-089 Each cached domain has one owner, one key, and one invalidation path

Status: **Accepted** (Phase 14)

| Domain | Authoritative source | Backend cache | Renderer cache |
|---|---|---|---|
| Accounts | account-pool plugin (KV + sqlite) / OMP broker | none — read-through, single-flight only | `[arcAccounts]` (30s stale), Mission Control local state |
| Usage | pool `QuotaStore` / OMP broker | `ArcUsageService` last-good, keyed `resource.id` (embeds account identity) | `[arcCurrentAgentUsage, agentId, accountKey]` (15s stale), Mission Control local state |
| Runtime status | the runtime manifest on disk | none — read-through | Mission Control `useArcAgents` |
| Runtime updates | api.github.com / downloads.claude.ai | single-flight + 10-minute reuse window | Mission Control (deliberate click) |
| OMP providers | OMP broker + `omp auth-broker list` | 60s TTL + single-flight | Mission Control local state |
| Plugins | plugin service | marketplace manifest cache (unchanged) | `[plugin-list]` (30s) + `plugins-changed` |
| Thread account | `threads.account_key` in the DB | none | `[thread, id]`, with usage keyed by accountKey |

No domain shares another's cache and there is no global Arc cache (plan Step 13). Every account-scoped key embeds account identity, so one account's reading can never be served for another: the renderer key is `(agentId, accountKey)` and the backend resource id is `pool:<family>:<rowId>` / `omp:<provider>:<credentialId>`. `packages/arc-domains/test/arc-usage-refresh-policy.test.ts` proves the isolation, the eviction of a resource a healthy source no longer lists (a source outage never evicts another source's data), and that a late measurement for one account cannot land on another.

Invalidation is event-driven wherever Arc knows the truth changed: account add/remove/enable/disable/reorder and login completion drop the usage cache (the account list needs none — it is read through), the update/rollback that changes a runtime drops its discovery, an OMP shutdown drops the provider registry, and the renderer invalidates from `arc-changed` by kind (accounts/omp → accounts + usage, usage → usage). A TTL is never the only mechanism for a mutation Arc performed.

## ADR-090 Coalescing concurrent reads is single-flight, never a TTL

Status: **Accepted** (Phase 14)

The account inventory is read several times in one UI frame (`arc.accounts.list` plus every row of `arc.agents.list`, where Codex and Claude Code both resolve through the pool — three concurrent reads of one truth, each its own pool RPC), and the usage inventory is re-listed N+1 times by `refreshAllUsage`/single-resource refresh. The first fix attempt added a short TTL to the account inventory; it broke `ArcAccountService`'s existing contract that the read *after* a change observes the change, and was reverted.

Decision: concurrent callers share one in-flight read (single-flight) and nothing is cached on top. A read that follows the previous one still observes the source's current state; a whole `refreshAll` costs one inventory instead of N+1; and one `arc.agents.list` costs one pool `account.list` instead of two. The same rule was applied to the OMP snapshot/registry reads and to update discovery (which additionally reuses its answer for 10 minutes because it is the one read-shaped path that spends real external requests, and is invalidated by the update or rollback that changes it). `checkForUpdate` also waits for an in-flight prepare/update/rollback on the same agent instead of racing it.

## ADR-091 Arc's renderer caches invalidate from Arc Core's own change signal, not from a staleTime

Status: **Accepted** (Phase 14)

`arc-core` already published `arc-changed` after every mutation, but only Mission Control's agents/accounts hooks listened; the app's Arc caches and Mission Control's usage/OMP hooks did not, so a change made on one surface stayed invisible on the other until a staleTime expired. The app also had no reason to refresh on reconnect — Arc's signal is ephemeral and never replayed.

Decision: one cache owner in the app (`hooks/cache-owners/arc-cache-owner.ts`) owns the three Arc invalidations and the channel name; `useWebSocket` subscribes to the plugin channel and invalidates by kind; the Arc keys join the server-reconnect invalidation list; Mission Control's usage and OMP-provider hooks subscribe to the same signal; and switching a thread's account invalidates the agent's cached usage so the previous account's reading cannot be served as current state when the user switches back. The Arc query keys moved into `hooks/queries/query-keys.ts` beside every other key, which is what makes them addressable from the owner and the reconnect list.

## ADR-092 A provider whose runtime the application supplies declares no installation maintenance

Status: **Accepted** (pre-Phase-15 UI cleanup)

Arc's sidebar showed a "download + Codex" chip linking to Settings → Updates. Traced to source: `SidebarUpdatesBadge` renders one chip per provider CLI issue from `useUpdateInventory` → `buildProviderCliIssue` over the host daemon's `provider-clis/status`. Live cause, captured before any change: `codex` reported `installed: true, installSource: "external", currentVersion: 0.154.0, latestVersion: 0.155.1, needsUpdate: true, executablePath: /Users/adnan/.local/bin/codex, installAction {kind: "update", label: "Update", command: "codex update"}` — the probe resolved the user's *PATH* Codex, while Arc runs its managed 0.155.1 from Application Support. Clicking the chip would have run `codex update` against a binary Arc never launches. Claude Code did not show the chip only because its probe resolves `BB_CLAUDE_CODE_EXECUTABLE` (the managed binary) and happened to match npm's latest — the same duplicate would appear the moment a new Claude version shipped, and `acp-omp` never showed it because it already declares `providerInstallation: false`.

The ownership fact is not observable where it would be most convenient: plugin host workers are forked through `sanitizeInheritedChildProcessEnv`, which strips every `BB_*` variable, so a provider *host* artifact cannot see that the application supplied its runtime. Provider *declarations*, however, are imported into the server process itself (`jiti.import(resolveServerEntry(...))`), and that process is the Arc-owned child that carries `BB_CODEX_BRIDGE_APP_SERVER_COMMAND` / `BB_CLAUDE_CODE_EXECUTABLE` / `BB_OMP_EXECUTABLE`.

Decision: the provider plugin withdraws `maintenance.installation` when the application supplied its executable — `codexOffersInstallationMaintenance(process.env)` in `plugins/provider-codex/src/runtime-ownership.ts`, `claudeCodeOffersInstallationMaintenance(process.env)` in `plugins/provider-claude-code/src/runtime-ownership.ts`. The rule is stated once, in the same terms for each provider: *if the host application handed me the executable to run, it owns that runtime's installation and updates, so provider-level installation maintenance is not mine to offer.* `maintenance.health` and `maintenance.usage` are untouched, and a standalone bb server (no such variable) keeps its declaration exactly as before, so non-Arc deployments are unaffected.

This is deliberately applied at the source of the data rather than by hiding a control in the renderer: `maintenance.installation` gates the provider's appearance in `provider-clis/status` (its only consumer, via the `capability: "installation"` filter), so the issue never reaches any surface — the sidebar chip, Settings → Updates, and the install runner are all covered by construction, and no surface needs a hard-coded provider-id list. Verified live after the change: `provider-clis/status` returns `{}`, the installation-capability provider list is empty, the three providers keep `health: true` / `usage` unchanged and stay available, and the only remaining update control in the entire app is Mission Control's Arc-owned runtime Update ("Source: Arc-managed", Runtime 0.155.1 / 2.1.278 / 18.2.7).

## ADR-093 One usage read model, and only two facts may name a thread's account

Status: **Accepted** (pre-Phase-15 OMP account + usage unification)

Three surfaces showed account usage from two different models, and only one of them could see OMP. Traced:

- **Mission Control → Usage & Limits** reads `arc.usage.snapshot` (`lib/data.ts` `useArcUsage` → MC's `arc_usage_snapshot` proxy → `arc.usage.snapshot`) and renders every resource unfiltered, grouped by agent. It has no notion of an *active* account, which is exactly why it showed Kimi Code and OpenCode Go correctly: nothing had to be resolved.
- **The sidebar** is not an Arc surface at all: it is the restored BB `provider-usage` plugin's footer disclosure, aggregating `provider-usage.v1` usage sources (Account Pooler, local provider CLIs) into machines × providers. OMP provider accounts are not a source there, so the panel could only ever show pooled Codex/Claude accounts.
- **The in-thread Usage & Limits popup** calls `arc.usage.current`, which needs the thread's *active* account. Live state: `threads.account_key` is NULL for every OMP thread (they are never pinned), so the popup took its `activeAccountUnknown` branch and rendered no resources at all. A second, independent gap: OpenCode Go's usage resource has `accountKey: null` (an api-key credential has no provider-issued account id), so it could never be matched by `accountKey` — only by `accountSourceId`, which is the same `accountKey ?? id` identity the account picker binds a thread to.

Decision: `ArcUsageResource` stays the one Arc-level view model (it already carries provider, accountKey, accountSourceId, display name/plan/email, windows, status, stale, fetchedAt/observedAt — the `UsageAccountView` the plan asked for, reused rather than duplicated), and a new pure resolver decides which account a thread may show. Precedence is two facts, and nothing else:

1. the thread's own binding — matched against `accountKey` **or** `accountSourceId`, so an OMP api-key account is addressable;
2. for OMP only, the provider that the thread's selected *model id* belongs to. OMP namespaces every model id as `<provider>/<model>` over the same provider ids its credentials carry (`kimi-code/kimi-for-coding`, `opencode-go/ox-alpha-free`, 42 models across the two live providers), so the prefix is a provider fact, not a guess from a display label. If that provider has exactly one connected credential it is the account; several or none stays **unknown**, and the surface shows "Active account unknown" rather than one of them.

The model id is part of the usage query key, so switching the model (Kimi → OpenCode) starts a new cache entry: a late answer for the provider the thread left cannot overwrite the state of the provider it moved to, and switching back serves the earlier provider's own reading.

The sidebar gets Arc's own `Accounts & Usage` disclosure (registered by the Mission Control plugin) rendering that same snapshot grouped as OMP / Codex / Claude Code, with the same window render rules — which now live once, in `components/usage-window-format.ts`, shared with the page. The BB `provider-usage` panel is deliberately *not* forked or hidden: its contract requires a numeric `usedPercent` and has no `unavailable`/`not-exposed` status and no amount-only windows, so Kimi's amount-only limits ("0 remaining", "100 remaining") and Arc's honest statuses cannot be expressed through it without fabricating percentages — which is the one thing this domain forbids. Both surfaces stay reachable and user-hideable; Arc's is the one that shows every account.

Ownership is untouched: OMP accounts remain OMP broker/provider identities, pooled accounts remain Account Pool rows, and the resolver is presentation-only — it never routes, pins, switches, or persists anything. `activeAccountUnknown` keeps its Phase 14 meaning, and `UNKNOWN != ZERO` still holds end to end: a resource that reports nothing renders a status line, never 0%.

## ADR-094 The BB `provider-usage` footer panel is not registered in Arc; the plugin keeps its server, its settings section, and its refresh content script

Status: **Accepted** (supersedes the closing paragraph of ADR-093: "Both surfaces stay reachable and user-hideable")

Two sidebar-footer disclosures showed overlapping pooled-account usage, and Arc's own `Accounts & Usage` (registered by the Mission Control plugin under ADR-093) is the strictly larger one. Verified on the installed app before the change: the BB disclosure's trigger was labelled "Provider usage" and its panel headed "Account Pooler" with the two pooled Codex accounts only (`00.xcode.00@gmail.com` Plus, `adnan.ahmed@egx.com.eg` Team, 5h/7d) — the same two accounts, the same windows, and fewer of them than Arc's panel, which also carries OMP (OpenCode Go, Kimi Code) and Claude Pro. ADR-093's reason to keep the BB panel was that its contract cannot express amount-only windows (Kimi's "0 remaining"), so it must not be *used* as Arc's surface — that reason argues against rendering Arc's data through it, not for keeping a duplicate rendering of the pooled subset next to the correct one.

Decision: `plugins/provider-usage/app.tsx` no longer registers `experimental_sidebarFooter`. The panel implementation (`ProviderUsageStatusContent`, `ProviderUsageStatus`, `MachineSelector`, `ProviderUsageBody`, `UsageWindow`, `formatResetCountdown`) and the client store that existed only to feed it were deleted with the registration, together with its test file and its story scene. The plugin itself is untouched and stays enabled:

- `bb.rpc.register(providerUsageRpcContract, { getUsage })` — Arc's pooled usage read path (`packages/arc-domains/src/arc-usage/pool-source.ts` calls `provider-usage.v1.listResources` / `getResource`);
- `app.slots.settingsSection({ id: "usage", component: UsageSettings })` — its own settings page, including the thresholds the collector reads;
- `app.contentScripts.register({ id: "refresh-usage" })` — the 30-minute safety refresh and the focus/keyed refresh that keep the snapshot that RPC serves warm. This caller always passed `providerId: null` and is unchanged; only the panel ever passed a provider, so every remaining refresh is an all-source one, which is what Arc's reads want.

Deliberately not solved with a product-mode flag: the plugin SDK exposes no Arc/BB product identity to plugin apps (`PluginAppDefinition`/`BbPluginApi` carry host primitives only, no product field), and adding one would diverge in BB's own host or SDK code instead of in one plugin registration. The divergence is recorded in `docs/bb-upstream-sync.md`, so a sync review sees it; upstream BB keeps its panel.

Capability consequence, stated rather than implied: the BB panel was the only *machine-scoped* usage view in Arc (`MachineSelector` plus provider grouping). Arc's Mission Control → Usage & Limits has no machine dimension. Nothing is lost in the data path — the server-side collector still aggregates per machine and `getUsage` still accepts `machineIds`, so any future Arc surface can ask for a machine's resources — but the rendered per-machine view is gone. Account Pool (backend, hub, persistence), Plus/Team routing, and Claude routing are untouched: `plugins/account-pool` ships no frontend in this fork at all, so it never contributed the panel.

## ADR-095 `codex-code-mode-host` is shipped as a required companion of the managed Codex runtime, staged as a sibling of `codex`; the `features.code_mode_host=false` override is removed

Status: **Accepted** (supersedes ADR-075)

ADR-075 closed the "host executable was not found" notice by disabling the probe, on the reasoning that `code_mode` (the tool that would consume the host) was off everywhere. Two things since then changed the arithmetic:

- The model catalog Codex actually serves ships Code Mode as a *model* property: 8 of the 9 entries in the real `~/.codex/models_cache.json` advertise `tool_mode: "code_mode_only"` (`gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-reserve`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `codex-auto-review`). With the host disabled, a session on those models reports `Code Mode is unavailable … Code mode will fail closed` — i.e. Arc was degrading exactly the models it ships for, which is a capability regression, not a cosmetic warning.
- `features.code_mode` is `Stage::UnderDevelopment`/`default_enabled: false` and is *not* derived from model metadata (`codex-rs/features/src/lib.rs`'s `normalize_dependencies` only promotes `code_mode` from `code_mode_only`), so enabling the host alone is not enough to make Code Mode work.

Verified against the real pinned binary and the real managed install (`0.155.1`, executable digest `8eaf1ad1…`):

- **Discovery is sibling-of-executable.** `codex-rs/install-context/src/lib.rs`'s `code_mode_host_program()` prefers a package resource (`codex-resources/`), then falls back to `<directory of the running codex>/codex-code-mode-host`. Arc's layout (`…/arc-runtimes/runtimes/codex/0.155.1/codex`) makes `CodexPackageLayout::from_exe` return `None` and `InstallMethod` resolve to `Other` (confirmed by the binary's own `doctor --json`: `install method = other`), so the sibling path is the one that is used. No PATH lookup, no environment variable, no `~/.codex` change.
- **Proved end to end in disposable layouts.** Two throwaway directories, each with a copy of the managed `codex`; one with `codex-code-mode-host` beside it, one without, each against an isolated `CODEX_HOME` and an unreachable base URL. Without the sibling: `Code Mode is unavailable because failed to spawn code-mode host /tmp/…/without-host/codex-code-mode-host: host executable was not found.` With it: no Code Mode message at all.
- **The host has no `--version`.** Its `--help` offers only `--listen`/`--otel-trace-*`. Its identity therefore rests on the release tag plus both digests, never on a self-reported version. Its offline liveness signal is that `--listen stdio` stays up while stdin is held open (verified: exits 0 immediately with stdin closed, stays alive silently with it open).

Decision:

1. `ARC_CODEX_RELEASE` gains `companions`, a version-locked list published from the same release tag. The Codex host is pinned at `codex-code-mode-host-aarch64-apple-darwin.tar.gz`, asset `sha256:e8957108eebd70963b0906857ceb7f7a2b477d1972a7147041c625d4071b508a`, executable `sha256:59a702a68f1ef79fceaca644db46b8385ceefbb66035e78b8ade7cdcc21fda55`. `validateArcRuntimeRelease` refuses a companion whose URL is off the runtime's trusted origin, is not under the runtime's own release tag, or carries a non-hex digest — so a helper can never be staged from a different release than the binary beside it.
2. `ARC_RUNTIME_MANIFEST_SCHEMA_VERSION` becomes 3 and each entry gains `componentsByVersion: Record<version, Record<fileName, digest>>`. Keyed by version so a rollback to a previously-installed version still describes *that* version's helpers. A v2 file migrates forward with an empty map (truthful: it was activated with no helpers), and v1 still migrates through v2.
3. Staging, activation and rollback all operate on the **version directory** as one unit, so both artifacts travel together by construction: `installFromSeed` stages the companion before the atomic rename, `moveStagedToVersionRoot` renames the whole staging directory, and rollback refuses a known-good target whose recorded helper is missing.
4. `resolveAppServerLaunch` no longer appends `-c features.code_mode_host=false`. `features.code_mode=true` is appended **only** when the thread's selected model advertises Code Mode, read from the Codex model catalog cache in the CODEX_HOME Codex itself will use. That cache is the only place the fact exists: the app-server's `model/list` response has no tool-mode field (`app-server-protocol/schema/json/v2/ModelListResponse.json` at rust-v0.155.1). A cache that is absent, unreadable, or silent about the model yields `unknown`, which is treated as "do not enable" — the app-server is spawned before the model is known, so the decision is made from the thread's own session options, and the fail-safe direction is host-enabled/code-mode-off, which is a working runtime rather than a degraded one.
5. Health and status check the components: `probeArcRuntimeHealth` verifies presence, executability, digest and — for the host — a real `--listen stdio` liveness run, and asserts `code_mode_host` appears in `doctor --json`'s effective feature list (verified that `-c features.code_mode_host=false doctor --json` drops it, so the assertion is meaningful). `ArcAgentManager.resolveRuntimeStatus` reports `broken` with the failing helper as the reason, and the Mission Control Agents view now shows that reason rather than only the chip.

Not done, deliberately: a Windows/Linux release matrix. This fork pins only `darwin-arm64` for all three runtimes and has no platform-selection code at all, so the x64 mappings below are recorded for whoever builds that matrix, **not** implemented or validated. darwin-arm64 is physically validated; the others are asset-level only (names and digests read from the real release):

- win32-x64: `codex-code-mode-host-x86_64-pc-windows-msvc.exe.zip`, `sha256:b098b6858f0b54a35a23f2754fb84a6e7ae004555e19656797500c7219540335`
- linux-x64: `codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz`, `sha256:9fd083743af55be818aceb351d371fb5136f5b6aa3938f167087373d27067b2d`

## ADR-096 Permission resolution is one provider-aware policy in `@bb/domain`; provider compatibility may never raise a permission level, and the machine ceiling is never bypassed

Status: **Accepted**

Five separate implementations decided permission modes, and the primitive they shared had a short circuit that made all of them wrong in the same way. `clampPermissionModeToCeiling` returned the requested mode as soon as it was at or below the ceiling, *before* consulting the provider's supported set — so with the default ceiling of `full`, a request of `auto` for a provider that supports only `accept-edits`/`full` (every ACP provider) returned `auto` and then failed at `Provider "acp-omp" only supports accept-edits, full permission mode.` That is the reported OMP/DeepSeek breakage. The three "fallback ladders" that existed to compensate (`resolveSupportedPermissionMode`, the UI's `resolvePermissionModeSelection`, `plugins/automations`' `resolvePermissionMode`) all preferred the *highest* available mode, so an unsupported `auto` silently became **Full Access** — including as the default for a brand-new OMP thread, and for a managed child of an `auto` parent before the parent clamp pulled it back.

Decision:

1. `packages/domain/src/permission-resolution.ts` holds the one policy, `resolveEffectivePermissionMode`, plus `permissionModesWithinCeiling` (shared with UI option lists) and `describePermissionModeUnsupported` (one wording for every surface). `clampPermissionModeToCeiling` now bounds the request by `min(requested, ceiling)` intersected with the provider set, and returns `null` when the provider offers nothing that low.
2. Source precedence is explicit-request → thread-last → parent → project → product, with legacy recorded modes normalized in the resolver. There is no separate "role" tier: Mission Control owns a role's permission and forwards it as the explicit request when it dispatches, so the two share one step instead of two that would have to be kept in sync.
3. Provider compatibility can only ever move a mode **down**. If nothing at or below the request is available the resolver returns `unsupported` with a reason (`provider` or `ceiling`) and an actionable message — it never substitutes a broader mode. A provider that supports only `full` (pi) therefore cannot be defaulted into Full Access; the request must say `full`.
4. The parent thread's mode is an inherited *default*, never a security ceiling (upstream `b329760f9`, "Remove parent thread permission clamping"), gated on the parent being live. The host/machine ceiling remains authoritative and is applied on every path, including workflows and automations, which previously never consulted it.
5. The server owns the boundary: `requireProviderPermissionMode` in `apps/server/src/services/hosts/permission-ceiling.ts`, called from thread creation, existing-thread execution, runtime commands and forks. Workflows and automations stopped deciding anything — they pass the mode they want and let the server resolve it — and `plugins/automations`' provider-permission module is now only an availability check plus the product default. The UI shares the same function, so switching provider cannot leave a selection the provider cannot execute waiting for the send to fail; a carried-over mode that cannot be honoured falls back to the product default for the new provider before it ever shows the least-privileged permitted mode.

Consequences stated rather than implied: a full-only provider now requires an explicit full-access choice instead of being silently granted it; a thread whose stored execution names a mode its provider lacks fails loudly on the next send instead of being adapted; and Mission Control's `thread_delegate` now actually forwards `role.permissionMode`, which it previously persisted, displayed and then ignored.

## ADR-097 Code Mode needs no `features.code_mode` override and no user catalog cache; the seed pipeline fetches companions itself, and Mission Control's bundle is stamped

Status: **Accepted** (corrects ADR-095 items 4 and 5, and extends items 1 and 2)

Four things ADR-095 got wrong or left open, each settled by running the real pinned binary.

**1. The catalog-gated `features.code_mode=true` was unnecessary, and its input was the user's stale cache.** ADR-095 read `models_cache.json` from the CODEX_HOME to decide whether to pass `features.code_mode=true`. Two measurements killed that design:

- `codex features list` on a **completely empty CODEX_HOME** reports `code_mode_host` as `stable` / **true** and `code_mode` as `under development` / false. So the host is on by default and the only thing that ever disabled it was Arc's own `-c features.code_mode_host=false`. Removing that override is the whole fix.
- With the host present, a Code-Mode model, an empty CODEX_HOME and **no `features.code_mode` flag at all**, `codex exec -m gpt-5.6-luna` emits no Code Mode message; with the helper absent it emits `Code Mode is unavailable …`. Codex promotes `code_mode` from the model's own catalog entry, so nothing in Arc needs to decide it.

The comparison also showed the cache was actively wrong: the user's `models_cache.json` listed `gpt-6-sol`, `gpt-6-luna` and `gpt-reserve`, while the binary's own catalog lists `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-daybreak-{blue,red}-latest`, `gpt-5.5`, `gpt-5.4`, `codex-auto-review`. Decision: `resolveAppServerLaunch` passes **no** `features.code_mode*` argument at all, and nothing in the launch path reads a user file. The catalog-reading module and env marker that the first revision of this work added are gone from the change entirely (`git diff` on that path is empty), because the flag they existed to compute turned out to be one Codex already sets correctly.

**2. The runtime probe reads the live catalog, and `doctor`'s exit code is not a health signal.** `codex debug models --bundled` renders the catalog offline in ~0.1s on an empty CODEX_HOME, so `probeArcRuntimeHealth` now requires a parseable, non-empty catalog and reports how many of its models are Code-Mode. Two bugs surfaced while wiring it: `execFile`'s default 256 KiB buffer truncates the real 433 KiB catalog (a healthy runtime reported as "could not render its own model catalog"), and `doctor --json` exits **1** on a profile without `auth.json` while still printing a complete report — so requiring exit 0 conflated being signed out with a broken runtime. Authentication has its own preflight; the runtime probe no longer duplicates it.

**3. The seed pipeline fetches the helper.** `prepareRelease` considered a seed complete when the *executable's* digest matched, so `apps/desktop/resources/arc-runtimes/codex/<version>/` holding only `codex` looked finished and would have shipped without the helper. Completeness now covers every file (`planArcRuntimeSeedBuild` in `packages/arc-domains/src/arc-runtime/seed-plan.ts`), the companion asset is downloaded and digest-verified through the same cache path as the executable, and `stageReleaseExecutable`'s existing refusal to return `ok` without every declared companion is what makes a partial seed impossible. Verified by running the real script: a clean resources root downloads both assets, extracts both and publishes `codex` + `codex-code-mode-host` with the pinned digests (`8eaf1ad1…`, `59a702a6…`); a seed holding only the binary is rebuilt; a complete one is skipped. `stageArcRuntimeCompanion` also had to extract into a directory of its own — the archive extractor asserts an empty destination, and by then the staging directory already held the executable.

**4. Mission Control's `dist/` is tracked, and nothing rebuilt it.** The running app's `plugins.root_dir` for `adnan-mission-control` is `/Users/adnan/Projects/bb/adnan/plugins/adnan-mission-control`, so the committed `dist/server.js` is what loads. It had drifted: the tracked bundle still carried the pre-change message. `bb plugin build` is byte-deterministic and its output does not embed any version string, so drift is mechanically detectable: `scripts/build.mjs` (exposed as `pnpm --filter bb-plugin-adnan-mission-control build`) builds and then records a digest over the build inputs in `dist/source.stamp.json`, and `test/dist-bundle-current.test.ts` fails until both the build and the commit happen. This is a process requirement, not a runtime one — rebuilding it while the app runs is a hot-swap, which is why the step belongs at commit time.

## ADR-098 Permission failure messages name modes the way the picker does, and lead with the least privilege

Status: **Accepted**

`describePermissionModeUnsupported` spoke in wire slugs (`choose one of full`) while the composer picker says `Full Access`, so a message whose entire purpose is to tell the user which option to select named an option they could not find. `@bb/domain` now owns `permissionModeLabel`, `packages/client-core`'s `PERMISSION_MODE_OPTIONS` derives its labels from it, and Mission Control mirrors the same words for the role-router issues it raises (it has no workspace dependency on `@bb/domain` and already mirrors `permissionModeRank` for the same reason).

A provider that offers exactly one mode within the ceiling is now spelled out — `This provider requires Full Access, and Arc will not raise the permission level on its own; select Full Access to run it.` — because that is the case where the user's only way forward is a deliberate choice Arc refuses to make for them. The permitted list in the general case is sorted least-privilege-first: it is a "choose one of" instruction, and the underlying set is ordered highest-first.

The security behaviour is unchanged and pinned by tests: `auto` against a full-only provider fails; it never becomes Full Access. The composer lands on Full Access for that provider, so the mode the message names is the mode the picker offers.
