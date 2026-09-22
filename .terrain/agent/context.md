---
type: agent_context
project: the-arc
title: Agent Architecture Context
source: .
---

## Project Overview

BB ("the-arc") is a multi-platform agent runtime and product surface (web, desktop, mobile) with a shared server, host daemon, provider bridges, and a plugin system. Purpose: run agentic workflows across local/remote hosts with execution control, threads, environments, skills, and marketplace distribution. Constraints: TypeScript monorepo (pnpm + Turbo), SQLite (Drizzle), provider-bridge protocol (ACP/Claude/Codex/Pi), packaged desktop (Electron), mobile (Expo), plugin provenance rules, and strict build/test orchestration.

## Architecture

| Layer | Role | Key Components |
|---|---|---|
| Client (App/Web) | UI surface and thread runtime state | `apps/app` (React/Vite), timeline, prompt/composer, secondary panel, split layout, theme system |
| Desktop | Packaged client + native integration | `apps/desktop` (Electron), browser capture/CDP, auto-update, menu, window state |
| Mobile | Mobile shell + native bridge | `apps/mobile` (Expo/React Native), webview/profile shell, push notifications, share intents |
| Server | Product API, orchestration, state | `apps/server` (Node), routes, services (threads, environments, plugins, providers, skills), DB, WS hub |
| Host Daemon | Host-local primitives and execution | `apps/host-daemon`, command handlers, runtime manager, terminals, file ops, plugin-host manager, workspace resolution |
| Provider Bridges | Provider translation to BB runtime | `packages/provider-bridge-*` (ACP, Claude Code, Codex, Pi), protocol/grammar, recordings, conformance |
| Agent Runtime | Thread execution + provider registry | `packages/agent-runtime`, bridge adapters, execution options, runtime state |
| Plugins | Extensible surfaces/behaviors | `plugins/*`, plugin SDK/build, host artifacts, marketplace/catalog |
| Data | Persistence and schema | `packages/db` (Drizzle/SQLite), migrations, schema, data services |
| Shared Contracts | Cross-boundary types/protocols | `packages/*-contract`, `domain`, `client-core`, `sdk` |

## Module Map

| Module | Responsibility | Primary paths |
|---|---|---|
| Threads & Timeline | Thread lifecycle, dispatch, events, timeline projection | `apps/server/src/services/threads`, `packages/thread-view`, `apps/app/src/components/thread`, `apps/app/src/views/thread-detail` |
| Environments & Workspaces | Provisioning, providers, workspace resolution, hooks | `apps/server/src/services/environments`, `apps/host-daemon/src/command-handlers/environment*`, `apps/app/src/hooks/queries/environment*`, `packages/environment-provider-host` |
| Providers & Bridges | Provider registry, model catalogs, bridge translation | `apps/server/src/services/providers`, `packages/agent-runtime`, `packages/provider-bridge-*`, `plugins/provider-*` |
| Plugins | Registration, runtime, host artifacts, catalog/marketplace | `apps/server/src/services/plugins`, `packages/plugin-*`, `plugins/*`, `apps/app/src/components/plugin`, `apps/app/src/hooks/plugin*` |
| Host Daemon & Terminals | Host RPC, terminals, files, skills, runtime | `apps/host-daemon/src`, `apps/server/src/services/hosts`, `apps/server/src/services/terminals`, `apps/app/src/components/thread/terminal` |
| Projects & Sections | Project sources, worktrees, sections, attachments | `apps/server/src/services/projects`, `apps/app/src/components/project`, `apps/app/src/components/sidebar`, `apps/app/src/views/project-detail*` |
| Skills & Commands | Skill registry/catalog, injected/builtin, command discovery | `apps/server/src/services/skills`, `apps/host-daemon/src/command-discovery*`, `apps/app/src/components/tools/Skills*`, `apps/cli/src/commands/skill*` |
| UI Shell & Layout | Sidebar, split layout, secondary panel, routing, toasts | `apps/app/src/components/layout`, `apps/app/src/components/sidebar`, `apps/app/src/components/secondary-panel`, `apps/app/src/lib/split-layout` |
| Data Access | Schema/migrations, data services, queries | `packages/db/src`, `apps/app/src/hooks/queries`, `apps/server/src/routes`, `packages/db/drizzle` |
| Platform Surfaces | Desktop/mobile integration and bridges | `apps/desktop/src`, `apps/mobile/src`, `apps/connect`, `apps/web` |

## Core Flows

1. **Thread creation & dispatch**: User creates thread (UI/CLI) → server validates/request → environment provisioned/selected → provider bridge launched → first turn dispatched → events streamed to clients via WS.
2. **Execution via provider bridge**: Server/runtime sends turn to provider bridge → bridge translates protocol (ACP/Claude/Codex/Pi) → provider executes → deltas/events mapped to BB grammar → timeline/state updated → outputs persisted.
3. **Host operations**: UI/agent actions require host-local ops → server routes to host daemon (RPC) → daemon executes (files/terminals/env/workspace) → results returned → state synchronized.
4. **Plugin lifecycle**: Plugin installed/registered (catalog/marketplace/bundled) → build/host artifacts resolved with provenance → frontend/backend loaded in isolated scopes → contributions (commands/skills/slides/panels) exposed to surfaces.

## Tech Stack

- **Language/Runtime**: TypeScript, Node.js, React 19, React Native (Expo)
- **Build/Orchestration**: pnpm workspaces, Turbo (build/typecheck/test orchestration)
- **Frontend**: Vite, React Compiler, TipTap/ProseMirror, Tailwind/shadcn, shared UI (`packages/shared-ui`)
- **Desktop**: Electron
- **Mobile**: Expo, EAS, native modules
- **Server/API**: Node server (`apps/server`), routes/services, WebSocket hub, typed routes (`packages/hono-typed-routes`)
- **Database**: SQLite via Drizzle ORM, migrations in `packages/db/drizzle`
- **Protocols/Bridges**: ACP, Claude Code, Codex, Pi provider bridges; provider-bridge-protocol grammar/recordings
- **Plugins/SDK**: Plugin SDK/build (`packages/plugin-sdk`, `packages/plugin-build`), API map, registry
- **Testing/Tooling**: Vitest (shared config), oxlint, tsconfig base, scripts

## System Boundaries

| Boundary | Type | Description |
|---|---|---|
| Browser ↔ Server | HTTP/WS | App API, realtime events, thread/timeline state, file previews |
| Server ↔ Host Daemon | WebSocket/RPC | Host-local operations (files, terminals, workspaces, environments, skills), enrollment, lifecycle |
| Server ↔ Provider Bridges | Process/IPC (bridge protocol) | Turn dispatch, deltas, approvals, tool calls, model/catalog, maintenance |
| Desktop ↔ Host/Server | Electron IPC + native | Browser capture/CDP, auto-update, window/menu, packaged app lifecycle |
| Mobile ↔ Server/Profile | HTTP + native bridge | Connect profiles, realtime, push notifications, share intents |
| Plugins ↔ Host/Server/App | Isolated runtime + host artifacts | Frontend/backend contributions, RPC, slots, provenance-gated artifact resolution |
| External Providers | Network APIs | Model providers via bridges (Claude/Codex/ACP/Pi) and marketplace/catalog sources |
| Storage | Filesystem/DB | SQLite DB, thread storage, plugin artifacts, workspace paths, logs |
| Marketplace/Catalog | HTTP | Curated/bundled marketplace, icons, stats, publish sources |

## Code Map Index

| Concept | Location (paths only) | Notes |
|---|---|---|
| App UI root | `apps/app/src/App.tsx` | Client surface entry |
| Server entry/routes | `apps/server/src` | API, services, WS hub |
| Host daemon | `apps/host-daemon/src` | Host RPC and execution |
| CLI | `apps/cli/src` | `bb` CLI commands |
| Desktop app | `apps/desktop/src` | Electron main/preload/UI integration |
| Mobile app | `apps/mobile/src` | Expo shell, screens, bridge |
| Web | `apps/web/src` | Marketing/site |
| DB schema/migrations | `packages/db` | Drizzle schema, drizzle/* migrations |
| Agent runtime | `packages/agent-runtime/src` | Runtime/bridge adapters |
| Provider bridges | `packages/provider-bridge-*` | ACP/Claude/Codex/Pi bridges + protocol |
| Plugin SDK/build | `packages/plugin-sdk`, `packages/plugin-build` | SDK, build/toolchain, host artifacts |
| Plugin API map/registry | `packages/plugin-api-map`, `packages/plugin-registry` | Surfaces, anatomy, registry |
| Domain/types | `packages/domain/src` | Shared domain models |
| Shared UI | `packages/shared-ui/src` | UI primitives/components |
| Client core/sdk | `packages/client-core`, `packages/sdk` | Client types/API, realtime |
| Bundled plugins | `packages/bundled-plugins` | Bundled assembly |
| Plugins (builtins) | `plugins/*` | Core/official plugins |
| Migrations SQL | `packages/db/drizzle` | Versioned SQL migrations |