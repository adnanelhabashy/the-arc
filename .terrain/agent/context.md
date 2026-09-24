---
type: agent_context
project: the-arc
title: Agent Architecture Context
source: .
---

## Project Overview

**the-arc** is The Arc, Adnan's personal distribution of **bb** — an open-source (MIT) agentic IDE / agent control plane. Instead of a chat wrapper over one model, bb launches real coding-agent **provider processes** (Codex, Claude Code, Pi, ACP, OMP) on the machine where work happens, bridges their output into a single typed event stream, and persists everything to a local SQLite database. A **thread** is the unit of work: conversation + lifecycle state + environment (directory on disk) + provider. All surfaces (web, desktop, mobile, CLI) drive the same engine.

This checkout layers Arc-specific productization on the upstream bb monorepo: the **Arc layer** (`plugins/arc-core`, `packages/arc-domains`, `packages/arc-voice-host`) adds managed agent runtimes, OMP account/usage/pooling, and a closed provider catalog; `adnan/` adds the Mission Control plugin, a cyberpunk theme, installers, and productization records. Engines: Node ≥22.19, pnpm + Turbo, TS.

## Architecture

Three-tier execution core, plus plugin and Arc layers.

| Tier | Container | Responsibility |
|---|---|---|
| Product policy | `apps/server` | Owns defaults, instructions, manager/tool behavior, thread & turn orchestration, timeline persistence, plugin hosting, REST routes + WebSocket hub |
| Host-local | `apps/host-daemon` | Host primitives, provider process translation, terminal/runtime/session management, workspace execution, file ops, watch |
| Runtime | provider processes | Codex / Claude Code / Pi / ACP / OMP agent CLIs spawned via per-provider bridges |

Boundary rule: the **server owns product policy**; the **daemon returns raw host-local data** and ships it over a WebSocket wire protocol versioned by `HOST_DAEMON_PROTOCOL_VERSION` (currently 215). Every server/daemon wire change bumps it unless deliberate drop-in compatibility is tested.

- **Apps layer**: `apps/desktop` (Electron shell + embedded browser broker/CDP + arc runtime provisioning), `apps/app` (React SPA), `apps/mobile` (Expo), `apps/cli` (thin `bb` CLI), Cloudflare Workers `apps/web`, `apps/connect`, `apps/demo-server`.
- **Plugin layer**: `plugins/` (bundled + third-party feature plugins, provider bridges), `packages/plugin-build` + `plugin-sdk` + `@bb/bundled-plugins`; plugins ship as `prepare:bundled` output, run from `~/.bb/plugin-host-artifacts/<id>/<digest>/host.mjs`, with strict provenance rules.
- **Arc layer**: `plugins/arc-core` (RPC contract for agents/accounts/usage), `packages/arc-domains` (shared domain logic), `packages/arc-voice-host`, `adnan/` (Mission Control UI plugin, theme, installers). Arc mode is declared by env (`BB_ARC_RUNTIME_ROOT`, `BB_ARC_APP_VERSION`, `BB_ARC_SEED_ROOT`); absent env ⇒ every RPC reports `arc-unavailable`.
- Cross-cutting packages: `domain` (shared pure domain), `db`/`connect-db` (Drizzle + SQLite), `server-contract`/`host-daemon-contract`/`desktop-contract` (wire contracts), `client-core`/`thread-view` (timeline projection), `provider-bridge-protocol`/`provider-bridge-acp` (delta grammar + conformance), `shared-ui`/`core-ui`.

## Module Map

| Module | Responsibility | Primary paths |
|---|---|---|
| Server | Thread/turn dispatch, timeline, environments, providers, plugin hosting, REST + WS | `apps/server/src/{index,server,db}.ts`, `routes/`, `services/`, `ws/` |
| Host daemon | Host primitives, provider processes, terminals, workspace exec, file ops, enrollment | `apps/host-daemon/src/{daemon,app,command-*,plugin-host-manager}.ts` |
| Desktop | Electron shell, browser broker (CDP), connect session, server spawning, arc runtime seed | `apps/desktop/src/{main,preload,desktop-browser-*,bb-process,owned-runtime-supervisor}.ts` |
| Web app | Thread timeline UI, promptbox, plugin slots, secondary panel, settings, machine mgmt | `apps/app/src/components/`, `views/`, `hooks/{queries,mutations,cache-owners}/` |
| CLI | `bb` command surface over SDK (threads, envs, machines, plugins, skills, server-move) | `apps/cli/src/commands/`, `client.ts` |
| Mobile | Expo client: connect profiles, webview shell, push | `apps/mobile/src/{screens,data,realtime,session,shell}/` |
| Cloudflare | Connect tunnel (Durable Object), marketplace/site/auth | `apps/connect/src/`, `apps/web/src/routes/`, `apps/demo-server/src/` |
| Arc layer | Managed runtimes, agents, accounts, usage, voice, Arc RPC | `packages/arc-domains/src/`, `plugins/arc-core/src/`, `packages/arc-voice-host/src/` |
| Arc distro layer | Mission Control, cyberpunk theme, installers, productization records | `adnan/plugins/adnan-mission-control/`, `adnan/plugins/cyberpunk-terminal/`, `adnan/theme/`, `adnan/install.*` |
| Persistence & contracts | Drizzle schema/migrations, domain types, wire contracts, DB data access | `packages/db/`, `packages/domain/`, `packages/server-contract/`, `packages/host-daemon-contract/`, `packages/db/drizzle/` |
| Provider bridges | Translate provider-specific streams into the canonical event/delta grammar | `plugins/provider-codex/src/bridge/`, `provider-claude-code/src/bridge/`, `provider-pi/src/bridge/`, `provider-acp/src/`, `account-pool/src/`, `packages/provider-bridge-protocol/`, `provider-bridge-acp/` |
| Plugin toolchain | SDK, build, registry, bundled set, marketplace | `packages/plugin-sdk/`, `plugin-build/`, `plugin-registry/`, `bundled-plugins/`, `plugins/bb-official.json` |
| Feature plugins | tasks, workflows, automations, side-chat, secrets, memory, github, exchange-mail, push | `plugins/<name>/src/server.ts` + `app.tsx` |

## Core Flows

1. **Thread create → send → dispatch**
   User composes on any surface → server runs `thread-create`/`thread-send` (`apps/server/src/services/threads/`) → validates permission modes and execution options → provisions an environment (workspace dir via daemon) → queues/turns dispatch to the provider → turn events land in the timeline (`thread-timeline.ts`, `timeline-*.ts`) → persisted to SQLite and streamed over WebSocket to all open surfaces; queued-message dispatch handles low-water conditions.

2. **Provider orchestration & delta bridging**
   Server asks the host daemon for a provider launch → daemon spawns the provider bridge process (or Arc's managed runtime) → bridge translates vendor-specific streams (Codex/Claude/Pi/ACP/OMP) into the canonical event grammar (`provider-bridge-protocol`) → daemon emits deltas; server assembles typed timeline rows. Permission/approval, user-question, and plan-mode interactions are routed through `pending-interactions`.

3. **Arc-mode agent execution (pinned, fail-closed)**
   In Arc mode the catalog is filtered to OMP/Codex/Claude; agents launch only the manifest-pinned managed runtime path (never PATH). `ArcAccountService` reads the OMP auth-broker snapshot (`/v1/snapshot`, bearer token, `127.0.0.1:8765`), the layer pins/rents a broker hold and writes an account-pool file per account, then `arc-core` contributes `OMP_AUTH_BROKER_URL/TOKEN/ACCOUNT_POOL_FILE` env to the provider process. Absent Arc env ⇒ `arc-unavailable`.

4. **Enrollment, server-move & remote access**
   A machine enrolls to the server via the host daemon (`apps/host-daemon/src/enroll.ts`, `machine-auth-proxy.ts`). Moving/retiring servers runs the `server-move` freeze/export/switch/reconcile pipeline on both sides. Remote access goes through the `apps/connect` Cloudflare worker: machine code + redeem + revoke (`api.connect.*`), with a Durable-Object tunnel (`tunnel-do.ts`) and connect-db persistence.

## Tech Stack

- **Monorepo**: pnpm 9 + Turborepo; TS (typescript@6, `typescript-7` alias); Vitest; oxlint.
- **Server**: Hono + `hono-typed-routes`, Zod 4 (pinned override), SQLite via **Drizzle** (`packages/db`, 128 migrations), WebSocket hub.
- **Frontend**: React 19 + Vite SPA (apps/app); TanStack Router on `apps/web`; Tailwind/NativeWind; Tiptap prompt editor; pluggable component registry (`shared-ui`, `plugin-registry`).
- **Desktop**: Electron 41 (+ electron-builder), CDP-based embedded browser broker; bundles the server/daemon via `packages/bb-app`.
- **Mobile**: Expo/React Native 57, expo push, `mobile-bridge` webview bridge to the web app.
- **Cloudflare Workers**: connect (Durable Objects), web site/marketplace/auth, demo-server.
- **Provider bridges**: per-vendor adapters + recorded conformance corpus (`packages/provider-bridge-protocol/recordings/`).
- **Arc**: managed runtimes under `Agent/arc-runtimes/runtimes/<runtime>/<version>/`, OMP auth broker, `arc-voice-host` runtime, `arc-domains` shared package.

## System Boundaries

| Boundary | Detail |
|---|---|
| Server ↔ host daemon | WebSocket; `HOST_DAEMON_PROTOCOL_VERSION` guard; raw host data up, policy down |
| Server ↔ provider processes | Spawned via daemon/bridge; permission modes, env redaction, stdin-only secrets |
| SQLite | `packages/db` (state/timeline/plugins/threads), `packages/connect-db`, OMP's own `agent.db` (never written by Arc) |
| Plugin runtime | `@get-bb/plugin-sdk` API; built app bundles (`plugin-build`); provenance: `plugins.root_dir` must point inside the launched app and artifacts hash to that app's `dist/host.js`; builtin plugins never run from another app |
| Marketplace | Curated/bundled marketplaces, `bb-official.json`, marketplace-v2 schema served by `apps/web` |
| OMP broker | Bearer-guarded local HTTP API; credentials live in OMP `agent.db`; Arc only drives broker subcommands and the snapshot allowlist |
| Electron ↔ OS | CDP browser automation, keyboard shortcuts, window state, auto-update version feeds |
| Cloudflare ↔ clients | connect machine-code/redeem/revoke, tunnel sessions, mobile push, web auth |
| External services | GitHub (`plugins/github`), Exchange EWS (`exchange-mail`), provider CLIs/clouds, model inference, voice transcription |

## Code Map Index

| Concept | Location | Notes |
|---|---|---|
| Thread/turn orchestration | `apps/server/src/services/threads/` | create, send, dispatch, fork, archive |
| Timeline projection | `packages/thread-view/src/` | event → rows, compaction, streaming |
| Server routes | `apps/server/src/routes/` | Hono typed routes |
| WS hub / protocols | `apps/server/src/ws/` | client/daemon/terminal protocols |
| DB schema + migrations | `packages/db/` | `schema.ts`, `drizzle/`, `data/` |
| Daemon command dispatch | `apps/host-daemon/src/` | `command-*.ts`, `plugin-host-manager.ts` |
| Provider bridges | `plugins/provider-{codex,claude-code,pi,acp}/src/bridge/` | delta translation |
| ACP/grammar | `packages/provider-bridge-protocol/src/` | grammar, conformance, recordings |
| Arc domains | `packages/arc-domains/src/{arc-runtime,arc-agent,arc-account,arc-usage}/` | shared Arc logic |
| Arc RPC plugin | `plugins/arc-core/src/` | `contract.ts`, `server.ts`, `voice-host.ts` |
| Account pooling | `plugins/account-pool/src/` | pool, quota, usage, broker holds |
| Mission Control | `adnan/plugins/adnan-mission-control/` | Arc admin UI plugin |
| Productization record | `adnan/arc-productization/` | BASELINE, DECISIONS, IMPLEMENTATION_LOG |
| SDK / CLI / App | `packages/sdk/src/`, `apps/cli/src/`, `packages/bb-app/`, `apps/desktop/src/` | end-user surfaces |
| Plugin provenance | `docs/plugin-provenance.md`, `packages/bundled-plugins/build.ts` | assembly guarantees |

Architecture context: upstream `docs/system-overview.md`, `docs/repository-overview.md`, `docs/lifecycle-diagrams.md`; Arc product decisions live in `adnan/arc-productization/DECISIONS.md` (ADRs 047, 071, and Phase 1–10 plans in `IMPLEMENTATION_LOG.md`).