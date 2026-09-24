# Arc Voice V4 SDD — Settings → Voice + Voice Gallery + STT Hardening

Status: PLAN (approved design artifact; TASK implements from this only)
Prior phases: V0/V1/V2/V2.1/V2.2/V2.3/V3 all PASS (see `arc-voice-phase-state.md`)
Sources: `docs/ARC_AGENT_MANAGED_VOICE_INTEGRATION_PLAN_UPDATED.md` §11/§14, V4 follow-up
attachment (STT noise/hallucination hardening), live Voicebox 0.5.0 API probe
(2026-09-24, disposable data dir, OpenAPI + real mutations, transcript below).

---

## 1. Verified external contract (Voicebox 0.5.0, live-probed)

Probe transcript (all against the real pinned binary, disposable `--data-dir`):

- `GET /openapi.json` (103,857 bytes) enumerates the full route surface.
- `GET /models/status` → catalog of 18 models; the ones Arc V4 cares about:
  `whisper-base/small/medium/large/turbo` (STT), `kokoro`, `qwen-tts-0.6B`,
  `qwen-tts-1.7B`, `qwen-custom-voice-0.6B`, `qwen-custom-voice-1.7B` (TTS);
  each entry `{model_name, display_name, hf_repo_id, downloaded, downloading, size_mb, loaded}`.
- `POST /models/download` body `{model_name}` (on-demand; progress via existing
  `GET /models/progress/{model}` SSE that V3 already normalizes).
- `GET /profiles` → bare array of profile objects:
  `{id, name, description, language, avatar_path, effects_chain, voice_type,
  preset_engine, preset_voice_id, design_prompt, default_engine, personality,
  generation_count, sample_count, created_at, updated_at}`.
- `POST /profiles` body (only `name` required, max 100):
  `{name, description?, language? (regex ^(zh|en|ja|ko|de|fr|ru|pt|es|it|he|ar|da|el|fi|hi|ms|nl|no|pl|sv|sw|tr)$),
  voice_type? (cloned|preset|designed), preset_engine?, preset_voice_id?, default_engine?,
  design_prompt?, personality?}`. Verified: created cloned profile returned full object with
  `sample_count: 0`.
- `PUT /profiles/{id}` → rename/description update (verified: rename works).
- `DELETE /profiles/{id}` → 200, profile gone (verified).
- `POST /profiles/{id}/samples` → multipart `{file: WAV bytes, reference_text: string}`,
  both required. Verified with a synthetic 2 s 16 kHz WAV: returned
  `{id, profile_id, audio_path, reference_text}` (~34 s server-side, transcription-quality work).
- `GET /profiles/{id}/samples` → array (verified; used to obtain sample id).
- `DELETE /profiles/samples/{sample_id}` → 200 (verified).
- `GET /profiles/presets/{engine}` → `{engine, voices: [{voice_id, name, gender, language}]}`.
  Verified: kokoro → 50 voices (en + others); qwen_custom_voice → curated presets
  (Vivian, Serena, Uncle_Fu, Dylan, Eric — all `zh`); qwen → empty (cloning-only engine).
- `POST /transcribe` response is exactly `{text, duration}` — **no no-speech probability,
  no confidence, no segments**. Arc must not invent confidence values (follow-up rule 3).
- `POST /speak` body fields exactly `{text(≤10000), profile?, engine?
  (^(qwen|qwen_custom_voice|luxtts|chatterbox|chatterbox_turbo|tada|kokoro)$), language?,
  personality?}`. **No speed field, no instruction/delivery field.** V4 therefore exposes
  playback speed renderer-side only (HTMLAudioElement `playbackRate` +
  `preservesPitch` — no Voicebox support required, honestly labeled as playback speed).

### Engine capability matrix (drives the capability-driven UI) — LIVE-VERIFIED 2026-09-24

| engine | preset voices | cloning | model | notes |
|---|---|---|---|---|
| kokoro | yes (50, multi-language) | no | `kokoro` (~327 MB) | V3 default; `af_heart` verified |
| qwen | **none** | yes — cloned profiles speak ONLY through this engine | `qwen-tts-0.6B`/`1.7B`; Voicebox picks `qwen-tts-1.7B` (4.54 GB) for cloned speak and auto-downloads it on demand | cannot speak without a cloned profile |
| qwen_custom_voice | yes (9 curated, zh-dominant) | **no — rejects cloned profiles** (`Engine 'qwen_custom_voice' does not support cloned voice profiles`, live-probed) | `qwen-custom-voice-0.6B`/`1.7B` (4.16 GB) | presets only; first use = large download |
| chatterbox / luxtts / tada | unverified by Arc | unverified | — | **hidden** in V4 UI (only show what Arc verified) |

Correction made during V4 review: cloned/custom voices use engine `qwen` (not
`qwen_custom_voice`); the UI's model gate for custom voices is `qwen-tts-1.7B`,
which Voicebox auto-downloads on speak if absent — pre-downloading with progress
in the create/preview flow prevents /speak from stalling past its 180 s budget.

Rules: engines are not interchangeable. Selecting an engine that requires a
model/profile must explain the requirement and download/create on demand only
when the user commits. No automatic downloads. No silent engine fallback — an
engine that cannot serve the request returns a typed error the UI surfaces.

---

## 2. Settings ownership

Source of truth (survives restart, server-owned):

```
persisted Arc settings (appSettingsValues KV, `voice` key of AppSettings)
  ↓  read per call
apps/server voice services (voice-speech.ts, voice-transcription.ts)
  ↓  explicit values on RPC / HTTP
Arc Voice Service (arc-voice-host runtime → Voicebox)
```

- Env vars `ARC_VOICE_TTS_ENGINE` / `ARC_VOICE_TTS_VOICE` remain fallback/default
  overrides resolved at the host boundary only; the user-facing mechanism is Settings.
- Renderer never hardcodes engine defaults; renderer reads settings via the existing
  general-settings query and writes via the existing general-settings mutation.

## 3. Persistence model

Extend `packages/domain/src/app-settings.ts`:

- `voiceSettingsSchema` (strict zod object):
  - `stt: { model: enum(whisper-base|small|medium|large|turbo), language: string|null (null=auto) }`
    default `{model: "whisper-base", language: null}` — current verified behavior stays default.
  - `tts: { engine: enum(kokoro|qwen|qwen_custom_voice), voiceKind: enum(preset|profile),
    presetEngine, presetVoiceId, profileId: string|null, playbackSpeed: number 0.5–2.0 }`
    default kokoro preset `af_heart`, speed 1.0 — V3 default preserved.
  - `input: { reduceBackgroundNoise: boolean }` default true (follow-up §Settings).
  - `behavior: { showMicrophone: boolean, autoSpeakReplies: boolean, keepWarm: boolean }`
    defaults `{true, false, false}`. Push-to-talk: **deferred** (existing implementation
    cannot support it cleanly without a dedicated voice session — V5).
- `appSettingsSchema` gains `voice: voiceSettingsSchema`; `defaultAppSettings` gains the
  default block. `getAppSettings` per-key safeParse already skips unknown keys → old DB
  rows parse to defaults (no migration needed).

Why the whole blob and not a new route: `PUT generalSettings` already round-trips the
full `AppSettings`; the strict schema extension flows through `apps/server/src/routes/system.ts`,
`server-contract` (`generalSettings` response / update schema union), and the renderer's
existing `settings-mutations.ts` with zero new routes for reads/writes.

Microphone device id: stays in the existing renderer `audioInputDevicePreference`
localStorage atom (browser-scoped enumeration; already survives restart; moving it server-side
buys nothing). Voice settings UI edits it through the existing hook.

## 4. Runtime configuration flow

1. Settings page writes `voice` block via existing general-settings mutation.
2. Server voice services read `getAppSettings(deps.db).voice` on every call:
   - `speakVoiceText` passes explicit `engine`/`profile` (from settings; env fallback
     when field absent) into `ai.voice.speak` — fields already exist in the RPC (no bump).
   - `voice-transcription` passes explicit STT model + language into `ai.voice.transcribe`.
3. Host (`plugins/arc-core/src/voice-host.ts`):
   - `ai.voice.transcribe` currently rejects `model !== "default"` → extend accepted
     values to the whisper catalog, map `language`, forward to `/transcribe` multipart
     (`model`, `language` fields already exist there per V0 contract).
   - TTS: when no profile exists for a preset selection, `ensureProfile` creates the
     "Arc Voice"-style preset profile per engine/preset (V3 mechanism, generalized:
     profile name keyed per selection, e.g. `Arc Voice · <PresetName>`); for engine
     `qwen` without a cloned profile → typed refusal, never a silent kokoro fallback.
4. Wire changes → **bump `HOST_DAEMON_PROTOCOL_VERSION` (215 → 216)**:
   `ai.voice.transcribe` input gains `language: string|null` and `model` accept-set
   widens; `ai.voice.status` output gains `version: string|null`, `engines` capability
   array, and `models` status array; new RPCs `ai.voice.profiles` (list/create/update/
   delete/samples add-remove) and `ai.voice.models` (status/download/cancel) are added
   to the experimental AI-services host contract. (Renderer-facing routes in
   `server-contract` under `/api/v1/system/voice-*`.)

## 5. Capability model

Host assembles, renderer renders only what it receives:

```
VoiceCapabilities {
  runtime: { state, version, models: [{name, displayName, downloaded, downloading,
            loaded, sizeMb, downloadPercent|null}] },
  engines: [{ engine, presetVoices: [{voiceId, name, gender, language}] | null
              (null = engine not viable without cloned profile),
              requiresClonedProfile: boolean,
              model: {name, downloaded, downloading, loaded, downloadPercent|null} }]
}
```

Source: `GET /models/status`, `GET /profiles/presets/{engine}`, `GET /profiles` — all
through the host; the renderer never talks to Voicebox and never guesses filesystem state.
Already-downloaded Qwen data from V3 probing is detected via `/models/status`
(`downloaded: true`) — no redownload, no renderer filesystem access.

## 6. Download lifecycle

- Only explicit user actions trigger `POST /models/download` (engine selection that
  needs the model, custom-voice preview/save, gallery preview of an undownloaded engine).
- Progress: existing SSE normalization (`voiceModelProgress`, V3) surfaced with real
  percentages (fixes the V3 unresolved "no percentage on first-use download").
- Downloading state disables the committing control and shows progress; cancel via
  `/models/download/cancel` exposed as Cancel during download.
- Selection of a not-downloaded engine is allowed (queued intent) but Preview/Save
  block until downloaded, with the download offered in place.

## 7. Preview lifecycle

- Preview = `speakVoiceText` (real TTS through the full stack) with the candidate
  engine/preset/profile and a fixed neutral preview phrase (same phrase for all cards
  so comparisons are meaningful).
- One shared preview controller (single HTMLAudioElement): starting a preview aborts
  the in-flight request and stops the previous playback — previews never overlap;
  the speaking card shows Stop; completion returns the card to ▶ Preview.
- Reuses V3's proven ownership pattern (abort in-flight, revoke object URLs, teardown
  on switch/unmount). V3 message Speak remains a separate controller so thread
  playback and settings preview can never share state.

## 8. Custom voice lifecycle ("My Voices")

Flow (all Voicebox profile API via new host RPC; Arc stores only the reference):

```
+ Create Custom Voice
  → consent checkbox (required): "I own this voice or have permission to use it.
     Your sample stays local on this device." (no cloud upload, no hidden copies)
  → Record (reuse V2 capture → WAV normalization, 10–30 s guidance) OR upload WAV
  → Arc transcribes the sample locally (existing STT path) to prefill reference text
  → user reviews/corrects reference text (never silently guessed)
  → Arc picks cloning engine: qwen_custom_voice (verified en-capable clone engine for V4;
    Arabic falls back per capability model — only engines Voicebox reports are shown)
  → create profile (voice_type cloned) → add sample (multipart file + reference_text)
  → preview (downloads clone model on demand with progress + cancel)
  → name + save → Arc settings store {profileId, name}
```

Management per custom voice: Preview, Rename (PUT), Add sample, Remove sample
(DELETE by sample id), Set as default, Delete. Delete = confirmation dialog →
`DELETE /profiles/{id}` (removes Voicebox profile + samples + audio files) → remove
Arc references; if the deleted profile was the selected TTS voice → fall back to the
default preset (kokoro/af_heart) visibly, never silent. Arc duplicates no audio or
embeddings — Voicebox owns the data inside its Arc-controlled data dir.

## 9. STT input-quality / hallucination guard (V4 hardening)

Pipeline: microphone → browser constraints → silence detection → existing
normalization → Whisper → transcript quality guard → composer.

1. **Capture constraints** (`buildAudioInputConstraints` in
   `apps/app/src/lib/audio-input-device-preference.ts`): add
   `echoCancellation/noiseSuppression/autoGainControl: true` as ideal constraints
   (bare values = ideal, unsupported ones are ignored by the platform — recording
   never fails because of them). Applied when `voice.input.reduceBackgroundNoise` is on.
2. **Silence detection**: pure function over the already-rendered 16 kHz mono PCM in
   `voice-audio-normalization.ts` (windowed RMS; near-silence across the whole capture
   → skip Whisper entirely). Lightest possible approach: zero new dependencies, and it
   measures exactly the bytes Whisper would see.
3. **Whisper no-speech signal**: not available — `/transcribe` returns `{text,duration}`
   only. Documented; not invented.
4. **Repetition/hallucination guard**: conservative pure function on the normalized
   transcript. Detects pathological repetition (a short phrase repeated many times
   covering the bulk of the output, e.g. "hahaha hahaha hahaha …", "thank you thank you
   …") without blacklisting normal words. Genuine short "haha", normal repeated words,
   Arabic/English mixed speech, technical terms, short dictation pass through.
5. **On rejection**: insert nothing, preserve the existing draft untouched, surface
   "No clear speech detected. Try again." (toast, same channel as existing dictation
   errors). No auto-send ever.

Settings surface: one user-facing toggle `Reduce background noise` (default on).
All thresholds internal. Guard functions unit-tested with the acceptance matrix below.

## 10. Settings → Voice UI structure

New nav section `voice` ("Voice", general group) in `settings-sections.ts`, page
`apps/app/src/components/settings/` voice section:

- **Runtime**: Status (from `voice-status` + new capabilities payload), Version,
  model/runtime state per engine, Repair (new `POST /system/voice-repair` →
  `ai.voice.repair`; not auto-triggered).
- **Speech to Text**: Engine (Whisper — fixed, shown read-only), Model
  (base/small/medium/large/turbo — only if `downloaded`/offered with download flow),
  Language (Auto + the Voicebox language set), Microphone (existing device picker),
  Test microphone (local record/playback + level meter; no Whisper call),
  `Reduce background noise` toggle.
- **Text to Speech**: engine picker (capability-driven; qwen explains cloned-profile
  requirement), Voice (preset gallery or my-voices depending on engine), playback
  speed (renderer-side, 0.5–2.0), Preview.
- **Voice Gallery**: Recommended presets + full preset grid grouped by engine,
  each card: friendly name, short character description, language, ▶ Preview/Stop,
  selected state; engine/model details only under Advanced.
- **My Voices**: custom voice cards (name, sample count, language, Custom Voice
  badge) + Create flow (§8) + management actions.
- **Behavior**: Show microphone in composer (wires existing mic visibility),
  Automatically speak replies (opt-in; when on, completed assistant rows auto-speak
  visible text through the V3 gate), Keep voice runtime warm (opt-in prepare at
  startup), push-to-talk omitted.
- **Advanced** (collapsed): engine enum, model IDs, backend, profile IDs, model
  storage per model (downloaded/loaded/size), runtime details. Normal users never
  need MLX/PyTorch/model IDs.

## 11. Error / fallback behavior

- Engine cannot serve (model missing + download declined/failed, qwen without
  cloned profile, Voicebox error): typed failure surfaced in place; the user's
  current selection is left unchanged; **no silent engine substitution**.
- Deleted/invalid selected voice (profile gone after restart): status/capabilities
  read detects dangling `profileId` → UI shows fallback state and offers reselect;
  speak calls fail typed, not with a wrong voice.
- Repair: explicit user action; reuses V1 repair (verify/re-activate, never
  redownload) — result reported truthfully.
- All V2/V2.3 timeout/lifecycle protections unchanged: budgets, cancellation,
  ownership adoption, orphan guard, no launch-time voice work (except optional
  keep-warm), renderer never sees Voicebox path/port/token.

## 12. Test / acceptance plan

Focused tests (no broad suites mid-flight; final validation broadens):

- domain: voice settings schema defaults/parse, old-row compatibility.
- server: settings drive speak/transcribe args (settings win, env fallback);
  new voice routes; repair route.
- arc-voice-host + arc-core plugin: transcribe model/language mapping; profiles RPC
  CRUD mapping; models status/download/cancel; capability assembly; refusal paths.
- app: settings page (engine switching truthfulness, download-on-demand gating),
  gallery preview (no overlap, stop, cleanup), custom voice flow (consent gate,
  reference-text correction, fallback on delete), repetition guard + silence guard
  matrix: silence / low-level noise / repeated hallucinated phrase / genuine short
  "haha" / normal English / Arabic-English mixed / draft preserved / cancel /
  unsupported-constraints fallback.
- Regression: V2/V2.1/V2.2/V2.3/V3 focused suites re-run (Speak/Stop, cold/warm
  dictation phases, cancellation, thread switching, runtime ownership, clean-text
  TTS gate).
- Installed-app smoke: packaged build; settings persist across restart; real STT/TTS
  driven by saved settings; noisy-input mic smoke (no absurd repeated transcript);
  no orphan voicebox after quit.

Final V4 report must include:

```
STT noise suppression:
silence/no-speech guard:
repetition guard:
false-positive checks:
Arabic/English regression:
installed-app noisy-input smoke:
```

## 13. Out of scope (V4)

Voice Mode / push-to-talk sessions, per-agent voice assignment, automation voice,
speed at synthesis level (Voicebox has no field), delivery/instruction controls
(Voicebox `/speak` has no instruction field), celebrity-voice requests, non-verified
engines (chatterbox/luxtts/tada), Qwen model default switch (kokoro stays default;
Qwen is opt-in and truthful about its profile requirement).
