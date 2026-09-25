# Arc Voice V7 — SDD: Full Voice Mode + Cinematic UI

Status: AWAITING APPROVAL (Terrain SDD; supersedes plan doc §16 where more specific)
Verified context: V0–V6 PASS (PHASE_STATE). V6 closed 2026-09-25. All mechanics
Voice Mode composes are shipped and live-proven: renderer STT (useVoiceInput,
WAV normalization, silence/energy guards), TTS (speakVoiceText + server-side
deriveSpeakableText, chunked), per-agent voices, master ON/OFF, coordinator
sole-slot playback, releaseModelsAfterUse.

## 1. Scope

A dedicated full-window **Arc Voice Mode** bound to a real thread: speak → STT →
the thread's agent → streamed visual answer (normal Arc rendering) + TTS →
barge-in → listen again. Original Arc-branded voice ring with REAL microphone
and REAL TTS amplitude. State machine Idle/Listening/Transcribing/Thinking/
Speaking/Interrupted/Error. Voice response detail option (Brief/Balanced/Read full).

Explicit non-goals: no new conversation system (every turn lands in the bound
thread via the existing send path); no agent/account/model routing changes; no
wake-word; no new host/daemon surface; V8 features.

## 2. Verified existing architecture (inspected this phase)

- Send path: `useSendThreadMessage()` (hooks/mutations/thread-runtime-mutations.ts:165)
  → `sdk.threads.send({threadId, input, ...})` — the same mutation the composer
  uses; Voice Mode submits transcribed text through it (model/permission/etc.
  omitted → thread's own execution options apply).
- STT: `useVoiceInput({scopeKey})` (hooks/useVoiceInput.ts:119) returns
  {state, stream, start, stop, cancel, isRecording, isProcessing}; records →
  normalizes to WAV → POST /system/voice-transcription; guards (10-min cap,
  silence/energy, repetition) built in; stops on master OFF.
- TTS: `speakVoiceText(text, {signal, agentId})` → Blob; `chunkSpeechText`
  (600-char fence-aware); server `deriveSpeakableText` strips code/diffs/logs
  (cap 1200). Message speech pattern (message-speech.tsx) is the reference
  player; V6 coordinator gives sole-slot playback.
- Per-agent voice: `providerIdToAgentId` (ProviderUsageSection.tsx:34);
  thread DTO carries providerId.
- Master OFF: settings `voice.enabled`; server 403s voice routes; renderer
  VoiceEnabledContext; AutomationVoiceHost pattern for ws-driven voice.
- Routes: `/projects/:projectId/threads/:threadId` (projectless:
  `/threads/:threadId`) — client-core route-paths.ts:200.
- Timeline rendering: ThreadTimelineSurface / ThreadTimelinePanelContent render
  the full grammar (markdown, code, diffs, tool cards) and are mountable per
  surface (implementation picks the timeline-only surface; MessageSpeechProvider
  is per-surface so a second mount is safe).

## 3. Design

### 3.1 Placement and navigation

- IMPLEMENTATION AMENDMENT (source-verified): the workspace is path-driven
  through `useRouteState` + the split-layout content model, so a new `/voice`
  route would churn the pane system. Voice Mode is therefore a **full-screen
  overlay** bound to the current route's thread, opened via a session atom
  (`voiceModeOpenAtom`) and closed by Exit/Esc — the URL, panes, and thread
  state are untouched, which makes "part of the same thread" literal. Thread
  switching while open rebinds the overlay to the newly focused thread and
  resets the session (SDD's rebind semantics unchanged).
- Enter via a Voice button in the thread header. Exit (X / Esc / Stop-and-exit)
  closes the overlay. All turns, transcripts, and agent output remain in the
  bound thread's normal timeline.
- Agent chip shows the bound thread's agent (from thread.providerId). Choosing
  a different agent = the existing thread switcher (Voice Mode rebinds to the
  newly opened thread; session state resets). No voice-specific threads.
- Master Voice OFF ⇒ entry is refused with a "Enable Arc Voice in Settings →
  Voice" affordance; turning OFF mid-session stops capture/playback and exits.

### 3.2 State machine (pure module `voice-mode-state.ts`, fully unit-tested)

```text
Idle ──mic──▶ Listening ──utterance end──▶ Transcribing ──text──▶ Thinking
Thinking ──assistant row completed──▶ Speaking ──playback end──▶ Listening (auto-loop)
Speaking ──barge-in energy──▶ Interrupted ──▶ Listening (immediate)
any ──error──▶ Error ──ack/dismiss──▶ Idle
Listening/Transcribing ──cancel──▶ Idle
```

- The machine is a framework-free controller (injectable effects: start/stop
  capture, transcribe, send, speak, stopSpeaking, detect barge-in). React binds
  events to it; it exposes state + a coarse amplitude channel for the ring.
- Auto-loop: Speaking → Listening when `behavior` allows (continuous mode is
  inherent to Voice Mode; explicit Stop/Exit ends the session to Idle).
- Interrupted: contraction visual + immediate capture restart; queued TTS
  chunks cancelled via the V6 coordinator (voice-mode registers as an owner).

### 3.3 Barge-in (`barge-in-detector.ts`, pure logic + thin WebRTC shell)

- During Speaking, a lightweight analyser stream (getUserMedia +
  AnalyserNode, echoCancellation/noiseSuppression ideal constraints) computes
  mic RMS; energy over an adaptive threshold for N consecutive windows ⇒
  barge-in. Threshold logic is a pure, unit-tested function (fixed-point RMS
  smoothing, hangover, cooldown, minimum-utterance duration).
- On barge-in: stop TTS audio + abort in-flight/queued speak fetches (session's
  own AbortController), release the coordinator slot, machine → Interrupted →
  Listening. Full-capture recorder for the new utterance is the normal
  useVoiceInput path.
- Echo safety: TTS plays through the session Audio element; AEC constraints on
  the detector stream prevent self-triggering; a cooldown after TTS stop
  ignores residual echo.

### 3.4 Voice Ring (`voice-ring-canvas.ts` + `VoiceRing.tsx`)

- Canvas 2D, one rAF loop owned by a vanilla animator class; React only mounts
  and passes state changes (never per-frame).
- Listening: ring/waveform amplitude = live mic RMS (AnalyserNode on the
  capture stream), quick inner response, slower outward propagation ripples.
- Speaking: amplitude = TTS Audio element analysed via MediaElementSource +
  AnalyserNode on a session AudioContext; outward propagation synced to the
  real signal.
- Thinking: calm procedural orbital motion (slow segmented rotation, soft core
  pulse) — deliberate, not audio-reactive, per plan.
- Transcribing: contraction + pulse. Interrupted: fast contraction (one-shot).
- Reduced motion (`prefers-reduced-motion`): static ring + state text only;
  no propagation/particles. 60 FPS target: transforms-only canvas draws,
  amplitude via shared Float ref, no allocations in the frame loop.

### 3.5 Visual answer panel

- The Voice Mode layout: header (Arc Voice + Exit) / central ring + state text
  / answer panel showing the BOUND THREAD's timeline surface (read-only:
  streaming rows, markdown, code highlighting, diffs, tool cards — exactly the
  normal renderer) / control bar (Mic | Agent | Voice detail | Stop/Exit).
- Wide: ring left, answers right; narrow: ring top, answers below (scroll
  independently). Long code never displaces the ring (fixed ring region).

### 3.6 Spoken-answer policy + Voice response detail

- Server `deriveSpeakableText` already strips fences/diffs/JSON/logs (cap 1200)
  — Balanced behavior, unchanged.
- New request field `detail: "brief" | "balanced" | "full"` on /system/voice-speak
  (contract + api + renderer): brief = derived text trimmed to ≤400 chars at a
  sentence boundary; balanced = today; full = cap raised to 4000 (still chunked
  ≤1200 per request). Voice Mode UI: three-way control bound to the request;
  default balanced. Code is never read line-by-line in any mode (server-side
  strip is the hard gate).
- HOST_DAEMON_PROTOCOL_VERSION unchanged (the speak RPC schema already carries
  extensible input fields — detail rides the existing ai.voice.speak input; if
  the SDK schema is strict, add the field there without a version bump since
  unknown fields are rejected by old hosts — VERIFY at implementation; fallback
  is renderer-side truncation for brief, keeping the wire unchanged).

### 3.7 V2–V6 protections (inherited)

Master ON/OFF (entry gate + mid-session stop), lazy runtime startup, keepWarm,
releaseModelsAfterUse (server-side after each speak), STT noise/silence guards,
repetition guard, clean-text TTS gate, per-agent voices (agentId from the bound
thread), coordinator no-overlap (voice-mode owner), safe runtime ownership —
none re-implemented.

## 4. Test plan

- voice-mode-state: every transition incl. error ack, cancel paths, auto-loop,
  Interrupted fast-path; no transition on stale async completions (generation
  counter like message-speech).
- barge-in-detector: pure threshold/hangover/cooldown matrix (silence, noise,
  spike, sustained), adaptive floor, residual-echo cooldown.
- voice-ring-canvas: animator maps amplitude→radius/waveform (deterministic
  fake clock); reduced-motion flag short-circuits to static draw; no per-frame
  React renders (component test asserting render count stable across frames).
- server: deriveSpeakableText detail modes (brief trims at sentence boundary,
  full cap 4000, strip invariants unchanged); speak route passes detail.
- VoiceModeView (jsdom, faked capture/speak): enter/exit, full happy path with
  injected transcript, barge-in during speaking stops audio and restarts
  listening, master OFF refuses entry and mid-session OFF tears down, error
  recovery, thread switch rebind, visual panel renders injected rows.
- Regressions: @bb/app voice suites (V2–V6), @bb/server voice routes, contract.

## 5. Installed-app smoke (conversational)

speak Q1 → visible streamed answer + heard answer → interrupt mid-speech →
ask Q2 → correct answer; switch agent → per-agent voice follows; master OFF
refuses entry; reduced motion; normal chat regression; V2–V6 voice regression;
zero orphans after exit and quit.

## 6. Risks / decisions

- **AudioContext + MediaElementSource**: requires the TTS element to be
  created before src assignment and never re-routed; one session AudioContext,
  closed on exit. Blob URLs are same-origin (safe).
- **Two MediaStreams** (capture + detector) — macOS allows concurrent mic
  streams; detector stops when not Speaking.
- **Auto-loop listening** continues until explicit Stop/Exit — matches the
  plan's continuous experience; mic indicator (and macOS amber dot) persist
  during Voice Mode by design.
- **detail wire field**: if adding it to the host RPC input proves to need a
  protocol bump with old-daemon fallout, ship brief-mode as renderer-side
  truncation and keep the wire unchanged (decision recorded at implementation).
- Timeline surface re-mount: MessageSpeechProvider is per-surface; auto-speak
  is disabled inside Voice Mode (Voice Mode owns speech) to avoid double-speak.
