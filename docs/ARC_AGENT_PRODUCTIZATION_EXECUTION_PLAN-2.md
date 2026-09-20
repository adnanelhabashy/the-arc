# Arc Agent — Complete Productization & Managed Agent Runtime Plan

**Document type:** Executor implementation runbook  
**Target product:** Arc Agent  
**Primary implementation repository:** `~/Projects/bb`  
**Known remote fork:** `adnanelhabashy/bb`  
**Primary platform for first production-quality implementation:** macOS Apple Silicon (`darwin-arm64`)  
**Prepared:** 2026-09-18  
**Status:** ACTIVE IMPLEMENTATION PLAN — updated after Phase 10 packaged-app validation

**Current implementation checkpoint (2026-09-19):** Phases 0–10 have been implemented to the first packaged UI milestone. Real installed-app testing added two mandatory stabilization phases before runtime updating: Phase 10.1 (authentication/accounts/usage) and Phase 10.2 (per-thread account selection).

---

# 0. Purpose of this document

This document tells the executor exactly how to evolve the current Arc Agent / BB fork into a complete installable coding-agent product.

The final product must work for a new user who has **none of these installed globally**:

- Codex CLI
- Claude Code
- OMP / Oh My Pi
- Bun
- a global npm-installed coding agent
- any manually configured agent PATH entry

The user installs **Arc Agent**, opens it, connects accounts from the Arc UI, and starts coding.

The required built-in agent experience is intentionally limited to exactly three agent engines:

1. **Codex**
2. **Claude Code**
3. **OMP / Oh My Pi**

Arc is responsible for:

- runtime availability;
- runtime health;
- runtime version visibility;
- runtime updates;
- runtime rollback;
- account onboarding;
- account status;
- usage / rate-limit visibility;
- model selection through the underlying agent systems;
- clean UI management;
- preserving existing Arc Mission Control functionality;
- protecting Arc from upstream BB updates;
- allowing BB upstream improvements to be integrated safely by the maintainer.

This is **not** a request to replace Codex, Claude Code, or OMP.

Arc is the product/control plane around those engines.

---

# 1. FINAL USER EXPERIENCE — DEFINITION OF THE PRODUCT

A fresh macOS Apple Silicon user should eventually experience this:

```text
Download Arc Agent.dmg
        ↓
Install Arc Agent
        ↓
Open Arc Agent
        ↓
Arc initializes its private agent runtimes
        ↓
┌─────────────────────────────────────┐
│ Codex       Ready                   │
│ Claude Code Setup / Ready           │
│ OMP         Ready                   │
└─────────────────────────────────────┘
        ↓
Connect AI accounts from Arc UI
        ↓
Choose an agent + model
        ↓
Open/create project
        ↓
Start coding
```

The user must **not** be required to open Terminal and run:

```bash
npm install -g @openai/codex
npm install -g @anthropic-ai/claude-code
bun ...
omp ...
codex ...
claude ...
```

The user must **not** be required to manually edit:

```text
PATH
.zshrc
.bashrc
~/.profile
```

Arc should remain usable even if the user later installs separate system copies of those CLIs.

Arc's managed copies should remain deterministic and preferred unless the user explicitly opts into an external runtime.

---

# 2. NON-NEGOTIABLE ARCHITECTURE

Use this mental model throughout implementation:

```text
                            ARC AGENT
┌─────────────────────────────────────────────────────────────────┐
│ Product / Desktop Layer                                         │
│ Projects · Threads · Worktrees · Diff · Terminal · Settings     │
│ Mission Control · Accounts · Usage · Updates · Roles            │
├─────────────────────────────────────────────────────────────────┤
│ Arc Control Plane                                               │
│ Runtime Manager · Account Adapters · Usage Registry             │
│ Compatibility Policy · Update Manager · Health                  │
├─────────────────────────────────────────────────────────────────┤
│ Agent Engines                                                   │
│                                                                 │
│      Codex CLI          Claude Code             OMP             │
│          │                  │                    │              │
│      ChatGPT/API        Claude.ai           Providers           │
│                                             ├─ Kimi             │
│                                             ├─ OpenAI           │
│                                             ├─ Anthropic        │
│                                             ├─ Gemini           │
│                                             ├─ OpenRouter       │
│                                             ├─ DeepSeek/custom  │
│                                             └─ ...              │
└─────────────────────────────────────────────────────────────────┘
```

Do **not** collapse these layers.

In particular:

- Do not put vendor credential parsing into React components.
- Do not put runtime downloading logic into `usage-limits.tsx`.
- Do not make Mission Control know how every OMP provider authenticates.
- Do not put Arc-specific provider behavior into the generic `@bb/agent-runtime` core unless there is no clean extension point.
- Do not store OAuth refresh/access tokens in Mission Control KV.
- Do not turn the existing `server.ts` into a giant provider-specific monolith.

---

# 3. EXECUTOR RULES — READ BEFORE TOUCHING ANY FILE

These rules are mandatory.

## 3.1 Work only from the actual local checkout

The user's authoritative implementation checkout is expected to be:

```bash
~/Projects/bb
```

Do not assume GitHub `main` exactly equals the local working tree.

The remote fork currently does not expose all first-party provider plugin source directories that current upstream BB contains, while the user's running Arc installation clearly has functionality from those provider plugins.

Therefore:

> The executor must inventory the local checkout before planning file edits.

If a file mentioned later in this plan does not exist locally:

1. do not invent it;
2. do not create a fake equivalent immediately;
3. determine whether it exists in upstream `get-bb/bb`;
4. determine whether the local checkout is behind upstream;
5. report the discrepancy;
6. choose a deliberate port/sync path.

## 3.2 Do not destroy uncommitted work

Before edits:

```bash
cd ~/Projects/bb
git status --short
```

If the tree is dirty:

- list the changed files;
- do not reset them;
- do not run `git checkout -- .`;
- do not run `git restore .`;
- do not stash without explicit user approval;
- do not rebase the dirty branch;
- do not merge upstream into it.

The user's existing Arc rebrand work must survive.

## 3.3 Do not commit, push, merge, or publish without approval

The executor may prepare changes and tests.

It must not perform:

```bash
git commit
git push
git merge
git rebase
gh release create
npm publish
```

unless explicitly approved by the user for that step.

## 3.4 Do not expose credentials

Never print or persist:

- OAuth access tokens;
- OAuth refresh tokens;
- API keys;
- Claude credentials;
- Codex auth files;
- OMP broker bearer tokens;
- keychain secret values.

Safe diagnostic data:

- account email if the provider already exposes it;
- account ID only if masked;
- plan name;
- provider name;
- auth state;
- runtime version;
- usage percentage;
- reset timestamp.

## 3.5 Do not guess undocumented CLI output

Before writing a parser for any CLI command:

1. execute the exact command against the version Arc will support;
2. capture **redacted** sample output;
3. create a Zod/schema parser from the observed shape;
4. keep unknown fields tolerated where appropriate;
5. add fixture tests.

Never write a parser from memory.

## 3.6 Preserve the Mission Control honesty rule

The current plugin follows an important rule:

```text
unknown ≠ zero
```

Keep it.

If a provider does not expose usage:

```text
Usage unavailable
```

not:

```text
0% used
```

If reset time is unknown:

```text
n/a
```

not a synthetic date.

If a usage refresh fails but a previous real observation exists:

- preserve the previous observation;
- show that it is stale;
- show refresh failure;
- do not erase it and show zero.

## 3.7 Implement one phase at a time

After every phase:

- typecheck;
- run relevant unit tests;
- run focused integration tests;
- record what changed;
- record what remains;
- do not proceed if the acceptance gate fails.

Do not make a 100-file rewrite and test only at the end.

---

# 4. PHASE 0 — MANDATORY SOURCE-OF-TRUTH INVENTORY

**No implementation edits before this phase is complete.**

## 4.1 Commands to run

From Terminal:

```bash
cd ~/Projects/bb

printf '\n=== LOCATION ===\n'
pwd

printf '\n=== BRANCH ===\n'
git branch --show-current

printf '\n=== HEAD ===\n'
git rev-parse HEAD
git log -1 --oneline

printf '\n=== STATUS ===\n'
git status --short

printf '\n=== REMOTES ===\n'
git remote -v

printf '\n=== VERSIONS ===\n'
node --version || true
pnpm --version || true
npm --version || true

printf '\n=== PROVIDER PLUGINS ===\n'
for p in \
  plugins/provider-codex \
  plugins/provider-claude-code \
  plugins/provider-acp \
  plugins/provider-usage \
  plugins/account-pool
do
  if [ -d "$p" ]; then
    echo "PRESENT $p"
  else
    echo "MISSING $p"
  fi
done

printf '\n=== ARC MISSION CONTROL ===\n'
test -d adnan/plugins/adnan-mission-control \
  && echo "PRESENT adnan/plugins/adnan-mission-control" \
  || echo "MISSING adnan/plugins/adnan-mission-control"

printf '\n=== DESKTOP FILES ===\n'
test -f apps/desktop/scripts/desktop-release-channel.mjs && echo "release channel present"
test -f apps/desktop/scripts/run-electron-builder.mjs && echo "builder script present"
test -f apps/desktop/electron-builder.config.json && echo "electron config present"

printf '\n=== BB RUNTIME PACKAGES ===\n'
test -d packages/agent-runtime && echo "agent-runtime present"
test -d packages/bb-app && echo "bb-app present"
test -d packages/bundled-plugins && echo "bundled-plugins present"
```

If the installed `bb` CLI is available, also run:

```bash
bb --version || true
bb plugin list || true
```

## 4.2 Save the inventory

Create a temporary implementation record, for example:

```text
adnan/arc-productization/BASELINE.md
```

Do not include secrets.

Record:

- current branch;
- current commit;
- dirty files;
- local BB version;
- local plugin SDK version;
- which provider plugin source directories actually exist;
- Mission Control path;
- current app name;
- current update-feed configuration;
- current provider IDs.

## 4.3 Provider IDs that must remain stable unless a migration is deliberately designed

Expected logical IDs:

```text
codex
claude-code
acp-omp
```

Do not rename these merely for branding.

Arc branding is a presentation concern; breaking stored provider IDs can break threads, role mappings, and persisted configuration.

## 4.4 Baseline tests before edits

Run the smallest existing tests that prove the checkout works.

At minimum:

```bash
pnpm --filter @bb/desktop typecheck
pnpm --filter @bb/desktop test
pnpm --filter @bb/agent-runtime test
```

For Mission Control, inspect its package scripts first:

```bash
cat adnan/plugins/adnan-mission-control/package.json
```

Then use the available typecheck/build command.

If there is no script, run the plugin's supported BB build command from its directory:

```bash
cd adnan/plugins/adnan-mission-control
bb plugin build
```

Return to repo root afterward.

## 4.5 Phase 0 acceptance gate

Do not continue until the executor can answer all of these:

- What exact branch is being edited?
- Is it clean or dirty?
- Which provider plugin source folders exist locally?
- Which version of BB is this checkout?
- Which version of the plugin SDK does Mission Control target?
- Does Mission Control build before changes?
- Does the desktop build/typecheck before changes?
- Does the current generated Electron config still reference any `get-bb/bb` update URL?
- Does the packaged/run-time checkout differ from the public GitHub fork?

---

# 5. MANDATORY READING MAP

The executor must read the relevant files before each phase.

Do not skim filenames only.

## 5.1 Read before runtime work

Local files:

```text
apps/desktop/src/main.ts
apps/desktop/src/bb-process.ts
apps/desktop/src/app-paths.ts
apps/desktop/scripts/build.mjs
apps/desktop/scripts/run-electron-builder.mjs
apps/desktop/scripts/desktop-release-channel.mjs
apps/desktop/electron-builder.config.json
apps/desktop/package.json
packages/agent-runtime/README.md
packages/agent-runtime/src/provider-adapter.ts
packages/agent-runtime/src/provider-registry.ts
packages/agent-runtime/src/execution-options.ts
packages/bb-app/package.json
```

Why:

- understand where Electron starts its owned BB runtime;
- understand what environment reaches the server/host daemon;
- understand packaging;
- understand why provider-specific behavior belongs in bridges/plugins, not `agent-runtime`;
- understand version lockstep.

## 5.2 Read before provider work

If present locally, read:

```text
plugins/provider-codex/server.ts
plugins/provider-codex/src/bridge/provider-maintenance.ts

plugins/provider-claude-code/server.ts
plugins/provider-claude-code/src/bridge/provider-maintenance.ts

plugins/provider-acp/server.ts
plugins/provider-acp/src/known-agents.ts
plugins/provider-acp/src/declaration.ts
plugins/provider-acp/src/bridge/provider-maintenance.ts
```

Also read:

```text
apps/server/src/services/system/usage-limits.ts
packages/plugin-sdk/src/backend-contract.ts
```

If these provider sources are missing locally, use current upstream `get-bb/bb` as the reference implementation and port intentionally.

## 5.3 Read before account management work

Read, when available:

```text
plugins/account-pool/src/server.ts
plugins/account-pool/src/rpc.ts
plugins/account-pool/src/contracts.ts
plugins/account-pool/src/store.ts
plugins/account-pool/src/oauth-login.ts
plugins/account-pool/src/codex-device-login.ts
plugins/account-pool/src/usage-source.ts
plugins/account-pool/app.tsx
```

Do not reimplement OAuth refresh logic before understanding what Account Pool already provides.

## 5.4 Read before usage dashboard work

Current Arc:

```text
adnan/plugins/adnan-mission-control/server.ts
adnan/plugins/adnan-mission-control/app.tsx
adnan/plugins/adnan-mission-control/lib/data.ts
adnan/plugins/adnan-mission-control/components/usage-limits.tsx
adnan/plugins/adnan-mission-control/components/common.tsx
adnan/plugins/adnan-mission-control/PLUGIN_OVERVIEW.md
```

Current upstream BB reference:

```text
plugins/provider-usage/server.ts
plugins/provider-usage/usage-source-contract.ts
plugins/provider-usage/usage-schema.ts
plugins/provider-usage/usage-normalization.ts
plugins/provider-codex/src/usage-source.ts
plugins/provider-claude-code/src/usage-source.ts
plugins/provider-acp/src/usage-source.ts
plugins/account-pool/src/usage-source.ts
```

## 5.5 Read before OMP integration

From current OMP source/docs:

```text
README.md
docs/providers.md
docs/auth-broker-gateway.md
docs/extensions.md
```

Then locate source implementations referenced by the docs:

```text
packages/ai/src/auth-broker/
packages/ai/src/auth-gateway/
packages/coding-agent/src/cli/auth-broker-cli.ts
packages/coding-agent/src/session/auth-broker-config.ts
```

Do not implement Arc's OMP parser before verifying commands against the exact supported OMP binary.

## 5.6 Read before upstream/update work

```text
apps/desktop/README.md
apps/desktop/scripts/run-electron-builder.mjs
apps/desktop/scripts/desktop-release-channel.mjs
scripts/bump-version.mjs
.github/workflows/build-desktop.yml
.github/workflows/publish-bb-app.yml
.github/workflows/version-lockstep.yml
```

---

# 6. TARGET DIRECTORY / MODULE DESIGN

Prefer adding small focused modules rather than growing `main.ts` or Mission Control `server.ts`.

A recommended target shape:

```text
apps/desktop/src/
├── arc-runtime/
│   ├── types.ts
│   ├── paths.ts
│   ├── manifest.ts
│   ├── compatibility.ts
│   ├── verifier.ts
│   ├── bootstrap.ts
│   ├── updater.ts
│   ├── rollback.ts
│   ├── environment.ts
│   └── index.ts
│
├── main.ts
├── bb-process.ts
└── ...

apps/desktop/assets/
└── arc-runtimes/
    ├── manifest.json
    ├── licenses/
    │   ├── codex-APACHE-2.0.txt
    │   └── omp-MIT.txt
    └── darwin-arm64/
        ├── codex/
        │   └── codex
        └── omp/
            └── omp

adnan/plugins/adnan-mission-control/
├── server.ts
├── host.ts                     # only if verified supported by local SDK
├── app.tsx
├── server/
│   ├── runtime-service.ts
│   ├── account-service.ts
│   ├── usage-service.ts
│   └── schemas.ts
├── host/
│   ├── runtime-probe.ts
│   ├── omp-adapter.ts
│   └── process.ts
├── components/
│   ├── accounts.tsx
│   ├── agent-runtimes.tsx
│   ├── updates.tsx
│   └── usage-limits.tsx
└── lib/
    └── data.ts
```

This is a recommended shape, not permission to create every file blindly.

The executor must check whether the plugin SDK's `bb.host` entry and host RPC contract match the running local version before adding `host.ts`.

If the local SDK does not support this cleanly, put host-local process logic in a separate first-party Arc plugin or the appropriate BB host service instead.

---

# 7. CORE DATA MODELS

Use explicit schemas.

Do not pass anonymous `any` blobs from providers to UI.

## 7.1 Runtime identity

Use a fixed enum:

```ts
type ArcRuntimeId = "codex" | "claude-code" | "omp";
```

## 7.2 Runtime status

Conceptual shape:

```ts
interface ArcRuntimeStatus {
  id: ArcRuntimeId;
  displayName: string;

  source:
    | "arc-bundled"
    | "arc-managed-download"
    | "official-managed-install"
    | "external-override";

  state:
    | "ready"
    | "missing"
    | "installing"
    | "updating"
    | "repairing"
    | "unsupported"
    | "broken"
    | "unknown";

  executablePath: string | null;

  installedVersion: string | null;
  availableVersion: string | null;

  compatibility:
    | "supported"
    | "untested"
    | "blocked";

  previousVersion: string | null;

  canInstall: boolean;
  canUpdate: boolean;
  canRollback: boolean;

  lastCheckedAt: number | null;

  problem: string | null;
}
```

Do not expose raw secret-bearing command output.

## 7.3 Runtime manifest

Store a manifest under Arc's app-data directory, not inside the signed `.app`.

Conceptual path:

```text
~/Library/Application Support/Arc Agent/runtimes/runtime-manifest.json
```

Conceptual schema:

```json
{
  "schemaVersion": 1,
  "arcVersion": "1.x.x",
  "platform": "darwin-arm64",
  "runtimes": {
    "codex": {
      "activeVersion": "0.x",
      "previousVersion": null,
      "source": "arc-bundled",
      "digest": "sha256:...",
      "installedAt": 0
    },
    "claude-code": {
      "activeVersion": "2.x",
      "previousVersion": null,
      "source": "official-managed-install",
      "digest": null,
      "installedAt": 0
    },
    "omp": {
      "activeVersion": "18.x",
      "previousVersion": null,
      "source": "arc-bundled",
      "digest": "sha256:...",
      "installedAt": 0
    }
  }
}
```

Write atomically:

```text
write temp
fsync if appropriate
rename temp → manifest
```

Never leave a half-written JSON manifest after a crash.

## 7.4 Account presentation model

Arc UI should normalize account presentation without owning the token.

Conceptual shape:

```ts
interface ArcAccount {
  id: string;                    // Arc presentation id, non-secret
  sourceId: string;              // account-pool / omp / direct
  sourceKind: "pool" | "omp" | "direct";

  providerFamily: string;        // openai / anthropic / kimi / google / ...
  providerLabel: string;

  accountKey: string | null;     // stable quota identity if source exposes one

  email: string | null;
  label: string;
  planLabel: string | null;

  authState:
    | "connected"
    | "unauthenticated"
    | "expired"
    | "disabled"
    | "error"
    | "unknown";

  availableThrough: Array<"codex" | "claude-code" | "omp">;

  canLogin: boolean;
  canLogout: boolean;
  canEnable: boolean;
  canDisable: boolean;

  observedAt: number | null;
}
```

Important:

- `accountKey` is not an email.
- Do not derive an account key from an email.
- Null account key means "identity not safely known".
- Two null-key resources must not be merged merely because labels match.

## 7.5 Generic usage resource

Prefer the current upstream BB usage-source contract semantics.

Conceptual resource:

```ts
interface ArcUsageResource {
  sourcePluginId: string;
  resourceId: string;

  providerId: string;
  accountKey: string | null;

  label: string;

  scope:
    | { kind: "shared" }
    | { kind: "host"; hostId: string; hostName: string };

  observedAt: number | null;

  usage:
    | {
        status: "ok";
        accountEmail: string | null;
        planLabel: string | null;
        windows: ArcUsageWindow[];
      }
    | { status: "not_installed" }
    | { status: "unauthenticated" }
    | { status: "expired" }
    | { status: "error"; message: string };
}
```

Usage window:

```ts
interface ArcUsageWindow {
  id: string;

  kind:
    | "five-hour"
    | "daily"
    | "weekly"
    | "custom";

  label: string;

  usedPercent: number;

  resetsAt: string | null;

  model: string | null;

  cost: {
    usedUsdCents: number;
    limitUsdCents: number;
  } | null;
}
```

The UI can display remaining:

```text
remaining = 100 - usedPercent
```

but the source contract should keep vendor-reported **used percent** to match BB's provider usage contract.

---

# 8. PHASE 1 — INTRODUCE ARC RUNTIME PATHS WITHOUT CHANGING PROVIDER BEHAVIOR

Goal:

> Establish private Arc runtime directories and deterministic path resolution without yet downloading or switching any agent.

## Read first

```text
apps/desktop/src/main.ts
apps/desktop/src/bb-process.ts
apps/desktop/src/app-paths.ts
apps/desktop/test/*
```

## Implement

Add a focused path helper such as:

```text
apps/desktop/src/arc-runtime/paths.ts
```

Responsibilities:

- resolve Arc runtime root under Electron `userData` or a stable subdirectory;
- resolve per-runtime version directories;
- resolve current active executable path;
- resolve staging directory;
- resolve manifest path.

Example:

```text
<userData>/arc-runtimes/
├── manifest.json
├── staging/
└── runtimes/
    ├── codex/
    ├── claude-code/
    └── omp/
```

Prefer using the same root that survives app upgrades.

Do not store runtime files in:

```text
Arc Agent.app/Contents/...
```

except read-only seed assets.

## Inject Arc private executable path into the BB child process

Current desktop process roughly does:

```ts
startBbAppProcess({
  env: {
    ...process.env,
    [APP_SURFACE_ENV_NAME]: APP_SURFACE_DESKTOP
  }
})
```

Create a helper:

```ts
buildArcManagedRuntimeEnvironment(...)
```

It should:

1. preserve the existing environment;
2. prepend Arc's active runtime bin directories to child `PATH`;
3. never replace the rest of the user's PATH;
4. set explicit supported overrides where helpful, e.g. existing:

```text
BB_CLAUDE_CODE_EXECUTABLE
```

5. not put credentials in env.

Conceptual:

```text
PATH =
  <arc codex bin> :
  <arc omp bin> :
  <arc claude bin if managed> :
  <original PATH>
```

This keeps upstream provider commands such as:

```text
codex
claude
omp
```

working without global installs.

## Tests

Add unit tests proving:

- original PATH is preserved;
- Arc private path is first;
- no empty `:` segment;
- paths with spaces work;
- missing runtimes do not create invalid executable overrides;
- `BB_CLAUDE_CODE_EXECUTABLE` points only to a verified active Claude path.

## Acceptance gate

At end of Phase 1:

- no user-visible behavior changes;
- existing system-installed agents still work;
- desktop tests pass;
- no global PATH file was modified;
- no runtime has yet been downloaded.

---

# 9. PHASE 2 — ARC RUNTIME MANIFEST + COMPATIBILITY POLICY

Goal:

> Arc knows what runtime version it owns and what versions it has tested.

## Implement runtime manifest

Add:

```text
apps/desktop/src/arc-runtime/manifest.ts
apps/desktop/src/arc-runtime/types.ts
```

Requirements:

- Zod-validated;
- versioned schema;
- atomic writes;
- corruption-safe read;
- invalid manifest does not crash Arc;
- invalid manifest produces a recoverable state requiring re-probe.

## Implement compatibility policy

Add:

```text
apps/desktop/src/arc-runtime/compatibility.ts
```

Do not hardcode "always latest".

Policy should distinguish:

```text
supported
untested
blocked
```

Example concept:

```json
{
  "codex": {
    "minimum": "0.145.0",
    "testedMaximum": "0.155.x",
    "allowMajorAutoUpdate": false
  },
  "claude-code": {
    "minimum": "2.x",
    "testedMaximum": "2.x",
    "allowMajorAutoUpdate": false
  },
  "omp": {
    "minimum": "18.2.0",
    "testedMaximum": "18.x",
    "allowMajorAutoUpdate": false
  }
}
```

Do not copy these example ranges blindly.

The executor must determine actual ranges from:

- current Arc provider bridges;
- current local versions;
- focused compatibility tests.

## Version policy rule

A newly discovered vendor release is not automatically trusted just because it is newer.

Rules:

- patch/minor inside tested compatibility range may be offered;
- major or protocol-changing version becomes `untested`;
- blocked known-bad versions must never auto-activate;
- user may see an update exists while Arc says "Waiting for Arc compatibility".

## Tests

- corrupted JSON;
- missing manifest;
- unknown schema version;
- downgrade;
- unsupported version;
- blocked version;
- previous version preserved.

---

# 10. PHASE 3 — BUNDLE / MANAGE CODEX

Goal:

> A clean Mac can use Codex through Arc without system Codex installed.

## Legal / source requirement

Codex source/release is Apache-2.0.

Preserve required license/NOTICE attribution.

Do not remove OpenAI attribution from the distributed Codex component.

## Build-time source

Use official Codex release artifacts for the target platform.

For Apple Silicon the official release naming currently follows:

```text
codex-aarch64-apple-darwin.tar.gz
```

The executor must verify the exact release asset for the selected pinned version.

## Do not build from arbitrary latest during user startup

For the Arc release itself, use a pinned runtime manifest:

```json
{
  "codex": {
    "version": "...",
    "asset": "...",
    "sha256": "..."
  }
}
```

Build process must fail if:

- download fails;
- digest mismatch;
- expected executable absent;
- `codex --version` does not match pinned version.

## Seed packaging

Add a build preparation step, not an ad-hoc runtime curl in app startup.

Recommended:

```text
apps/desktop/scripts/prepare-arc-runtimes.mjs
```

Responsibilities:

- read pinned Arc runtime manifest;
- fetch exact allowed Codex release;
- verify digest;
- extract one executable;
- normalize executable name to `codex`;
- make executable;
- place into build seed folder;
- copy license attribution;
- never use an unversioned "latest" URL in production build.

## Electron packaging

Add read-only seed resources through an explicit Electron Builder `extraResources` or equivalent.

Verify actual generated config with:

```bash
node apps/desktop/scripts/run-electron-builder.mjs --print-config
```

Do not assume base config is the final config.

## First-run seed

On first Arc launch:

1. inspect Arc runtime manifest;
2. if no managed Codex active:
   - copy seed Codex to versioned Application Support runtime directory;
   - calculate digest again;
   - `chmod` executable;
   - call `codex --version`;
   - mark active only if verification passes;
3. keep app bundle unchanged.

## Codex auth

Do not invent a new Codex OAuth implementation if BB Account Pool or Codex already has one.

Support two concepts separately:

1. **direct Codex login**;
2. **Arc Account Manager / Account Pool login**.

The Arc UI may use Account Pool for multiple ChatGPT accounts.

## Codex usage

Reuse BB provider usage behavior / generic usage source.

Expected concepts already supported upstream:

- account email;
- ChatGPT plan;
- current/session window;
- weekly window;
- stable account key:
  `openai:chatgpt:<accountId>`.

Do not duplicate the ChatGPT usage endpoint logic in Mission Control.

## Tests

Clean environment test:

```text
PATH does not contain codex
Arc managed codex exists
provider health resolves Arc codex
Codex model listing works
```

Do not require live account credentials in unit tests.

Use fixtures for auth/usage normalization.

## Acceptance gate

On a test Mac with system Codex absent:

```bash
command -v codex
```

may return nothing in a normal shell.

But inside Arc:

```text
Codex runtime: Ready
```

and Arc's provider bridge uses Arc's private executable.

---

# 11. PHASE 4 — BUNDLE / MANAGE OMP

Goal:

> OMP is a first-class Arc-managed agent runtime and does not require Bun or a global OMP install.

## Legal / source requirement

OMP is MIT licensed.

Include its required MIT notice.

## Use official standalone binary

Current OMP releases provide standalone platform binaries such as:

```text
omp-darwin-arm64
```

Use a pinned version and pinned digest in the Arc runtime seed manifest.

Do not require Bun on the user's machine.

## Packaging

Use same framework as Codex:

```text
build seed
→ verify digest
→ package seed
→ copy to Application Support
→ verify --version
→ activate
```

Do not create separate one-off downloader logic if the generic runtime manager can handle it.

## Provider launch

Current ACP provider generally launches:

```text
omp acp
```

Do not rename provider ID.

Keep:

```text
acp-omp
```

Arc private PATH should make the `omp` command resolve to Arc's managed binary.

## OMP config isolation decision

Very important:

Arc must decide whether its OMP should share the user's external OMP configuration or use an Arc-specific config root.

Recommended default:

> Arc-managed OMP gets an Arc-specific configuration/data location.

Reason:

- prevents external `omp` upgrades/config from breaking Arc;
- prevents Arc from modifying user's standalone OMP unexpectedly;
- makes uninstall/update behavior deterministic.

Before implementing this, verify the exact current OMP config/environment variables from OMP source/docs.

Do not guess.

Potential variables must be verified against current OMP, such as config/data directory variables.

## Migration/import UX

If standalone OMP is already installed and has accounts/config, Arc can later offer:

```text
Import existing OMP configuration
```

This is optional and must not be automatic in the first implementation.

## Tests

- system OMP absent;
- Bun absent;
- Arc-managed OMP `--version`;
- `omp acp` can be probed by BB provider-acp;
- OMP config directory is Arc-owned;
- restart preserves account/config state.

---

# 12. PHASE 5 — CLAUDE CODE MANAGED SETUP

Goal:

> User never needs Terminal to install Claude Code, while Arc stays legally safe.

## Important licensing rule

Claude Code is not MIT/Apache in its current repository.

The repository states:

```text
© Anthropic PBC. All rights reserved.
Use subject to Anthropic Commercial Terms.
```

Therefore do **not** bundle a copied Claude executable in Arc distribution unless redistribution rights are explicitly confirmed.

## Required user experience

Arc can still present:

```text
Claude Code
Setting up…
```

and perform official setup automatically.

The user should not manually paste a shell command.

## Use official Anthropic distribution path

Current official macOS/Linux setup uses Anthropic's installer.

The executor must verify:

- current official installer URL;
- whether installer supports a custom install destination;
- whether it supports non-interactive install;
- how updates work;
- how `claude doctor` reports install source;
- whether the install can be kept inside Arc's app-data directory.

### Decision gate

If official installer supports custom prefix:

- install into Arc-managed runtime directory;
- set `BB_CLAUDE_CODE_EXECUTABLE` to exact path.

If official installer does **not** support safe custom prefix:

- use Anthropic's supported user-local installation location;
- still invoke it through Arc;
- record source as `official-managed-install`;
- use `BB_CLAUDE_CODE_EXECUTABLE` to point BB at the verified executable;
- clearly distinguish this from Arc-bundled runtimes.

Do not hack-copy proprietary installed files into Arc package.

## Safer installer execution

Do not blindly execute arbitrary network text.

Preferred flow:

1. fetch official installer from allowlisted HTTPS URL;
2. verify response and origin;
3. save to a temporary file;
4. execute with explicit shell/process;
5. capture redacted output;
6. verify resulting binary path;
7. run:

```bash
claude --version
claude doctor
```

8. mark ready only after health passes.

## Existing BB integration

Current BB provider supports:

```text
BB_CLAUDE_CODE_EXECUTABLE
```

Prefer using this instead of deeply forking Claude provider path resolution.

## Claude auth

Use Arc UI over existing supported auth/account mechanisms.

Do not copy raw Claude credentials into Arc plugin KV.

## Claude usage

Reuse provider/account-pool usage implementation.

Expected concepts:

- account email where exposed;
- plan;
- five-hour usage;
- weekly usage;
- model-scoped weekly limits if returned;
- stable account key:
  `anthropic:account:<accountUuid>`.

## Acceptance gate

Fresh machine:

- no preinstalled Claude required;
- user presses a UI setup/connect action;
- Arc performs official setup;
- Arc verifies it;
- user signs in without manually running shell commands;
- Claude agent can create a BB/Arc thread.

---

# 13. PHASE 6 — ARC AGENT MANAGER SERVICE

Goal:

> Give UI one stable Arc contract instead of teaching it every CLI.

Implement an internal Arc service/adapter layer.

Conceptual interface:

```ts
interface ArcAgentManager {
  listRuntimes(): Promise<ArcRuntimeStatus[]>;

  checkRuntime(id: ArcRuntimeId): Promise<ArcRuntimeStatus>;

  installRuntime(id: ArcRuntimeId): Promise<ArcRuntimeStatus>;

  updateRuntime(id: ArcRuntimeId): Promise<ArcRuntimeStatus>;

  repairRuntime(id: ArcRuntimeId): Promise<ArcRuntimeStatus>;

  rollbackRuntime(id: ArcRuntimeId): Promise<ArcRuntimeStatus>;
}
```

Account/usage are separate:

```ts
interface ArcAccountManager {
  listAccounts(): Promise<ArcAccount[]>;

  beginLogin(source: string, provider: string): Promise<...>;

  continueLogin(...): Promise<...>;

  logout(accountId: string): Promise<void>;

  enable(accountId: string): Promise<void>;

  disable(accountId: string): Promise<void>;
}
```

Usage:

```ts
interface ArcUsageRegistry {
  listResources(): Promise<...>;
  getResource(...): Promise<...>;
}
```

## Why separate services

Do not create:

```text
ArcEverythingManager
```

Runtime state, credentials, and quota data have different lifecycle/security requirements.

---

# 14. PHASE 7 — REUSE ACCOUNT POOL FOR CODEX + CLAUDE

Goal:

> Arc provides polished multi-account management for ChatGPT and Claude without rewriting BB's working backend.

## Read Account Pool fully first

Particularly understand:

- account secret storage;
- metadata storage;
- login flows;
- usage refresh;
- routing;
- enable/disable;
- ordering;
- provider environment contribution.

## Keep Account Pool internal name hidden from normal users

User-facing text:

```text
AI Accounts
```

not:

```text
Account Pooler
```

Internal plugin can remain `account-pool`.

## Required Arc UI operations

For ChatGPT and Claude accounts:

- add account;
- login;
- show connected account;
- show email where available;
- show plan;
- enable;
- disable;
- reorder/priority if multiple;
- remove/logout;
- refresh usage;
- show last usage observation;
- show last used if backend provides it.

## Do not force pooled routing by default without a deliberate product choice

Account inventory and usage visibility should not automatically mean all Codex/Claude traffic is rerouted through Account Pool.

Separate:

```text
Connected accounts
```

from:

```text
Routing behavior
```

The user should know if Arc is using pooled routing.

For Arc v1, choose a simple default and document it.

Recommended:

- direct single account can work normally;
- Arc Accounts can opt into pooled/multi-account routing;
- do not silently rotate accounts merely to evade service limits.

---

# 15. PHASE 8 — OMP ACCOUNT ADAPTER

Goal:

> Arc can show/manage OMP-backed provider accounts without knowing every provider's internals.

## Do not create vendor-specific Arc services

Do not create:

```text
KimiService
GeminiService
QwenService
DeepSeekService
OpenRouterService
...
```

Create one:

```text
OmpAccountAdapter
```

OMP owns provider-specific logic.

## First verify exact current machine-readable interfaces

Using the exact Arc-managed OMP version, run safe commands and redact output.

At minimum investigate:

```bash
<arc-omp> auth-broker list --json
<arc-omp> auth-broker status --json
<arc-omp> usage --json
```

Also inspect current source/docs for:

```text
/v1/snapshot
/v1/usage
/v1/credentials/check
```

Determine which interface gives:

- registered auth providers;
- actual connected credentials;
- credential/account identity;
- auth state;
- usage;
- plan;
- reset times.

Do not assume `auth-broker list --json` means "connected accounts"; docs describe it as registered OAuth provider enumeration.

## Recommended Arc v1 implementation strategy

Prefer direct local CLI/API calls through a host-side adapter.

Do not expose an OMP broker listener on LAN.

If a broker service is required:

- bind only to `127.0.0.1`;
- use OMP's bearer token;
- never send token to renderer;
- start/stop under Arc supervision;
- use strict timeout;
- record process ownership;
- no `0.0.0.0`.

## OMP login UI

Arc UI may show:

```text
+ Add AI Account
```

Then fetch discoverable OMP providers.

Examples may include:

```text
Anthropic
OpenAI Codex
Google Gemini CLI
Google Antigravity
Kimi / Moonshot
GitHub Copilot
Z.AI
...
```

Do not hardcode this entire list if OMP can enumerate it.

Hardcode only display enhancements/icons for known providers; source of truth for availability remains OMP.

## Login process

For each OMP provider:

- request OMP to start its official provider login flow;
- open browser externally if URL is returned;
- show device code/callback status if required;
- poll only as required by the flow;
- never make Arc capture user password;
- never send provider secret through renderer.

## Logout

Use OMP's provider/account logout mechanism.

If current OMP supports only logout-by-provider and multiple credentials per provider, reflect that limitation honestly in UI until OMP exposes a more granular API.

---

# 16. PHASE 9 — PORT / ADOPT GENERIC USAGE SOURCE REGISTRY

Goal:

> Adding a new usage-capable account/source does not require editing Mission Control's dashboard logic.

The current Arc Mission Control model:

```text
direct[]
pool[]
```

was correct for Phase 6 of the plugin, but it is now too narrow.

## Preferred base

Port/adopt current upstream BB's generic usage source pattern.

Core RPC names:

```text
provider-usage.v1.listResources
provider-usage.v1.getResource
```

Do not invent an incompatible second protocol unless local BB version makes the upstream one impossible.

## Required semantics

`listResources`:

- cheap;
- metadata only;
- no vendor quota refresh;
- returns stable source-local IDs;
- returns accountKey when safely known;
- returns host/shared scope.

`getResource`:

- exactly one resource;
- can use cache;
- `refresh: true` asks source for a fresh attempt;
- does not refresh every account;
- preserves `observedAt`;
- usage/auth errors are data states.

## Port provider usage sources

When local provider plugins support them:

- Codex source;
- Claude source;
- Account Pool source;
- ACP source where applicable.

## Add OMP source

Arc's OMP adapter should expose the same generic usage-source contract.

One OMP provider/credential may become one resource.

Example conceptual resources:

```text
OMP / Kimi account
OMP / OpenAI-Codex account
OMP / Anthropic account
OMP / Gemini account
```

Do not show OMP as one giant usage card if underlying providers have separate quotas.

---

# 17. USAGE DEDUPLICATION

This is important.

A single ChatGPT account might appear through:

```text
Direct Codex
Account Pool
OMP openai-codex
```

The user should not necessarily see the same quota three times.

## Safe rule

Deduplicate only when there is a stable trustworthy quota identity:

```text
(provider family, accountKey)
```

Examples BB can expose:

```text
openai:chatgpt:<accountId>
anthropic:account:<accountUuid>
```

If OMP exposes the same underlying provider account identity reliably, normalize to the same canonical account key.

If OMP only exposes:

```text
email
display label
local credential row id
```

do **not** assume equivalence.

Display separately until a trustworthy mapping exists.

## Preferred source when duplicates exist

Follow upstream BB concept:

- shared account source can replace duplicate host-direct presentation;
- or choose a deterministic source priority;
- retain all source links internally for "Available through" badges.

Example UI:

```text
ChatGPT Plus
adnan@example.com

Available through:
[Codex] [OMP]

5h       24% used
Weekly   51% used
```

instead of three identical cards.

---

# 18. PHASE 10 — REDESIGN MISSION CONTROL NAVIGATION

Current tabs:

```text
Overview
Agents
Roles
Approvals
Verification
Usage & Limits
```

Target:

```text
Overview
Agents
Accounts
Roles
Approvals
Verification
Usage & Limits
Updates
```

Do not remove existing functionality.

## Agents tab target

This tab currently shows thread hierarchy.

Do not destroy that.

Recommended structure:

```text
Agents
├── Runtime status summary
└── Live thread tree
```

or add a sub-section.

Show exactly:

```text
Codex       Ready     v...
Claude Code Ready     v...
OMP         Ready     v...
```

Actions:

```text
Manage
Repair
Update
Rollback (when available)
```

## Accounts tab

Show account-centric view.

Example:

```text
ChatGPT
adnan@example.com
Plus
Connected
Available through: Codex, OMP

Claude
adnan@example.com
Max
Connected
Available through: Claude Code, OMP

Kimi
...
Connected
Available through: OMP
```

Buttons only when supported:

```text
Add account
Sign in
Sign out
Enable
Disable
Refresh
```

## Usage & Limits tab

Make it source-agnostic.

Show:

- provider/account;
- plan;
- usage windows;
- remaining or used percentage;
- reset time;
- model-specific scope;
- stale state;
- refresh error;
- account source details only in secondary UI.

Do not organize primarily as:

```text
Direct Providers
Pooled Accounts
```

Those are implementation details.

Prefer:

```text
Accounts / Capacity
```

## Updates tab

Show:

```text
Arc Agent       1.x          Up to date
BB base         0.x / commit informational only

Codex           0.x          Update available
Claude Code     2.x          Up to date
OMP             18.x         Update available
```

BB base row is **not** user-updateable.

It is informational:

```text
Arc 1.4 is based on BB <version/commit>
```

---

# 18A. PHASE 10.1 — AUTHENTICATION + ACCOUNTS + USAGE STABILIZATION

This phase was added after real testing of the installed Phase 10 application exposed integration problems that unit/dev checks did not fully catch.

Phase 11 must **not** begin until Phase 10.1 passes in the installed `/Applications/Arc Agent.app`.

## Goal

Make all real account connection flows stable, truthful, and usable, and make provider/account usage actually reach the UI.

The following are release-blocking Phase 10.1 defects:

```text
ChatGPT login dialog repeatedly remounts / flickers
Claude browser returns an authentication code but Arc asks for a callback URL
OMP/Kimi device-code flow opens/authorizes but Arc does not reliably complete
Usage / limits do not appear after accounts are connected
```

## Stable login-session architecture

Login state must be owned separately from account-list and usage-query state.

Do not implement login as:

```text
dialog renders
→ useEffect starts login
→ account refresh rerenders
→ effect starts another login
```

Use explicit user intent instead:

```text
user clicks Connect
→ create exactly one login session
→ dialog renders that session state
→ background account refreshes may continue
→ login session remains mounted until success / cancel / timeout / error
```

Required states:

```text
idle
starting
waiting-for-user
polling / waiting-for-authorization
completing
connected
error
expired
cancelled
```

Requirements:

- one explicit click creates at most one backend login attempt;
- account refresh must not recreate the login session;
- usage refresh must not restart authentication;
- closing the dialog must not immediately start another attempt;
- cancellation must propagate to the backend where supported;
- timeout / expiry must become visible UI states;
- retries create a new deliberate session;
- do not persist transient authorization codes.

## ChatGPT / Codex login

Arc currently uses Codex device authorization for ChatGPT-backed accounts.

The UI must handle the real provider result, including the case where ChatGPT security settings have device-code authorization disabled.

Expected UX:

```text
Connect ChatGPT

Starting…
Open OpenAI authorization page
Waiting for authorization…
Connected
```

If device-code login is disabled by the account, show a clear actionable error rather than looping or flickering.

Do not call `arc.accounts.connectChatGPT` repeatedly due to renders or query invalidations.

## Claude Code login

The Arc-managed Claude Code version's actual login protocol must be treated as authoritative.

Do not assume a browser callback-URL flow if the managed Claude CLI returns a manual authentication code flow.

If the real CLI flow is:

```text
open Anthropic authorization page
→ user signs in
→ Anthropic displays one-time authentication code
→ user pastes code into Claude Code / Arc
→ backend completes login
```

then Arc must render exactly that.

Target UI:

```text
Connect Claude

[Open Anthropic Sign-In]

After signing in, Anthropic will show an authentication code.

Authentication code
[____________________________]

[Complete Sign-In]
```

Remove misleading `Paste callback URL` UI if the managed Claude runtime does not use that protocol.

Security:

- never ask for the Claude password;
- never persist the one-time code;
- never expose PKCE verifier/access token/refresh token to renderer state;
- clear the entered one-time code immediately after submit.

## OMP provider authentication

OMP authentication is provider-specific. Do not force every provider into one hardcoded OAuth UI.

Arc must inspect the managed OMP auth-broker's returned login mode and render the corresponding UI dynamically.

Supported conceptual classes include:

```text
OAuth browser callback
device-code + polling
browser + manual code
API key
```

For device-code providers such as Kimi Code, Arc should support:

```text
start login exactly once
→ receive verification URL + user code
→ prefer verification_uri_complete when supplied
→ otherwise open verification_uri and show the code
→ show Waiting for authorization…
→ poll / await broker completion
→ refresh connected account snapshot
→ display Connected
```

Do not normalize a verification URL into a generic provider homepage or strip required query parameters.

If authorization expires:

```text
Authorization expired
[Try Again]
```

For API-key providers:

```text
input → backend → OMP stdin / supported broker API → clear input
```

Arc must not persist the API key itself.

## Usage / limits end-to-end trace

After at least one account/provider is connected, trace the full path instead of patching only the renderer:

```text
connected account
→ canonical account identity
→ underlying usage source
→ ArcUsageResource normalization
→ arc-core RPC
→ Mission Control dashboard / thread popup
```

Inspect separately:

```text
Codex / ChatGPT
Claude Code / Claude
OMP providers
```

For every connected account determine:

```text
accountKey
sourceKind
provider family
usage source response
normalized resources
arc.usage.snapshot result
current-agent/thread filtering result
rendered UI state
```

The Account Pool usage path should use the bundled provider-usage contract.

OMP should use the managed auth-broker usage endpoint where supported.

Important:

- valid usage must not be hidden merely because the active account cannot be proven;
- when active account is unknown, say `Active account unknown`;
- when provider does not expose limits, say `Usage limits not exposed by provider`;
- a fetch failure with last-good data must render stale data, not blank content;
- `UNKNOWN != ZERO`;
- do not merge identities by email.

## Required regression tests

At minimum:

```text
ChatGPT connect click → one backend login call
account refresh does not remount login dialog
ChatGPT error / timeout / success states
Claude one-time-code input exists when required by managed CLI
Claude callback-URL input absent when not part of managed CLI protocol
Claude code submitted once and cleared
OMP device-code URL + code + polling / wait lifecycle
OMP expiry → retry
OMP API-key input clears and is not persisted
usage resource may render without a provable active-account mapping
not exposed != 0
stale last-good remains visible
partial usage-source failure does not blank dashboard
usage refresh does not restart login
```

## Packaged-app gate

Do not declare Phase 10.1 PASS from dev Electron alone.

Required proof:

```text
build Arc Agent.app
install over /Applications/Arc Agent.app
preserve ~/.bb
launch installed app
perform real browser-assisted auth manually where user authorization is required
verify Accounts + Usage in installed app
```

Do not delete the user's real `~/.bb` to make tests pass.

---

# 18B. PHASE 10.2 — PER-THREAD ACCOUNT SELECTION

This phase is required because account inventory alone is insufficient when a user has multiple accounts for the same agent.

Example:

```text
ChatGPT account A
ChatGPT account B
```

Without an explicit per-thread account binding, the user cannot reliably know which subscription / quota / identity is executing a Codex thread.

Phase 11 must **not** begin until Phase 10.2 passes.

## Goal

Extend the normal thread/composer selection model from:

```text
Agent
Model
```

to:

```text
Agent
Model
Account
```

Examples:

```text
Agent:   Codex
Model:   GPT-5.6
Account: Personal ChatGPT
```

```text
Agent:   Claude Code
Model:   Claude Opus
Account: Work Claude
```

```text
Agent:   OMP
Model:   Kimi
Account: Kimi Code
```

## Account selector behavior

For **new threads**, allow:

```text
Account: Auto
```

`Auto` resolves once, at first execution, to the highest-priority enabled compatible account.

Immediately persist the resolved concrete account binding.

After a thread starts:

- changing global account priority must not silently change that thread;
- quota exhaustion must not silently switch that thread;
- account removal/disable must produce a visible blocked/warning state;
- user must explicitly choose a replacement account.

Do not implement automatic quota-based fallback in this phase.

## Per-agent sources

Codex selector:

```text
connected ChatGPT / OpenAI accounts from ArcAccountService
```

Claude selector:

```text
connected Claude / Anthropic accounts from ArcAccountService
```

OMP selector:

```text
connected OMP provider accounts compatible with the selected provider/model
```

Do not show unrelated OMP credentials for a model/provider that cannot use them.

## Identity rules

Renderer may send only a safe account identifier such as:

```text
accountKey
```

The backend resolves that identifier to the underlying credential owner.

Never send to the renderer:

```text
access token
refresh token
API key
credential file / JSON
OMP broker token
PKCE verifier
cookie
```

Do not match accounts by email.

Use canonical provider-issued identity rules from Arc Account Service.

## Persistence

Persist a thread-level account binding.

Conceptually:

```text
threadId
agentId
providerId
modelId
accountKey
```

Do not store credentials in the thread record.

Reopening the thread must restore the same account selection.

Historical threads with no account binding must display:

```text
Account: Unknown / legacy
```

Do not infer a historical account from email, priority, or current credentials.

## Execution contract

When starting/resuming agent execution, pass the selected account identity through an explicit safe contract.

The account choice must reach the actual runtime / account backend used for that execution; a visual selector that does not affect runtime credential selection is not acceptable.

If the underlying provider cannot honor an explicit account choice, report that clearly and do not pretend it did.

## Thread UI

Add a visible account selector / indicator near the agent/model controls.

Example:

```text
Codex · GPT-5.6
Personal ChatGPT
```

The user must be able to distinguish two accounts with the same provider.

Use safe labels such as account email/display name/plan when available.

## Mission Control

Live thread/agent details should expose:

```text
Agent
Model
Provider
Account
```

Account should be the concrete bound account when known.

## Usage binding

The small in-thread Usage & Limits popup must use the selected thread account.

Rules:

```text
known selected account + usage available → show that account only
known selected account + provider not exposed → Not exposed by provider
unknown / legacy account → Active account unknown
```

Do not mix multiple connected ChatGPT accounts into a single thread usage popup.

The full Usage & Limits dashboard may still show all accounts.

## Required tests

At minimum:

```text
2 ChatGPT accounts → selector shows both
priority chooses default for a new thread
explicit selection overrides priority
resolved account persists per thread
changing priority does not alter existing thread
disabled selected account blocks execution / asks for reselection
removed selected account blocks execution / asks for reselection
usage popup uses selected account only
renderer receives no secret credentials
historical thread with no binding → Unknown / legacy
OMP account list filtered to compatible provider/model
restart restores account binding
```

## Installed-app proof

Use a real two-account test when available:

```text
Thread A
→ Codex
→ same model
→ ChatGPT account A
→ execute
→ confirm account A is bound

Thread B
→ Codex
→ same model
→ ChatGPT account B
→ execute
→ confirm account B is bound

restart Arc
→ both threads retain their original account binding
```

Do not declare PASS based only on component tests.

---

# 19. PHASE 11 — RUNTIME UPDATE ENGINE

## Entry gate

Do not start Phase 11 until **Phase 10.1** and **Phase 10.2** both pass against the installed packaged application.

That means:

```text
real account login flows are stable
Claude login matches managed CLI protocol
OMP device-code flow completes
usage / limits render truthfully
multiple accounts can be selected explicitly per thread
thread account binding persists
```

Goal:

> Update Codex/Claude/OMP safely without replacing Arc itself.

## Runtime update flow

For Codex and OMP:

```text
discover approved update
        ↓
check Arc compatibility policy
        ↓
download into staging
        ↓
verify allowed source
        ↓
verify digest/signature if available
        ↓
make executable
        ↓
run --version
        ↓
run runtime-specific health smoke
        ↓
move into version directory
        ↓
atomically update active manifest/current pointer
        ↓
keep previous version
```

If any step fails:

```text
leave current runtime untouched
```

## Rollback

Keep at least:

```text
active version
previous known-good version
```

Rollback must:

- not redownload if previous binary is present;
- validate previous before activation;
- update manifest atomically;
- restart/probe affected provider if necessary.

## Never let self-updaters silently modify Arc-managed runtime

If vendor CLI has a self-update command, Arc should not run it against its managed binary unless that path is proven to preserve versioned rollback.

Prefer Arc-managed staged downloads.

For Claude, follow official supported updater/install behavior because distribution is proprietary.

## Update frequency

Do not check every minute.

Reasonable:

- app launch after cooldown;
- user manual "Check for updates";
- perhaps daily background metadata check.

Do not perform binary install automatically in middle of an active thread.

## Active-thread guard

Before activation of new agent runtime:

- detect active threads using that provider;
- if active, defer activation;
- allow download/staging if safe;
- activate after provider idle/restart boundary.

---

# 20. PHASE 12 — ARC APPLICATION UPDATE CHANNEL

Goal:

> Arc updates come only from Arc, never directly from BB.

## Current danger to verify

The Arc fork has already modified upstream update behavior.

However base Electron config may still contain BB publish metadata.

The executor must inspect final generated config, not only source.

Run:

```bash
node apps/desktop/scripts/run-electron-builder.mjs --print-config
```

Search output for:

```text
get-bb/bb
desktop-latest
dev.bb.desktop
bb Nightly
```

For production Arc, none of these should remain where they control Arc identity/update channel.

## Create Arc release identity

Choose final values with user approval.

Example placeholders:

```text
applicationName: Arc Agent
applicationName nightly: Arc Agent Nightly
appId stable: <Arc-specific bundle id>
appId nightly: <Arc-specific nightly bundle id>
releaseTag stable: arc-desktop-latest
releaseTag nightly: arc-desktop-nightly
```

Do not permanently use example bundle IDs without user approval if a proper domain/company ID will be used later.

## Arc update URLs

Point only at Arc-controlled release artifacts.

For example the Arc fork/release repository, not:

```text
https://github.com/get-bb/bb/releases/...
```

## Arc version

Arc has its own product version.

Track BB provenance separately:

```text
Arc version: 1.3.0
BB base: 0.4x.x
BB upstream commit: <sha>
```

Do not make user-facing Arc version equal to upstream BB version forever.

## About screen

Show:

```text
Arc Agent 1.3.0
Core based on BB <version>
BB upstream commit <short sha>
Codex <version>
Claude Code <version>
OMP <version>
```

This makes support/debugging much easier.

---

# 21. PHASE 13 — BB UPSTREAM SYNC WORKFLOW

Goal:

> Continue receiving useful BB improvements without allowing BB to overwrite Arc.

## Git remote model

Expected:

```text
origin    → Arc fork
upstream  → get-bb/bb
```

If `upstream` is missing:

```bash
git remote add upstream https://github.com/get-bb/bb.git
```

Do this only after checking existing remotes.

## Never auto-merge upstream into production

Use:

```text
arc/main
      ↑
sync/bb-<date-or-version>
      ↑
upstream/main
```

Workflow:

1. fetch upstream;
2. create dedicated sync branch;
3. compare changes;
4. identify Arc-owned files touched;
5. merge/rebase deliberately;
6. resolve conflicts;
7. run Arc invariant tests;
8. run full relevant suite;
9. package clean-room Arc;
10. only then merge into Arc release branch.

## Arc-owned / high-risk files

Always review manually when upstream modifies:

```text
apps/desktop/scripts/desktop-release-channel.mjs
apps/desktop/scripts/run-electron-builder.mjs
apps/desktop/electron-builder.config.json
apps/desktop/src/main.ts
apps/desktop/src/bb-process.ts

apps/desktop/src/arc-runtime/**

adnan/plugins/adnan-mission-control/**

plugins/provider-codex/**
plugins/provider-claude-code/**
plugins/provider-acp/**
plugins/provider-usage/**
plugins/account-pool/**

apps/server/src/services/system/usage-limits.ts
packages/plugin-sdk/**
packages/agent-runtime/**
```

## Add automated Arc invariants

Create something like:

```text
scripts/check-arc-invariants.mjs
```

It should fail CI if:

- product name reverts to BB;
- stable Arc update URL points to `get-bb/bb`;
- bundle ID reverts unintentionally;
- required Arc runtime bootstrap hook disappears;
- managed runtime PATH injection disappears;
- Mission Control plugin isn't present/buildable;
- provider IDs expected by Arc disappear without migration;
- OMP provider disappears from Arc target provider set;
- Arc release feed is not Arc-owned.

This converts "remember not to lose the rebrand" into executable protection.

---

# 22. PHASE 14 — ACCOUNT + USAGE REFRESH POLICY

Do not hammer providers.

## UI countdown

A timer such as 30 seconds may update only text like:

```text
resets in 4h 12m
```

It must not automatically call vendor usage endpoint every 30 seconds.

## Data refresh

Use:

- source caching;
- manual refresh;
- refresh when Usage tab becomes active if stale;
- refresh after thread completion if source architecture supports invalidation;
- safe minimum age.

Current upstream provider usage uses explicit caching and source discovery.

OMP itself has usage caching designed to avoid provider throttling.

Respect that.

## Last-good behavior

Store/preserve:

```text
observedAt
```

If refresh fails:

```text
Last updated 12m ago
Refresh failed
```

not blank and not zero.

---

# 23. PHASE 15 — SECURITY MODEL

This phase is not optional.

## 23.1 Credential ownership

Use this model:

```text
Arc UI
  ↓
Adapter
  ↓
Provider-owned secure store
```

Examples:

- Codex credentials remain Codex / Account Pool owned.
- Claude credentials remain Claude / Account Pool owned.
- OMP credentials remain OMP auth storage/broker owned.

Arc Mission Control KV stores metadata only.

## 23.2 File permissions

For Arc-managed sensitive local directories:

```text
directories: 0700
secret files: 0600
```

Do not make bearer tokens world-readable.

## 23.3 Logging

Never log:

```text
Authorization header
refresh token
access token
API key
full auth.json
OMP broker token
Claude keychain raw output
```

If a subprocess fails:

- record exit code;
- record sanitized reason;
- redact known token patterns;
- do not dump complete environment.

## 23.4 Download allowlist

Runtime updater may download only from configured trusted vendor/Arc domains.

Do not accept an arbitrary runtime download URL from renderer input.

Renderer sends:

```text
runtimeId = "omp"
action = "update"
```

Backend decides trusted source.

## 23.5 OMP broker

If Arc runs local OMP auth broker:

```text
bind 127.0.0.1 only
```

No LAN listener.

Keep bearer token outside renderer.

## 23.6 Renderer trust

Renderer must never receive:

- raw provider access tokens;
- refresh tokens;
- OMP broker bearer token;
- Claude credential file contents;
- Codex auth file contents.

---

# 24. PHASE 16 — CLEAN MACHINE / CLEAN ENVIRONMENT TEST HARNESS

This is essential because developer machines already have tools installed.

A product that works only because the developer has `codex`, `claude`, and `omp` in PATH is not complete.

## Build a deterministic clean test

At minimum simulate:

```text
fresh HOME / app data
PATH without codex/claude/omp
no ~/.omp
no ~/.claude
no Codex auth
```

Do not destroy the developer's real HOME.

Use a temporary isolated environment.

## Packaging test must prove

From packaged Arc:

- seed Codex exists;
- seed OMP exists;
- licenses exist;
- Arc runtime bootstrap copies them;
- binary digest matches;
- binary version probe succeeds;
- BB child environment resolves them;
- system PATH copy is not required.

## Claude clean path

Test official managed install separately because it may require network/auth.

Required proof:

- UI can trigger installation/setup;
- resulting Claude is discovered by Arc;
- no Terminal command required from user.

---

# 25. PHASE 17 — END-TO-END ACCOUNT TEST MATRIX

Use test accounts only where allowed.

Never put credentials in repository fixtures.

## Codex direct

Test:

- unauthenticated;
- login;
- ready;
- expired state fixture;
- usage available;
- reset timestamps;
- restart persistence.

## Codex Account Pool

Test:

- add account;
- multiple accounts;
- enable/disable;
- priority/order;
- usage per account;
- account removal;
- routing toggle behavior.

## Claude direct

Same categories.

## Claude Account Pool

Same categories.

## OMP

Test at least:

- one OAuth provider;
- one API-key provider if supported;
- one provider with usage;
- one provider without usage;
- disconnected/expired;
- logout;
- restart persistence.

## Account UI rule

Every account card must make clear:

- provider;
- account identity if known;
- plan if known;
- connected state;
- what agent(s) can use it;
- usage availability.

---

# 26. PHASE 18 — USAGE DASHBOARD TEST MATRIX

Test these exact cases.

## Case A — healthy Codex

Expected:

```text
ChatGPT plan
email if exposed
5h/session usage
weekly usage
reset
```

## Case B — healthy Claude

Expected:

```text
Claude plan
5h
weekly
model-specific weekly if exposed
```

## Case C — OMP Kimi/other provider with usage

Expected:

- provider card appears automatically through OMP usage source;
- no Mission Control hardcoded Kimi branch required.

## Case D — provider connected but no quota API

Expected:

```text
Connected
Usage unavailable
```

No fake zero.

## Case E — transient refresh failure with old observation

Expected:

```text
Last updated ...
Could not refresh
```

Old real data stays visible.

## Case F — duplicate account with canonical account key

Expected:

one user-facing account/capacity card, with multiple "Available through" badges.

## Case G — duplicate-looking email but no canonical key

Expected:

do not merge automatically.

## Case H — expired auth

Expected:

```text
Session expired
Reconnect
```

## Case I — runtime missing/broken

Expected:

usage card/runtime card says unavailable/broken.

Do not mislabel as quota exhausted.

---

# 27. PHASE 19 — ROLE ROUTER INTEGRATION

Do not implement automatic quota-driven rerouting in first version.

But prepare the data model so role UI can show warnings.

Example:

```text
PLAN
OMP → GPT model
Weekly capacity: low
```

No automatic model switching initially.

Later, a deliberate feature could support:

```text
preferred role route
fallback route
minimum remaining threshold
```

But that changes execution behavior and must be designed separately.

For this project scope:

- keep current role mappings;
- ensure managed provider IDs/model catalogs still resolve;
- show account/usage health as advisory metadata only.

---

# 28. PHASE 20 — FIRST-RUN ONBOARDING

Target screen:

```text
Welcome to Arc

Preparing your coding agents…

Codex       ✓ Ready
OMP         ✓ Ready
Claude Code ○ Setup required

[Continue]
```

Then:

```text
Connect accounts

ChatGPT      [Connect]
Claude       [Connect]

More AI providers through OMP
[Configure]
```

Rules:

- never block Arc completely because optional provider login is absent;
- Codex and OMP runtime readiness is different from account readiness;
- Claude runtime setup is different from Claude account login;
- explain failures in user language.

Bad:

```text
ENOENT spawn claude
```

Good:

```text
Claude Code could not be prepared.
Retry setup
View diagnostics
```

---

# 29. PHASE 21 — DIAGNOSTICS

Add a safe diagnostics view/export.

Include:

```text
Arc version
BB base version/commit
OS / architecture
runtime states
runtime versions
runtime executable source (Arc-managed / official / external)
provider health
plugin versions
usage source health
last usage observation timestamps
```

Exclude:

```text
tokens
API keys
auth files
OAuth codes
full environment
```

A "Copy diagnostics" button must use sanitized data.

---

# 30. PHASE 22 — BUILD / RELEASE CHANGES

## Arc runtime seed manifest

The build repository must contain a pinned manifest with:

- runtime name;
- version;
- target platform;
- exact asset;
- digest;
- upstream project;
- license identifier.

## CI

CI build sequence should include:

```text
install dependencies
build BB/Arc
prepare pinned runtimes
verify runtime digests
build Mission Control
typecheck
tests
package Electron
inspect package
run clean packaged smoke
sign/notarize
publish Arc release
publish Arc updater metadata
```

## Never fetch "latest" invisibly during production package assembly

The build may have a maintenance command to update pinned versions, but the committed runtime manifest determines what goes into a release.

This ensures reproducibility.

---

# 31. PHASE 23 — ARC UPDATE UI

Target:

```text
Settings → Updates

Arc Agent
1.3.0
Up to date

Core
BB 0.xx @ abc1234
Managed by Arc release
(no update button)

Agents

Codex
0.xxx
Update available
[Update]

Claude Code
2.x
Up to date

OMP
18.x
Update available
[Update]

[Check for updates]
```

Optional:

```text
Auto-update compatible agent runtimes
```

Default should be conservative until rollback is mature.

Do not update agent runtime while it has active threads.

---

# 32. PHASE 24 — ROLLBACK TEST

For each Arc-managed binary runtime:

1. install known version A;
2. stage version B;
3. activate B;
4. verify;
5. force a simulated post-activation failure;
6. rollback to A;
7. verify provider works;
8. verify manifest says A active, B not active;
9. verify account credentials were untouched.

Runtime rollback must never delete account stores.

---

# 33. PHASE 25 — UNINSTALL / REINSTALL BEHAVIOR

Decide and document data retention.

Recommended:

Removing Arc application itself should not silently destroy:

- account credentials;
- project metadata;
- runtime state;
- OMP config;
- Mission Control state.

Provide a deliberate future "Reset Arc" action for full cleanup.

Reinstalling/updating Arc should reuse valid managed runtimes and accounts where compatible.

---

# 34. SPECIFIC CHANGES TO CURRENT MISSION CONTROL

The current plugin already contains valuable architecture. Preserve it.

## Keep

- mission state provenance;
- role mappings;
- approval center;
- evidence-based verification;
- live thread tree;
- quick actions;
- manual/deferred usage refresh principle;
- nullable unknown values.

## Refactor usage portion

Current:

```ts
source: "direct" | "pool"
```

Target:

```text
source plugin/resource agnostic
```

Migration approach:

### Step 1
Introduce generic usage types and adapter functions alongside old types.

### Step 2
Make current direct provider usage emit generic resources.

### Step 3
Make pool usage emit generic resources.

### Step 4
Add OMP source.

### Step 5
Change UI to generic account/capacity model.

### Step 6
Remove old `direct[] / pool[]` RPC shape only after new UI passes.

Do not break working Usage tab first and attempt to rebuild it all at once.

---

# 35. DO NOT PUT ALL NEW CODE IN `server.ts`

Current Mission Control `server.ts` is already large.

Before adding major account/runtime functionality, extract modules.

Suggested progression:

```text
server.ts
  ↓ delegates

server/usage-service.ts
server/account-service.ts
server/runtime-service.ts
server/contracts.ts
```

Keep `server.ts` responsible for:

- registration;
- wiring;
- existing top-level RPC registration;
- lifecycle.

Provider-specific process code belongs on host-side adapter.

---

# 36. REQUIRED EXECUTOR IMPLEMENTATION LOG

Create:

```text
adnan/arc-productization/IMPLEMENTATION_LOG.md
```

Update after each phase.

Template:

```markdown
## Phase N — <name>

### Files read
- ...

### Source observations
- ...

### Changes made
- ...

### Tests run
- command
  - PASS / FAIL

### Risks / unresolved
- ...

### Gate
PASS / BLOCKED

### Next phase
...
```

This is especially important for an executor with limited context.

It prevents it from forgetting previous architectural decisions.

---

# 37. REQUIRED DECISION LOG

Create:

```text
adnan/arc-productization/DECISIONS.md
```

At minimum record:

```text
ADR-001 Arc uses three agent engines only
ADR-002 Codex + OMP may be Arc-bundled managed runtimes
ADR-003 Claude uses official managed installation until redistribution approved
ADR-004 Arc does not globally modify PATH
ADR-005 Arc child runtime gets private PATH prefix
ADR-006 credentials remain provider-owned
ADR-007 Account Pool retained for Codex/Claude multi-account backend
ADR-008 OMP owns its provider accounts
ADR-009 generic usage-source contract
ADR-010 account dedupe only by canonical provider-issued identity
ADR-011 Arc update feed is independent of BB
ADR-012 BB upstream updates enter only through maintainer sync workflow
ADR-013 no automatic quota-driven model rerouting in v1
ADR-014 macOS arm64 is first fully supported production target
```

Every later architectural deviation requires adding/updating an ADR.

---

# 38. ERROR HANDLING REQUIREMENTS

Never expose internal raw errors as the only UI text.

Map errors.

Examples:

```text
ENOENT
→ Runtime executable is missing. Repair Arc agent runtime.

401
→ Account session expired. Reconnect.

429 during usage check
→ Usage service temporarily throttled the check.
  This does not necessarily mean your coding limit is exhausted.

digest mismatch
→ Download verification failed. Arc kept the previous version.

unsupported CLI version
→ This agent version is not compatible with this Arc release.

network offline
→ Could not check for updates. Installed runtime remains available.
```

Preserve technical detail in diagnostics/logs, sanitized.

---

# 39. TEST COMMAND DISCIPLINE

The executor must determine exact workspace scripts locally.

Do not invent commands when package scripts differ.

Typical targeted commands may include:

```bash
pnpm --filter @bb/desktop typecheck
pnpm --filter @bb/desktop test

pnpm --filter @bb/agent-runtime test

pnpm --filter <provider-package> test

cd adnan/plugins/adnan-mission-control
bb plugin build
```

After important phases, package:

```bash
pnpm exec turbo run package --filter=@bb/desktop
```

Then smoke the actual packaged artifact using existing desktop smoke tooling.

Source-mode success is insufficient.

---

# 40. CLEAN-MACHINE DEFINITION OF DONE

This project is not complete until all of the following pass on a clean macOS Apple Silicon environment.

## Installation

- [ ] Arc Agent installs from its own signed/notarized package.
- [ ] No BB product identity appears in normal user-facing install/update UX.
- [ ] Arc update feed points only to Arc-controlled releases.
- [ ] No system Codex required.
- [ ] No system OMP required.
- [ ] No Bun required.
- [ ] No manual Claude Code install command required.
- [ ] No Terminal setup required.

## Runtime readiness

- [ ] Codex becomes ready from Arc-managed binary.
- [ ] OMP becomes ready from Arc-managed binary.
- [ ] Claude Code can be prepared through Arc using Anthropic-supported distribution.
- [ ] Runtime versions display in UI.
- [ ] Runtime source displays in diagnostics.
- [ ] Broken runtime can be repaired.
- [ ] Compatible runtime update can be installed.
- [ ] Previous runtime can be rolled back.

## Accounts

- [ ] ChatGPT account can be connected from Arc UI.
- [ ] Claude account can be connected from Arc UI.
- [ ] OMP provider accounts can be connected from Arc UI.
- [ ] Multiple Codex/Claude accounts can be managed when Account Pool functionality is used.
- [ ] Real ChatGPT/Claude/OMP login dialogs remain stable during account/usage refreshes.
- [ ] Claude authentication UI matches the actual managed Claude Code login protocol.
- [ ] OMP device-code providers complete authorization and polling correctly.
- [ ] Enable/disable works where supported.
- [ ] Logout/remove works.
- [ ] Restart preserves account state.
- [ ] No raw tokens are visible in renderer/storage/logs.

## Agents

- [ ] A thread can run with Codex.
- [ ] A thread can run with Claude Code.
- [ ] A thread can run with OMP.
- [ ] New threads can explicitly choose a compatible account in addition to agent/model.
- [ ] The resolved account binding persists per thread and survives restart.
- [ ] Existing threads never silently change account when priorities change.
- [ ] Historical threads without an account binding render Unknown / legacy rather than guessing.
- [ ] Existing Mission Control thread hierarchy remains functional.
- [ ] Role Router still resolves provider/model mappings.
- [ ] Existing approvals still behave exactly as before.
- [ ] Existing verification evidence behavior remains exactly as before.

## Usage

- [ ] ChatGPT limits show when provider exposes them.
- [ ] Claude limits show when provider exposes them.
- [ ] OMP provider limits show when OMP exposes them.
- [ ] In-thread usage is scoped to the thread's selected account when known.
- [ ] Valid usage resources still render when active-account mapping is unknown.
- [ ] Account/usage refresh does not restart or remount an active login flow.
- [ ] New usage-capable OMP account can appear without editing Usage page code for that brand.
- [ ] Model-specific windows are labeled as model-specific.
- [ ] Unknown values render `n/a`, never zero.
- [ ] Failed refresh retains last-good real measurement.
- [ ] `observedAt` is visible/usable.
- [ ] Duplicate accounts merge only with trustworthy canonical key.
- [ ] Email alone never causes merge.
- [ ] Usage UI does not poll vendors every 30 seconds.

## Updates

- [ ] Arc application updates independently from agent runtimes.
- [ ] Codex updates independently.
- [ ] Claude updates independently using supported flow.
- [ ] OMP updates independently.
- [ ] Unsupported major CLI release is not auto-activated.
- [ ] Active threads prevent unsafe runtime activation.
- [ ] Rollback succeeds.
- [ ] BB upstream cannot overwrite Arc through auto-update.

## BB upstream maintenance

- [ ] `upstream` sync process is documented.
- [ ] Arc invariants are automated.
- [ ] Upstream sync cannot silently restore BB update URL.
- [ ] Upstream sync cannot silently remove private runtime integration.
- [ ] BB base commit/version is recorded in Arc release metadata.

---

# 41. ORDER OF EXECUTION — DO NOT REORDER WITHOUT REASON

Use this order.

```text
Phase 0  Inventory and baseline
Phase 1  Runtime path/environment scaffolding
Phase 2  Runtime manifest + compatibility policy
Phase 3  Codex managed runtime
Phase 4  OMP managed runtime
Phase 5  Claude managed setup
Phase 6  Arc Agent Manager service
Phase 7  Account Pool integration
Phase 8  OMP account adapter
Phase 9  Generic usage registry
Phase 10 Mission Control Accounts/Agents/Usage UI
Phase 10.1 Authentication + accounts + usage stabilization
Phase 10.2 Per-thread account selection
Phase 11 Runtime updater + rollback
Phase 12 Arc app update channel
Phase 13 BB upstream sync/invariant protection
Phase 14 Refresh/cache policy
Phase 15 Security hardening
Phase 16 Clean-machine harness
Phase 17 Account E2E
Phase 18 Usage E2E
Phase 19 Role-router advisory integration
Phase 20 First-run onboarding
Phase 21 Diagnostics
Phase 22 Release pipeline
Phase 23 Updates UI finalization
Phase 24 Rollback destructive-path tests
Phase 25 Reinstall/retention behavior
```

Some phases may be implemented together in one branch, but the gates must remain logically separate.

---

# 42. FIRST IMPLEMENTATION MILESTONE

Do not try to finish all product functionality in the first code pass.

The first milestone should prove the hardest foundation:

> Packaged Arc on a clean Mac launches with Arc-managed Codex and OMP, no global CLI dependency, while all existing Arc/BB behavior still works.

Success proof:

```text
normal shell:
command -v codex → absent
command -v omp   → absent

Arc:
Codex → Ready
OMP   → Ready

create one Codex thread → works
create one OMP thread   → works
```

Only then continue to full account/usage/update UX.

This isolates packaging/runtime risk before mixing OAuth and dashboard work.

---

# 43. SECOND IMPLEMENTATION MILESTONE

> All three agents are manageable in Arc UI.

Success:

```text
Codex       Ready
Claude Code Ready
OMP         Ready
```

No manual Terminal setup.

---

# 44. THIRD IMPLEMENTATION MILESTONE

> Arc Accounts works.

Success:

- connect ChatGPT;
- connect Claude;
- connect OMP provider;
- list accounts;
- safely log out;
- no tokens exposed.

---

# 45. FOURTH IMPLEMENTATION MILESTONE

> Unified Usage & Limits works from generic sources.

Success:

- Codex;
- Claude;
- Account Pool;
- OMP;
- dedupe;
- last-good;
- no guessed values.

---

# 46. FIFTH IMPLEMENTATION MILESTONE

> Arc and its three runtimes can update safely and independently.

Success:

- Arc release update;
- Codex runtime update;
- OMP runtime update;
- Claude supported update;
- rollback;
- compatibility guard.

---

# 47. SOURCE REFERENCE MAP FOR THE EXECUTOR

These are the most important source locations discovered during analysis.

## Current Arc fork

```text
adnanelhabashy/bb
```

Current custom Mission Control:

```text
adnan/plugins/adnan-mission-control/package.json
adnan/plugins/adnan-mission-control/server.ts
adnan/plugins/adnan-mission-control/app.tsx
adnan/plugins/adnan-mission-control/lib/data.ts
adnan/plugins/adnan-mission-control/components/agents.tsx
adnan/plugins/adnan-mission-control/components/roles.tsx
adnan/plugins/adnan-mission-control/components/usage-limits.tsx
adnan/plugins/adnan-mission-control/PLUGIN_OVERVIEW.md
```

Desktop rebrand/update-sensitive:

```text
apps/desktop/scripts/desktop-release-channel.mjs
apps/desktop/scripts/run-electron-builder.mjs
apps/desktop/electron-builder.config.json
apps/desktop/src/main.ts
apps/desktop/src/bb-process.ts
apps/desktop/src/app-paths.ts
```

Generic agent runtime:

```text
packages/agent-runtime/README.md
packages/agent-runtime/src/provider-adapter.ts
packages/agent-runtime/src/provider-registry.ts
packages/agent-runtime/src/execution-options.ts
```

## Current upstream BB patterns worth porting when missing locally

Repository:

```text
get-bb/bb
```

Provider usage:

```text
plugins/provider-usage/server.ts
plugins/provider-usage/usage-source-contract.ts
plugins/provider-usage/usage-schema.ts
plugins/provider-usage/usage-normalization.ts
```

Providers:

```text
plugins/provider-codex/server.ts
plugins/provider-codex/src/bridge/provider-maintenance.ts
plugins/provider-codex/src/usage-source.ts

plugins/provider-claude-code/server.ts
plugins/provider-claude-code/src/bridge/provider-maintenance.ts
plugins/provider-claude-code/src/usage-source.ts

plugins/provider-acp/server.ts
plugins/provider-acp/src/known-agents.ts
plugins/provider-acp/src/usage-source.ts
```

Account Pool:

```text
plugins/account-pool/src/server.ts
plugins/account-pool/src/rpc.ts
plugins/account-pool/src/usage-source.ts
plugins/account-pool/app.tsx
```

Core usage:

```text
apps/server/src/services/system/usage-limits.ts
```

## Codex

Repository:

```text
openai/codex
```

Read:

```text
README.md
LICENSE
release assets for pinned version
```

## Claude Code

Repository:

```text
anthropics/claude-code
```

Read:

```text
README.md
LICENSE.md
official setup documentation
```

## OMP / Oh My Pi

Repository:

```text
can1357/oh-my-pi
```

Read:

```text
README.md
LICENSE
docs/providers.md
docs/auth-broker-gateway.md
docs/extensions.md
```

---

# 48. IMPORTANT CURRENT FACTS TO REVERIFY AT IMPLEMENTATION TIME

These were true during analysis on 2026-09-18, but upstream projects move quickly.

Reverify before coding against them.

- OMP latest observed release: `v18.2.6`.
- OMP release included a standalone `omp-darwin-arm64` binary.
- OMP release metadata exposed SHA-256 digest.
- Codex latest observed release: `0.155.1`.
- Codex official releases provide macOS Apple Silicon executable archive.
- Codex license: Apache-2.0.
- OMP license: MIT.
- Claude Code repository license: Anthropic, all rights reserved / Commercial Terms.
- Claude Code current recommended install is Anthropic's native installer.
- Upstream BB provider-codex and provider-claude-code expose health/usage/installation maintenance.
- Upstream Claude provider supports `BB_CLAUDE_CODE_EXECUTABLE`.
- Upstream ACP registers OMP as `acp-omp`.
- Upstream generic provider-usage uses discoverable usage-source RPCs.

Never freeze these facts permanently without verification in the actual implementation branch.

---

# 49. THINGS THE EXECUTOR MUST NOT DO

Do not:

- replace OMP with Pi;
- add OpenCode as a fourth Arc agent;
- add Cursor as a fourth Arc agent;
- rename `acp-omp`;
- invent Arc-owned OAuth protocols for vendors;
- store passwords;
- store access tokens in Mission Control KV;
- merge usage by email;
- show missing usage as 0%;
- globally install CLIs as the primary product design;
- modify `.zshrc`;
- run unverified vendor binaries;
- auto-update to arbitrary latest major versions;
- update agent runtime during active provider thread;
- point Arc auto-updater to BB releases;
- let BB upstream auto-update overwrite Arc;
- delete existing Mission Control workflow features;
- rewrite the entire plugin before incremental migration passes;
- depend on the executor's memory of current CLI syntax;
- assume remote GitHub source equals local checkout;
- reset user's uncommitted Arc changes.

---

# 50. SIMPLE ARCHITECTURAL SUMMARY FOR THE EXECUTOR

When unsure, return to these six rules:

```text
1. Arc owns the product experience.
2. Codex, Claude Code, and OMP remain separate agent engines.
3. Arc owns runtime installation/version/update state.
4. Underlying systems own secrets.
5. Usage comes through generic sources, never UI brand hacks.
6. BB upstream is developer input, never the Arc user's updater.
```

---

# 51. FINAL RELEASE ACCEPTANCE STORY

A reviewer must be able to perform this story successfully:

1. Take a clean Apple Silicon Mac.
2. Confirm no global `codex`, `claude`, or `omp`.
3. Install signed Arc Agent.
4. Launch Arc Agent.
5. Arc starts without asking for Terminal commands.
6. Arc prepares Codex.
7. Arc prepares OMP.
8. Arc offers official Claude Code setup and completes it through the UI.
9. Open **Agents**:
   - Codex ready;
   - Claude Code ready;
   - OMP ready.
10. Open **Accounts**.
11. Connect ChatGPT.
12. Connect Claude.
13. Add at least one OMP-backed provider account.
14. Start a Codex coding thread.
15. Start a Claude Code coding thread.
16. Start an OMP coding thread.
17. Open **Usage & Limits**.
18. Observe real provider-reported limits where available.
19. Verify unknown provider limits show unavailable/n/a, not zero.
20. Verify duplicate canonical account does not appear as duplicate capacity.
21. Open **Updates**.
22. See Arc version and BB base provenance.
23. See each agent runtime version.
24. Stage one safe runtime update.
25. Activate it when no active thread uses that runtime.
26. Roll it back.
27. Restart Arc.
28. Verify accounts/runtime state persisted.
29. Verify no credentials are printed in logs.
30. Verify Arc updater checks Arc-controlled release location only.
31. Perform a simulated BB upstream sync on a developer branch.
32. Run Arc invariant checker.
33. Prove upstream sync cannot silently restore BB branding/update feed.

Only after all of these pass should the project be considered a complete Arc productization implementation.

---

# 52. EXECUTOR CHECKLIST — COPY THIS INTO THE WORK LOG

```text
[ ] Phase 0 inventory complete
[ ] baseline tests recorded
[ ] local vs remote discrepancy resolved
[ ] backup/safe branch strategy approved

[ ] private runtime path module
[ ] child PATH injection
[ ] runtime manifest
[ ] compatibility policy

[ ] pinned Codex seed
[ ] Codex digest verification
[ ] Codex clean-machine probe

[ ] pinned OMP seed
[ ] OMP digest verification
[ ] OMP ACP clean-machine probe
[ ] Arc-specific OMP config decision verified

[ ] Claude official installer behavior verified
[ ] Claude managed setup
[ ] Claude executable override
[ ] Claude health probe

[ ] runtime manager service
[ ] runtime status RPC/API
[ ] runtime repair

[ ] Account Pool backend audited/reused
[ ] Accounts presentation model
[ ] ChatGPT UI login
[ ] Claude UI login

[ ] OMP provider discovery verified
[ ] OMP account adapter
[ ] OMP login/logout UI
[ ] OMP secrets stay outside renderer

[ ] generic usage-source contract
[ ] Codex usage source
[ ] Claude usage source
[ ] Account Pool usage source
[ ] OMP usage source
[ ] canonical account dedupe
[ ] last-good/stale behavior

[ ] Mission Control Accounts tab
[ ] Mission Control agent runtime status
[ ] Usage page migrated
[ ] Updates tab

[ ] runtime update staging
[ ] compatibility gate
[ ] atomic activation
[ ] rollback

[ ] Arc appId/release identity
[ ] Arc update feed
[ ] no get-bb/bb update URL
[ ] About shows Arc + BB base + runtimes

[ ] BB upstream sync documentation
[ ] Arc invariant checker
[ ] CI invariant check

[ ] security review
[ ] clean-machine packaged test
[ ] account E2E
[ ] usage E2E
[ ] update/rollback E2E
[ ] signed/notarized release test
```

---

# 53. STOP CONDITIONS

The executor must stop the current phase and report rather than guessing if any of these happens:

1. Local provider plugin sources do not match assumed paths.
2. An Arc file has uncommitted user changes that conflict with planned edit.
3. Claude installer cannot be directed/managed safely.
4. Vendor licensing prevents intended redistribution.
5. Runtime digest/source cannot be verified.
6. OMP machine-readable output differs from expected schema.
7. Account Pool API differs from inspected upstream version.
8. Generic usage-source API is absent and porting it requires core SDK changes larger than expected.
9. A provider update breaks ACP/provider bridge compatibility.
10. A test requires printing or moving real credentials.
11. Generated Electron config still points to BB update feed after Arc release changes.
12. Packaged app works only when the developer's global CLI is on PATH.
13. Runtime update cannot be rolled back safely.
14. An upstream BB merge deletes Arc-specific runtime/update behavior.

When stopped, report:

```text
Observed
Expected
Difference
Files inspected
Safest options
Recommended next action
```

Do not improvise destructive fixes.

---

# 54. EXPECTED END STATE

At the end, Arc is not "BB with a new icon".

It is:

```text
Arc Agent
│
├── Arc desktop product
├── Arc Mission Control
├── Arc runtime manager
├── Arc account manager
├── Arc usage registry
├── Arc update manager
├── Arc compatibility policy
│
├── Codex runtime
├── Claude Code runtime
└── OMP runtime
     └── many AI providers
```

BB remains the powerful upstream foundation.

OMP remains the powerful multi-provider agent harness.

Codex remains OpenAI's native coding agent.

Claude Code remains Anthropic's native coding agent.

Arc provides the unified install, management, workflow, visibility, safety, and user experience that makes them feel like one coherent product.

---

## Phase 10.2 — Per-Thread Account Selection

Continue from the completed Phase 10/10.1 implementation. Do not start Phase 11.

Purpose: make multiple connected accounts actually usable inside coding threads. Arc can already hold multiple ChatGPT, Claude, and OMP accounts, but when creating/running a thread the user can choose the agent/model without explicitly choosing which account should execute that thread.

Target UX:

```
Agent:   Codex
Model:   GPT-5.6
Account: Personal ChatGPT
```

and equivalent behavior for Claude Code and OMP.

### 1. Inspect first (documented in `adnan/arc-productization/` findings before implementation)

Inspect: `packages/arc-domains`, `plugins/arc-core`, `apps/server`, `apps/app`, `adnan/plugins/adnan-mission-control`, Account Pool integration, OMP account integration, thread/provider/model selection, thread persistence, execution spawning, usage popup.

Determine exactly: where agent selection is stored; where model/provider selection is stored; how a new thread execution is started; how existing threads restore configuration; how Account Pool chooses an account today; how OMP chooses credentials today; how usage currently determines an account.

Preserve all existing work. Do NOT git reset/clean/stash/rebase. Do not commit or push unless explicitly authorized.

### 2. Account selection in the thread composer

Expose Agent / Model / Account. Selector dynamically depends on the selected agent:

- **Codex**: compatible connected ChatGPT/OpenAI accounts (`Auto`, `Personal ChatGPT`, `Work ChatGPT`, …).
- **Claude Code**: compatible connected Anthropic/Claude accounts.
- **OMP**: only connected OMP accounts/providers compatible with the selected provider/model. No unrelated credentials.

### 3. Account identity

Use the canonical `accountKey` (backend-safe). Do NOT use email as identity. Do NOT send credentials to the renderer. Renderer may know safe metadata only: `accountKey`, display label, provider, plan, enabled state. Renderer must NEVER receive access tokens, refresh tokens, API keys, OMP broker tokens, cookies, credential JSON, PKCE secrets.

### 4. New-thread behavior

New threads offer `Account: Auto` = highest-priority enabled compatible account. Once execution begins, resolve Auto into a concrete account and persist that actual account on the thread (before first message: Auto; after first execution: Personal ChatGPT). Prevents later priority changes from silently changing an existing thread.

### 5. Existing-thread behavior

Account binding is per thread. Thread A = Personal ChatGPT, Thread B = Work ChatGPT; reopening each preserves its account; restart preserves both; changing account priority must NOT change existing thread bindings.

### 6. Historical threads

Threads created before Phase 10.2 may have no recorded account. Do NOT guess. Display `Account: Unknown / legacy` where appropriate. If execution requires a concrete account and it cannot safely be inferred, ask the user to select one.

### 7. Disabled / removed account

If a thread is pinned to an account that becomes disabled/removed/expired/unavailable, DO NOT silently use another account. Show: "This thread was using "Personal ChatGPT", but that account is no longer available. Choose another account to continue." Then offer compatible accounts.

### 8. No automatic quota switching

No quota-driven account rotation. If Account A reaches its limit: no silent switch to Account B; show the actual limit/error and allow explicit selection. Automatic fallback may be a future optional feature.

### 9. Backend execution binding (not UI-only)

Flow: Thread → agentId → model/provider → accountKey → backend account resolver → underlying credential → Codex / Claude Code / OMP execution. Verify the CLI/runtime actually receives the intended account context. Do not merely display an account name while Account Pool still chooses a different account.

### 10. Codex multi-account

Two connected ChatGPT accounts: Thread A → Account 1, Thread B → Account 2, concurrently. If Account Pool only supports global priority, add the smallest safe explicit-account execution override; preserve existing default behavior for callers that do not specify an account.

### 11. Claude behavior

Same architecture: Claude Code + selected Anthropic account. Multiple connected Claude accounts appear separately; do not merge by email.

### 12. OMP behavior

Accounts belong to providers. Present understandably (Agent: OMP, Provider: Kimi Code, Model: …, Account: Kimi account). Only show accounts that can serve the selected provider/model. Single credential → natural selection; several → explicit selection.

### 13. Thread UI

Show selection compactly: `Codex · GPT-5.6 · Personal ChatGPT`. Clicking the account portion allows changing it where safe (freely for a new thread; explicit user action for an existing thread).

### 14. Mission Control

Live thread/agent info shows Agent / Model / Provider / Account. Legacy/unknown: `Account unknown`. Never infer from display name or email.

### 15. Usage & Limits integration

Thread usage popup uses the thread's selected account only. Rules: known account + usage available → show its usage; known account + provider does not expose usage → "Not exposed by provider"; unknown legacy account → "Active account unknown"; fetch failure + cached data → stale last-good. Preserve UNKNOWN != ZERO.

### 16. Account selector UX

Professional design; options may show label + plan metadata. Disabled accounts hidden or visibly unavailable — never selectable as healthy. Include `Manage accounts…` linking to Arc's Accounts management UI. Do not redesign Settings/Mission Control navigation.

### 17. Persistence

Minimum safe persistent thread metadata; explicit structure such as `accountKey` associated with the thread's execution configuration. Handle old records safely. No destructive migration. Existing threads must continue to open.

### 18. Concurrency

Thread A → Account A and Thread B → Account B running simultaneously must not leak global account state. Account selection is execution/thread scoped — NOT implemented by globally rewriting the active account before spawning. Add concurrency tests.

### 19. Tests

Regression tests for at least: two ChatGPT accounts appear; priority determines Auto default; explicit selection overrides priority; Auto resolves on first execution; concrete account persists; restart restores selection; priority change does not alter existing thread; two simultaneous threads use different accounts; disabled selected account does not silently fallback; removed selected account requires reselection; legacy thread reports unknown; Claude account filtering; OMP provider/account compatibility filtering; usage popup uses only thread account; Mission Control shows thread account; renderer receives no secrets. Rerun all existing suites; no new failures acceptable.

### 20. Installed-app verification (mandatory)

Build and reinstall the actual `/Applications/Arc Agent.app`, preserve `~/.bb`, do not validate only in the dev app. With two connected ChatGPT accounts: New Thread A → Codex → choose account A → send → verify backend uses A; same for B. Restart Arc → Thread A still A, Thread B still B. Usage popup follows each selected account.

### 21. Security

Access token to renderer? NO. Refresh token? NO. API key? NO. OMP broker token? NO. Credential record exposed? NO. Safe opaque identity only.

### 22. Documentation

Update `adnan/arc-productization/IMPLEMENTATION_LOG.md` and `DECISIONS.md` with Phase 10.2 decisions: per-thread account binding, Auto resolving once to a concrete account, no silent fallback, account-scoped usage, concurrency isolation, legacy thread behavior.

### Acceptance gate

PASS only when: account selector in thread UI; two ChatGPT accounts selectable independently; selected account controls backend execution; per-thread binding; survives restart; priority changes don't alter threads; no concurrency leak; Claude + OMP support; removed/disabled account warns explicitly; no automatic quota fallback; thread usage popup bound; Mission Control displays bound account; historical threads readable; unknown not guessed; renderer gets no secrets; installed app tested; no new regressions.

Final report answers: Thread A/B different accounts YES; each thread remembers YES; priority changes silently alter thread NO; quota exhaustion silently switches NO; thread usage uses selected account YES; secrets exposed NO. Then READY FOR PHASE 11 or BLOCKED BEFORE PHASE 11. Then STOP.
