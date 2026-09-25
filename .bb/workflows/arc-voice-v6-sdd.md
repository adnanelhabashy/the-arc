# Arc Voice V6 — SDD: Automation Voice Output

Status: AWAITING APPROVAL (Terrain SDD; supersedes plan doc §15 where more specific)
Verified context: V0–V5 PASS (PHASE_STATE). Terrain freshness 82 (1 commit, 111 changed
files since baseline — all V0–V5 voice work; cross-verified against source below).
Design grounded in live source inspection, not memory.

## 1. Scope

One Arc-owned operation exposed to automations: `voice.speak` (agent-facing tool name
`arc_voice_speak`), gated by an explicit per-automation **Allow voice output** toggle
(default OFF). An automation's agent may speak short user-facing alerts; voice never
fails a run.

Explicit non-goals: no new scheduler (existing Automations plugin); no V7 Voice Mode;
no script-mode changes (a script already has the explicit V3 `bb voice speak` CLI path);
no account/model/routing touch; no agent-tool access for normal (non-automation) threads.

## 2. Verified existing architecture (inspected this phase)

- Agent tools: `bb.agents.registerTool` (plugin-sdk backend-contract.ts:1646) —
  zod parameters, `execute(params, ctx)` returns `PluginAgentToolResult`
  (`{content:[{type:"text",text}], isError?}` — exchange-mail tools.ts:48). Names
  `[a-zA-Z0-9_-]+`, unique across plugins; `arc_voice_speak` matches the plan's
  §4 agent-tool vocabulary.
- Tool selection: `bb.agents.configure(provider)` — **synchronous**, runs at
  thread.start/turn.submit (backend-contract.ts:1610). Context carries
  `pluginMetadata`: the thread's metadata under THIS plugin's id, deep-frozen
  snapshot (backend-contract.ts:1133-1146). Untrusted by contract.
- Thread plugin metadata: GET/PATCH `/api/v1/threads/:id/plugin-metadata`
  (apps/server/src/routes/threads/data.ts:357-395). No plugin-ownership check —
  any authenticated client (including another plugin via `bb.sdk`) can write any
  slot; 256 KiB cap. SDK: `bb.sdk.threads.spawn({..., pluginMetadata})`,
  `updatePluginMetadata({threadId, pluginId, set})`, `getPluginMetadata`
  (packages/sdk/src/areas/threads.ts:250-573, 733-750, 1163).
- Automations dispatch: agent-mode runs spawn threads via
  `bb.sdk.threads.spawn({projectId, environment, prompt: "[bb automation due:<id>]\n\n<prompt>",
  providerId, model, ...})` (plugins/automations/src/run.ts:117-140) or re-prompt a
  fixed target thread (reuseTargetThreadForRun). The plugin knows `execution.providerId`.
- Renderer plugin signals: wsManager.onPluginSignal → per-channel handlers
  (apps/app/src/hooks/useWebSocket.ts:28, arc-cache-owner.ts:56 pattern).
- Speak path (V5, unchanged): renderer `speakVoiceText(text, {agentId?})` →
  POST /system/voice-speak → master-OFF 403 `voice_disabled` → per-agent voice
  resolution → host RPC → audio bytes. `deriveSpeakableText` strips
  fences/diffs/logs server-side (MAX 1200 chars).
- Plugin ids: `bb-plugin-arc-core` (bb.name "Arc Core"), `bb-plugin-automations`.

## 3. Design

### 3.1 Cross-plugin contract (thread plugin metadata, slot `arc-core`)

The automations plugin stamps, at every agent-run dispatch:

```json
{ "automationId": "<id>", "allowVoiceOutput": true, "providerId": "codex" }
```

- `spawn(...)`: `pluginMetadata: { "arc-core": {...} }` (spawn-time, atomic with
  thread creation).
- `reuseTargetThreadForRun`: `bb.sdk.threads.updatePluginMetadata({threadId,
  pluginId: "arc-core", set: {...}})` before the re-prompt dispatch.
- Stamping at dispatch time (not at toggle time) makes the flag's effect land with
  the next run and keeps one write path. `providerId` lets the announcement carry
  agent identity without arc-core reading the thread.

DESIGN AMENDMENT (source-verified during implementation): spawn-time
`pluginMetadata` requires `origin: "plugin"` and lands in the `originPluginId`
slot (thread-create.ts:503-517) — automations cannot atomically stamp the
arc-core slot at spawn without misattributing the thread's origin. Therefore:
- The automations plugin stamps the arc-core slot via
  `bb.sdk.threads.updatePluginMetadata` immediately AFTER spawn returns, and
  BEFORE `threads.send` on the reuse path (awaited, order guaranteed there).
- arc-core's `configure` ALWAYS selects `arc_voice_speak`. The single
  authoritative gate is the execute-time fresh read: an unstamped/forgeign
  thread is refused gracefully. Rationale: a configure-time gate keyed on the
  arc-core slot would miss the whole first turn of spawned automation threads
  (their only turn) because the stamp lands after spawn; always-advertise +
  execute-gate has strictly better availability and identical safety (nothing
  speaks without the stamped boolean-true flag + fresh re-check).

Values are arc-core's gate input and are **untrusted** (contract says any client
can write the slot): `allowVoiceOutput` must be exactly `boolean true`,
`automationId` a non-empty string ≤ 128. `providerId` is an **opaque** string
≤ 128 — NOT restricted to Arc agent ids: an automation may legitimately run a
non-Arc provider (e.g. the harness `claude` provider), and its speech must
fall back to the user's global default voice, not be refused. The renderer
maps known Arc agent providers to per-agent voices via the existing
`providerIdToAgentId` and maps everything else to `null` → global default —
never a random voice.

### 3.2 arc-core: the Arc-owned operation

New module `plugins/arc-core/src/voice-announce.ts`, wired from server.ts
(server-side factory; NOT the host entry — no host/daemon change):

- `bb.agents.registerTool({ name: "arc_voice_speak", ... })`
  - parameters: `{ text: z.string().min(1).max(1200) }` strict. Short spoken
    alerts only; `instructions` tells the model: speak only short user-facing
    summaries/alerts (≤2 sentences), never logs, code, diffs, secrets, or full
    documents; normal visible output remains the way to deliver detail.
  - presentation: label pending "Speaking voice alert" / completed "Spoke voice
    alert"; `suppress: false` (the user should see that speech happened).
  - `execute(params, ctx)`:
    1. Fresh gate: `bb.sdk.threads.getPluginMetadata({threadId: ctx.threadId,
       pluginId: "arc-core"})` → require validated `allowVoiceOutput === true`
       and matching shape; else return a **normal** (non-error) result:
       "Voice output is not enabled for this automation." (Never isError —
       refusal is a normal outcome, and a disabled automation must not look
       broken to the model mid-turn.)
    2. Publish `bb.realtime.publish("arc-voice-announce", {text, threadId,
       automationId, providerId})` (exact publish API per arc-core's existing
       realtime usage).
    3. Return "Voice alert announced." — publish is fire-and-forget; TTS
       outcome is renderer-side and can never fail this tool.
  4. `execute` catches everything and still returns a normal result on
     unexpected failure ("Voice alert could not be announced; continuing.").
     **The tool can never throw and never returns isError** — voice failure
     cannot fail the automation, satisfying the plan's failure-isolation rule
     for every case, including "voice is not the automation's purpose".
- `bb.agents.configure(...)` returns `arc_voice_speak` unconditionally (see the
  design amendment above — the execute-time gate is authoritative; a
  configure-time slot gate would miss spawned threads' only turn). Normal
  threads: the tool is advertised but every call is refused by the fresh
  metadata read.

### 3.3 automations plugin: the explicit opt-in

- DB: `automations.allow_voice_output` INTEGER NOT NULL DEFAULT 0 + migration.
- rpc-types/service: create/update accept optional `allowVoiceOutput`
  (default false); responses expose it.
- UI (detail view + create/edit form): "Allow voice output" switch, agent-mode
  only (hidden for script mode), default off. Helper: "Lets this automation's
  agent speak short voice alerts through Arc Voice when the run produces
  something worth announcing."
- run.ts: stamp §3.1 metadata on both dispatch paths.

### 3.4 Renderer: automation voice playback (apps/app)

New `automation-voice` module + one root-level provider:

- Signal: channel `arc-voice-announce` handled in the ws plugin-signal path
  (mirrors handleArcPluginSignal; wire in useWebSocket.ts).
- On announcement:
  1. Voice master OFF (useVoiceEnabled) → drop (server would 403 anyway;
     silent by design).
  2. Resolve `agentId = providerIdToAgentId(providerId)` (existing mapping).
  3. `speakVoiceText(text, {agentId})` → audio bytes → single shared
     HTMLAudioElement owned by this player; object URL revoked on end/stop.
  4. **No overlapping playback**: a tiny module-level playback coordinator
     (`speech-playback-coordinator.ts`) with `requestPlayback(ownerId)` /
     `releasePlayback(ownerId)`; the automation player holds the sole slot and
     `MessageSpeechProvider` + `useVoicePreview` participate — starting one
     stops the others. Refactor of those two is limited to coordinator
     registration; their public behavior is unchanged.
  5. Failure (speak 4xx/5xx, network, aborted) → log + drop; no toast storm for
     background automations. At most the existing voice failure surfacing.
- Concurrency: announcements queue FIFO on the player while uninterrupted;
  an interruption (another owner steals the slot, voice disabled, unmount)
  cancels current playback AND the pending queue, matching the plan's
  barge-in philosophy.

### 3.5 V5 control composition (all inherited, none re-implemented)

- Master OFF → renderer drop + server 403. Per-agent voices → §3.4 step 2.
  Global/default voice → V5 resolution order. `releaseModelsAfterUse` → server
  post-speak unload (V5). Keep-warm → untouched (announcements are lazy; a cold
  speak pays the model load, same as V5 speak semantics). No overlapping
  playback → §3.4 step 4. STT guards → untouched (no STT here).
- HOST_DAEMON_PROTOCOL_VERSION: **no bump** (no new host RPC; reuses
  `ai.voice.speak`). server-contract: no change (announcement is a plugin
  signal, automations RPC types are plugin-local).

## 4. Lifecycle invariant

`automation.allowVoiceOutput == false` (default) ⇒ the automation's agent has no
voice tool, every dispatch re-stamps `allowVoiceOutput: false`, and any stale
session's call is refused by the execute-time fresh read. Voice master OFF ⇒
announcements are dropped renderer-side and the speak route 403s. An automation
run can never fail because of voice.

## 5. Test plan

- arc-core (new voice-announce.test.ts): configure always selects the tool
  (execute-time gate is authoritative — see the design amendment); execute
  publishes the validated announcement on the wire channel
  (fake realtime capture); execute refuses silently-when-disabled via fresh
  metadata read (fake sdk; metadata toggled between configure and execute);
  malformed metadata refused; providerId carried through opaquely (non-Agent
  providers map to the global default voice renderer-side);
  publish failure → normal result, no throw; text bounds enforced by zod.
- automations: migration default 0; create/update round-trip; response shape;
  dispatch stamps the arc-core slot on both paths (fake sdk capture);
  script-mode create/update refuses or clears allowVoiceOutput;
  UI toggle renders for agent mode, hidden for script mode.
- app: coordinator sole-slot semantics (second requester stops first);
  automation player speaks via api with resolved agentId; drop when voice
  disabled; speak failure swallowed; object URL revoked.
- Regressions: bb-plugin-arc-core, bb-plugin-automations, @bb/app voice suites
  (message-speech, useVoicePreview, PromptBoxInternal), @bb/server voice routes.

## 6. Installed-app smoke

1. Automation with Allow voice output ON, agent mode → run → short spoken alert
   heard; Voicebox history records the generation; run succeeds.
2. Same automation with the toggle OFF → run → tool absent (timeline shows no
   voice row), zero voicebox activity.
3. Automation ON with Voice master OFF → run completes silently (403 path), no
   process starts.
4. Toggle ON mid-session (target-thread mode) → next run re-stamps; stale
   session call refused.
5. After settle with keep-warm off: the loaded-model list is empty
  (releaseModelsAfterUse; the Voicebox process itself stays up per V5 — only
  master OFF releases the process).

## 7. Risks / decisions

- **Cross-plugin metadata write** (automations → arc-core slot): sanctioned by
  the metadata contract ("another plugin … can write it"); the slot is
  arc-core's own so its configure callback can see it. Malicious/forged metadata
  is bounded: worst case is a spoken alert on a thread that opted in shape-only —
  accept (local single-user product, metadata already writable by any client).
- **Renderer-dependent playback**: a headless server (no app window) drops
  announcements. Accepted: Arc's product surface is the desktop app; a headless
  run logs the dropped announcement. Server-side audio file output was rejected
  (new surface, no playback protections, plan wants app-integrated speech).
- **FIFO queue vs latest-wins**: FIFO chosen; alerts are few and ordered.
- **Normal threads never get the tool** in V6 (metadata absent → tool absent);
  a future phase could opt normal threads in deliberately.

## 8. Review record

- Cycle 1 (independent report-only reviewer, 4 axes: correctness / safety /
  regressions / contract truthfulness): all four PASS. 1 medium + 2 lows:
  (1) providerId validated as opaque string while SDD text said "known agent
  id" — SDD corrected, not the code: automations may run non-Arc providers
  (harness `claude`) whose speech must fall back to the global default voice,
  so arc-core must not restrict it; (2) queue tail stalled after a cross-owner
  steal — stopCurrent now cancels the whole queue (interruption cancels
  pending alerts, matching the plan's barge-in philosophy), new regression
  test; (3) stale allowVoiceOutput:true survived an agent→script mode switch —
  service update now writes false whenever the effective mode is script, new
  harness assertions.
- Cycle 2 re-review: overall PASS — all findings RESOLVED with file:line
  evidence, no new defects. Residual info: pre-fix legacy script rows keep a
  stale true through unrelated updates (never stamped, never printed, heals on
  any execution/voice update).
- Installed-app smoke (fresh build, asar/unpacked-verified, prior install kept
  as /Applications/Arc Agent.backup-20260924-220833.app and ...-221616.app):
  tool visible in session as functions.arc_voice_speak (inventory probe);
  ON automation → tool call completed "Voice alert announced." → renderer
  speak → lazy Voicebox start → completed generation with the exact text;
  per-agent voice: codex→kokoro/af_heart assignment flipped the generation
  engine qwen→kokoro on the same automation; OFF automation → gate refusal
  "Voice output is not enabled for this automation", run succeeded, zero new
  generations (61→61); master-OFF window → announcement dropped renderer-side,
  zero generations, run succeeded; releaseModelsAfterUse → speechModelLoaded
  false seconds after settle (process warm per V5); clean quit → zero
  voicebox processes, port 47873 free; smoke automations deleted, agent voice
  restored to null.
- Smoke anomaly (recorded, unresolved): for ~10 min after the fresh relaunch,
  voice-status reported voiceEnabled:false and speak 403'd voice_disabled
  while the persisted settings row said enabled:true (unchanged since the
  prior evening); it self-resolved without a settings write and V6 behavior
  was correct in both states. Suspected startup-state ghost in config
  propagation, not V6-caused; worth one look in a future phase.
