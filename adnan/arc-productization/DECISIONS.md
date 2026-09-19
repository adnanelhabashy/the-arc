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
