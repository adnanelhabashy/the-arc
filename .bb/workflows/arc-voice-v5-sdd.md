# Arc Voice V5 — SDD: Per-Agent Voices + Master Voice Switch

Status: APPROVED FOR IMPLEMENTATION (Terrain SDD; supersedes plan doc V5 section where more specific)
Verified context: V0–V4 PASS (PHASE_STATE). Freshness 85 (dirty tree = V0–V4 work).
Live-probed additions this phase: Voicebox 0.5.0 route surface via `/openapi.json` on the
running runtime: `/models/unload`, `/models/{model_name}/unload`, and `/shutdown` all EXIST.

## 1. Scope

Two features, one settings surface:

A. **Per-agent voices** — Codex / Claude Code / OMP each get a configurable voice
   (preset or custom profile), resolved at speak time. Arc owns the mapping.
B. **Master Voice enable/disable** — one switch at the top of Settings → Voice.
   OFF releases all voice resources (playback, STT, preview, runtime process, loaded
   models' RAM/VRAM) and blocks all voice actions. ON preserves lazy startup.

Explicit non-goals: thread voice override UI (the resolution slot exists in the contract,
null in V5 — do not build the feature); V6 automations; any account/model/routing change.

## 2. Verified existing architecture (inspected this phase)

- Agent identity: thread `providerId` ∈ {`codex`, `claude-code`, `acp-omp`} →
  `ArcAgentId` ∈ {`codex`, `claude-code`, `omp`} via existing
  `providerIdToAgentId` (apps/app/.../ProviderUsageSection.tsx:34). Message rows do NOT
  carry agent identity; the timeline tree has `useThreadProvider()` exposing providerId.
- Speak path: renderer `MessageSpeechProvider.speak(messageId, text)` →
  `speakVoiceText(text, {signal})` (apps/app/src/lib/api.ts) → POST /system/voice-speak →
  server `speakVoiceText` → `resolveSpeakVoiceSelection(deps, args)` → host RPC
  (apps/server/src/services/ai/voice-speech.ts:95,147).
  Callers: MessageActionBar.tsx:604 (Speak action), ConversationMessageContent.tsx:498
  (auto-speak effect on stream completion; checks behavior.autoSpeakReplies).
- Settings persistence: whole-blob PUT /settings/general; `voice` parsed by strict
  `voiceSettingsSchema` (packages/domain/src/voice-settings.ts). CRITICAL: getAppSettings
  safeParses the blob per key and silently keeps DEFAULTS on parse failure — a new
  REQUIRED key would reset every user's voice settings. All new keys use `.default()`.
- Runtime control plane: AiServiceRegistration has prepare/repair/download/cancel but
  NO stop/release (apps/server/src/services/ai/ai-service-registry.ts:75). Host manager
  `stop()` = SIGTERM→SIGKILL (runtime-manager.ts:519); client knows no unload.
- Keep-warm: start-server.ts:359 prepares at startup only when behavior.keepWarm.
- Voicebox capabilities route: /models/status + /health; profiles: /profiles.
- STT route: POST /system/voice-transcription → transcribeVoiceInput (routes/system.ts:634).
- Mic UI: PromptBoxInternal renders VoiceRecordingBar (gated by behavior.showMicrophone).

## 3. Design

### 3.1 Persistence (packages/domain/src/voice-settings.ts)

```ts
export const VOICE_AGENT_KEYS = ["codex", "claude-code", "omp"] as const;
export type VoiceAgentKey = (typeof VOICE_AGENT_KEYS)[number];

export const voiceAgentSelectionSchema = z.object({
  engine: z.enum(VOICE_TTS_ENGINES),
  voiceKind: z.enum(["preset", "profile"]),
  presetEngine: z.string().min(1),
  presetVoiceId: z.string().min(1),
  profileId: z.string().min(1).nullable(),
}).strict();

voiceSettingsSchema gains:
  enabled: z.boolean().default(true),
  agentVoices: z.object({
    codex: voiceAgentSelectionSchema.nullable(),
    "claude-code": voiceAgentSelectionSchema.nullable(),
    omp: voiceAgentSelectionSchema.nullable(),
  }).strict().default({ codex: null, "claude-code": null, omp: null }),

defaultVoiceSettings gains: enabled: true, agentVoices: {codex:null,"claude-code":null,omp:null}
```

- `.default()` fills the keys when parsing pre-V5 blobs and pre-V5 renderer PUTs → no
  settings reset, forward/backward compatible within protocol v216.
- Agent selection stores REFERENCES only (engine/voiceKind/preset ids/profileId) —
  Voicebox remains the owner of cloned samples/embeddings. No audio duplication.

### 3.2 Contract (packages/server-contract/src/api/system.ts)

- `systemVoiceSpeakRequestSchema` += `agentId: z.enum(["codex","claude-code","omp"]).nullable().optional()`
- `systemVoiceCapabilitiesResponseSchema` += `voiceEnabled: z.boolean()`
- `systemVoiceStatusResponseSchema` += `voiceEnabled: z.boolean()`
- New stop/release surface follows the existing experimental SDK pattern:
  plugin-sdk `releaseVoiceRuntime(input, options)` +
  `ExperimentalAiVoiceReleaseInput/Output` (result: runtimeState "stopped"|"not-running").

### 3.3 Server resolution order (voice-speech.ts)

`resolveSpeakVoiceSelection(deps, args)` — `args` gains `agentId?: string`:

1. **Explicit override** (any of engine/profile/voiceId/language defined) — unchanged.
2. **Thread voice override** — reserved slot; `null` in V5 (contract only).
3. **Agent voice** — `settings.voice.agentVoices[agentId]` when non-null. VALIDATED
   against live state (only when agentId present; one extra host RPC round, reusing the
   existing capabilities+profiles service fetches):
   - voiceKind=profile → profileId must exist in live profiles; else fall through.
   - voiceKind=preset → engine must exist and presetVoiceId must appear in that engine's
     non-null presets; else fall through.
   - Resolved to {engine, profile: profileId | null, voiceId: presetVoiceId | null}.
   - engine "qwen" + profile kind passes through (cloned profiles speak via engine qwen).
4. **Global default** — existing V4 logic verbatim (including the qwen-without-profile
   typed refusal). Global layer intentionally NOT revalidated server-side: V4 already
   repairs profile deletes renderer-side; avoids new RPCs on the hot path.

Fallback chain is therefore: agent → global → (V4 behavior). No random/silent fallback:
an invalid agent assignment degrades to the user's own global default, never to an
unrelated voice. Deleted custom voice → global default → no crash.

`agentId` arrives only from the renderer (which knows the thread's providerId). It is a
HINT for voice selection — it does not and cannot affect provider/account/model routing
(resolution happens after the response already exists; the speak route touches no
thread/provider state).

Master-OFF enforcement (all typed, `voice_disabled`, 403, retryable false,
"Voice is disabled. Enable it in Settings → Voice."):
- `speakVoiceText`, `transcribeVoiceInput`, `prepareVoiceSpeechRuntime` (keep-warm),
  profile mutations (create/update/delete/add/remove sample), model download/cancel,
  runtime repair → throw when `!voice.enabled`.
- `listVoiceSpeechProfiles` / `readVoiceSpeechCapabilities` / `readVoiceSpeechStatus`
  when disabled: return empty/stopped shapes WITHOUT any host RPC (no silent Voicebox
  start); responses carry `voiceEnabled: false`.
- start-server keep-warm prepare: gated on `enabled && keepWarm`.

### 3.4 Master-OFF resource release

New chain (server → plugin SDK → plugin host RPC → arc-voice-host):

- **HOST_DAEMON_PROTOCOL_VERSION bump REQUIRED** — new host RPC `ai.voice.release`.
- arc-voice-host: RPC `release`:
  1. best-effort `POST /models/unload` (Voicebox 0.5.0 verified; ignored on failure)
  2. `runtimeManager.stop()` (SIGTERM→SIGKILL, existing ownership guards)
  3. result `{ runtimeState: "stopped" | "not-running" }`
- Server `releaseVoiceSpeechRuntime(deps)`: drains in-flight speaks/transcribes
  (module-level counter incremented in speakVoiceText/transcribeVoiceInput; poll 250 ms,
  max 5 s) then calls service.releaseVoiceRuntime. Drain-then-release bounds the race
  between the renderer stopping playback and the settings save landing.
- Trigger points:
  - PUT /settings/general observing `enabled: true → false`: store settings, then
    fire-and-forget release (failure logged, never fails the PUT).
  - PUT observing `false → true` with `keepWarm`: fire-and-forget prepare (existing
    policy: warm means ready).
  - Server startup: keep-warm gated on enabled; no eager release (nothing to release
    on a fresh boot).
- Models on disk are NEVER deleted by OFF (no /cache/clear, no file removal).

### 3.5 Renderer

- `api.ts`: `speakVoiceText(text, {signal, agentId?})`; capabilities/status types gain
  `voiceEnabled`.
- `MessageSpeechContext.speak(messageId, text, agentId?)`; both call sites resolve
  `agentId = providerIdToAgentId(useThreadProvider().providerId)` — null for
  non-agent threads → global default. Auto-speak passes the same agentId.
- Master switch UI at top of VoiceSettingsSection ("Enable Arc Voice" toggle, default
  ON, persisted via the same whole-blob voice settings write).
- Agent Voices section: one row per agent (Codex / Claude Code / OMP); Select options:
  "Default voice" (null) → engine preset groups → My Voices profiles; per-row Preview
  via the existing `useVoicePreview` (shared non-overlap already enforced); a selected
  profile that no longer exists renders as "unavailable — using default" (server falls
  back; UI tells the truth).
- Disabled gating (hide or disable — chosen: hide action affordances, keep settings
  page inspectable):
  - composer mic (VoiceRecordingBar) hidden when `!enabled` (alongside showMicrophone)
  - Speak action hidden; auto-speak effect no-ops when `!enabled`
  - `useVoicePreview` refuses to start when `!enabled`; active preview stops on toggle
  - `useVoiceInput` refuses/aborts active capture when `!enabled`
  - `MessageSpeechProvider` effect: on enabled→false transition, `stop()` (halt audio,
    cancel in-flight generation)
  - Voice page: runtime action buttons (Repair, downloads) disabled with
    "Voice is disabled" hint; gallery/my-voices lists render their disabled state

### 3.6 Keep-warm interaction

- OFF always releases (overrides keep-warm and auto-speak — both gated on enabled).
- ON + keep-warm OFF → lazy (unchanged).
- ON + keep-warm ON → prepare at startup; after an OFF→ON transition with keep-warm
  set, prepare fire-and-forget (re-warm).

## 4. Lifecycle invariant (for the SDD record)

`voice.enabled == false` ⇒ within ~seconds: zero in-flight voice work, no Voicebox
process owned by Arc, no loaded model resident in RAM/VRAM, all voice entry points
(speak/transcribe/preview/record/download/repair) return typed `voice_disabled`,
settings/galleries remain inspectable without starting the runtime, and no voice
resource is reacquired until `enabled == true`. OFF/ON cycles never mutate agent
mappings, global selection, downloaded models, or custom profiles.

## 5. Test plan

- domain: schema — pre-V5 blob parses with enabled=true + null agentVoices; agentVoices
  round-trip; invalid agent key rejected.
- contract: speak request agentId enum; capabilities/status voiceEnabled.
- server (voice-speech.test.ts + routes): per-agent resolution for codex/claude/omp;
  explicit override beats agent; unknown/absent agentId → global; deleted profile →
  global; vanished preset → global; qwen agent voice with profile speaks; OFF refuses
  speak/transcribe/prepare/mutations with voice_disabled and performs NO host RPC
  (fake call counts); capabilities/profiles when OFF return empty without host RPC;
  release drains in-flight then releases; enabled→disabled PUT triggers release;
  keep-warm startup gate.
- plugin-sdk + arc-core + arc-voice-host: release SDK member + host RPC handler;
  host release = unload best-effort + stop; unload failure still stops.
- renderer: agentVoices update helper; agent row select/preview wiring; unavailable
  assignment display; enabled gates (mic/speak/auto-speak/preview) as pure helpers +
  component tests where a harness exists; preview non-overlap regression.
- Regressions: full @bb/app voice + timeline suites, @bb/server, arc-voice-host,
  plugin-sdk, bb-plugin-arc-core, @bb/domain.

## 6. Installed-app smoke

1. Assign codex → kokoro `af_heart`, claude-code → a second kokoro preset; speak with
   each agentId; both 200; Voicebox history records distinct voice ids.
2. Load a model (speak), then disable Voice: playback/mic/preview blocked; within
   seconds `pgrep voicebox` empty; process RSS freed; `du` shows model files intact.
3. Restart Arc: still disabled; agent mappings intact; enable → mappings intact,
   speak lazy-starts runtime (no process until first speak), works.
4. Keep-warm ON + master OFF → no runtime after startup settle.

## 7. Memory policy (user-directed, added during V5)

User requirement: keep RAM/swap small — prefer Qwen 0.6B and offload models unless in use.

Live-probed facts (2026-09-24, Voicebox 0.5.0):
- `/speak` body has NO model field (engine/language/personality/profile/text only);
  model choice for engine=qwen cloned speak is Voicebox-internal.
- With BOTH qwen-tts-0.6B and qwen-tts-1.7B downloaded, a cloned speak loaded and used
  **1.7B** (generation record `model_size:"1.7B"`). Voicebox prefers the larger model.
- Voicebox exposes no config knob for model size (settings DB and /settings/generation
  cover chunking/audio only).
- Voicebox's downloaded-detection is strict; a pre-existing but unrecognized HF cache
  triggered a full re-download. Arc must treat "downloaded" as Voicebox-reported state
  only (never its own filesystem guess) — consistent with the standing rule.

Design consequences:
- **DECISIVE PROBE (2026-09-24, live)**: with qwen-tts-1.7B ABSENT and qwen-tts-0.6B
  downloaded, a cloned speak (`engine=qwen` + profile) **auto-downloaded qwen-tts-1.7B**
  and targeted `model_size:"1.7B"`. With both present, both cloned speak and
  qwen_custom_voice preset speak pick 1.7B (`model_size:"1.7B"` in every generation
  record). **Voicebox 0.5.0 hard-requires/prefers the 1.7B qwen models; there is no
  supported 0.6B-only mode for any qwen voice path.** Arc therefore keeps the
  renderer's cloned-voice gate on `qwen-tts-1.7B` (it is what Voicebox will use) and
  represents 0.6B accurately: downloadable, never auto-preferred, usable only if
  Voicebox upstream adds a selector. No fake "0.6B default" is offered.
- **0.6B-first (where Voicebox allows)**: applies nowhere in qwen today; recorded as a
  capability falsehood to avoid. The real memory levers are the two below.
- **Offload unless used**: new voice setting `releaseModelsAfterUse` (default TRUE per
  user direction). After each speak/transcribe completes (success or failure), the
  host unloads every loaded model (frees RAM/VRAM; the process stays up so the next
  operation only pays model-load, not process boot). This composes with keep-warm
  (process warm, models cold) and with master OFF (process gone entirely). Unload
  failures are logged, never surfaced.
- **Voicebox quirk (live-probed during V5 smoke)**: the global `POST /models/unload`
  is a NO-OP for the resident model — it returns success but the loaded TTS model
  stays resident. Per-model `POST /models/{name}/unload` genuinely unloads and lazy
  reload still works. The host client therefore reads /models/status and issues
  per-model unloads for every loaded model.
- Disk models are never deleted automatically; "prefer 0.6B" never removes files the
  user downloaded.

## 8. Risks / decisions

- Protocol bump v216→v217 for ai.voice.release + ai.voice.unloadModels (enrolled
  daemons update; old daemons reject the unknown RPC — release then logs and
  no-ops, settings PUT still succeeds).
- Capabilities/profiles-while-OFF return empty rather than last-known snapshots:
  truthful (nothing is running), prevents any silent runtime acquisition.
- 5 s in-flight drain is best-effort; a pathological >5 s generation may be killed by
  release — acceptable (the user just asked for release; renderer aborts fetches first).

## 9. Review record

- Cycle 1 (independent report-only reviewer): PASS — 1 medium + 3 lows, no
  critical/high. Medium: unload-after-use could unload models mid-speak (no
  serialization). Lows: qwen_custom_voice-without-profile surfaced as 502 not the
  deliberate 400; agent-validation RPCs sat outside the release-drain counter;
  release maps transient request_failed to not-running (old-daemon accommodation).
- Fix cycle (all applied): host-side in-flight speak counter with settle
  notification; unloadModels drains up to 2 s and skips the unload if a speak is
  still running (release() still unloads unconditionally before stop); extended the
  qwen guard to qwen_custom_voice without profile AND voiceId; voiceOperationStarted
  moved before resolution so validation RPCs sit inside the release-drain window
  (counter balanced on every path — verified); request_failed accommodation kept and
  documented.
- Cycle 2 re-review: PASS — all 4 findings RESOLVED with file:line evidence, no new
  defects.
