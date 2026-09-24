# Arc Agent — Managed Voice & Speech Integration Plan

**Status:** Proposed  
**Roadmap:** Phase 26  
**Primary integration:** `jamiepine/voicebox`  
**Target platforms:** macOS, Windows, and Linux  
**Goal:** Add local STT/TTS to Arc without turning Arc into a voice studio.

---

## 1. Product goal

Arc should gain a first-class **Voice** capability:

- 🎙 Speech-to-text directly into the thread composer.
- 🔊 Text-to-speech for agent replies.
- Local voice models.
- Voice profiles.
- Optional different voices for Codex, Claude Code, and OMP.
- Voice output from Arc Automations.
- A later full conversational Voice Mode.

Voicebox should be used as a **managed internal runtime**. Arc owns the UX, lifecycle, permissions, updates, and integration.

```text
Arc Agent
  ↓
Arc Voice Service
  ↓
Managed Voicebox Runtime
  ├─ Whisper / MLX STT
  ├─ Kokoro
  ├─ Qwen3-TTS
  ├─ Chatterbox
  └─ Voice profiles/models
```

Do **not** embed the full Voicebox application UI into Arc.

---

## 2. Why Voicebox

Voicebox already provides the difficult speech layer:

- Whisper STT.
- Apple Silicon MLX support.
- Multiple TTS engines.
- Voice profiles and cloning.
- REST API.
- MCP support.
- Model management.
- Local-first operation.
- Agent voice output.

Useful current interfaces include:

```text
POST /transcribe
POST /speak
/mcp
```

Arc should mainly call Voicebox through its own backend instead of configuring Voicebox MCP independently inside each coding agent.

---

## 3. Architecture

```text
┌─────────────────────────────────────────────┐
│ Arc Agent                                   │
│                                             │
│ Thread UI                                   │
│   🎙 Record → STT → Composer               │
│   🔊 Speak → TTS → Audio                   │
│                                             │
│ Arc Voice Domain                            │
│   transcribe()                              │
│   speak()                                   │
│   stopSpeaking()                            │
│   listProfiles()                            │
│   createProfile()                           │
│   addProfileSample()                        │
│   updateProfile()                           │
│   deleteProfile()                           │
│   previewProfile()                          │
│   getStatus()                               │
│                                             │
│ Arc Voice Runtime Manager                   │
│   install/start/stop                        │
│   health/repair/update/rollback             │
│   models/runtime version                    │
└──────────────────┬──────────────────────────┘
                   │ loopback only
                   ▼
        ┌──────────────────────────┐
        │ Voicebox managed runtime │
        └──────────────────────────┘
```

Arc's renderer should never directly own:

- Voicebox executable paths.
- Voicebox process lifecycle.
- Internal API tokens.
- Runtime environment.
- Model filesystem implementation.

All access should pass through Arc's backend/RPC boundary.

---

## 4. Arc-owned voice API

Recommended logical contract:

```ts
voice.getStatus()
voice.prepare()
voice.repair()

voice.transcribe(...)
voice.speak(...)
voice.stopSpeaking()

voice.listProfiles()
voice.getProfile(...)
voice.createProfile(...)
voice.updateProfile(...)
voice.deleteProfile(...)
voice.addProfileSample(...)
voice.removeProfileSample(...)
voice.previewProfile(...)
voice.setDefaultProfile(...)

voice.listModels()
voice.downloadModel(...)
voice.removeModel(...)
voice.unloadModel(...)
```

Agents should see Arc tools, not raw Voicebox internals:

```text
arc_voice_speak
arc_voice_transcribe
arc_voice_list_profiles
```

This keeps Voicebox replaceable later.

---

## 5. Runtime placement

Voicebox should be managed beside existing Arc runtimes, but it is **not** a coding agent.

```text
Arc managed runtimes
├─ Codex
├─ Claude Code
├─ OMP
└─ Voicebox
```

The normal user agent picker must remain:

```text
OMP
Codex
Claude Code
```

Voicebox belongs under:

```text
Settings → Voice
Settings → Diagnostics
Settings → Updates
```

---

## 6. Filesystem layout

Recommended macOS layout:

```text
~/Library/Application Support/Arc Agent/
├─ arc-runtimes/
│  └─ voicebox/
│     ├─ active/
│     ├─ previous/
│     ├─ staging/
│     └─ runtime-manifest.json
│
└─ voice/
   ├─ models/
   ├─ profiles/
   ├─ captures/
   ├─ temp/
   └─ state/
```

Use Voicebox's model directory override where practical:

```text
VOICEBOX_MODELS_DIR=<Arc-managed model directory>
```

Reuse Arc's existing managed-runtime infrastructure instead of creating a second updater/runtime system.

---

# 7. Phase V0 — Integration spike

## Objective

Prove Arc can safely operate Voicebox before touching production UI.

## Tasks

1. Use Terrain to inspect Arc's current runtime/process-management patterns.
2. Use CodeGraph to identify process lifecycle and shutdown dependencies.
3. Determine how Voicebox is started on Apple Silicon.
4. Launch Voicebox from an Arc-controlled process.
5. Bind it only to loopback.
6. Wait for a reliable readiness signal.
7. Call:
   - profile listing,
   - `/transcribe`,
   - `/speak`.
8. Stop Voicebox cleanly.
9. Verify no orphan process remains.
10. Redirect model storage under Arc's data directory.
11. Measure:
   - cold start time,
   - warm start time,
   - idle RAM,
   - STT latency,
   - TTS first-audio latency,
   - model disk usage.
12. Ensure the runtime abstraction does not hard-code macOS-only MLX assumptions, so the same Arc Voice Manager can later resolve CUDA/XPU/DirectML/ROCm/CPU backends on Windows and Linux.

## V0 exclusions

Do not add:

- Composer microphone UI.
- Voice Settings.
- Automation integration.
- Voice cloning UI.
- Full voice mode.

## Acceptance gate

```text
Arc launches Voicebox without a global install
Arc detects readiness
STT works
TTS works
Voice profiles can be listed
Arc shuts Voicebox down cleanly
No orphan process remains
Arc-controlled model directory works
```

**STOP after V0 and review results before V1.**

---

# 8. Phase V1 — Managed Voicebox runtime

## Objective

Turn the spike into a proper Arc-managed runtime.

Reuse Phase 11 concepts where possible:

```text
download
stage
verify
activate
health check
known-good
repair
rollback
```

Required operations:

```text
voiceRuntime.status
voiceRuntime.prepare
voiceRuntime.start
voiceRuntime.stop
voiceRuntime.repair
voiceRuntime.update
voiceRuntime.rollback
```

Manifest should track:

```text
runtime id
active version
known-good version
OS
architecture
install path
source
checksum
installed timestamp
health state
```

## Acceptance gate

```text
clean-machine preparation works
no PATH dependency
no global Voicebox dependency
health probe is reliable
restart works
failed runtime update can rollback
runtime path is Arc-controlled
```

---

# 9. Phase V2 — STT in the thread composer

## Objective

Add microphone dictation to Arc's existing composer.

Recommended first UX:

```text
Idle
 ↓
Recording
 ↓
Transcribing
 ↓
Transcript inserted into draft
 ↓
User reviews/edits
 ↓
User sends normally
```

Do **not** automatically submit after transcription.

Suggested interaction:

```text
click mic → record
click again → stop/transcribe
Esc → cancel
```

The transcript must:

- Preserve existing draft text.
- Remain editable.
- Never silently erase the draft.
- Handle failure without losing user text.

### Streaming STT

Do not depend on streaming transcription in the first release. Start with:

```text
record → stop → transcribe → insert text
```

Add partial/streaming transcription later only when the upstream Voicebox path is stable enough.

## Acceptance gate

```text
recording works
cancel works
transcription works
draft is preserved
no automatic send
permission denial is handled
runtime failure is handled
temporary audio is cleaned up
```

---

# 10. Phase V3 — TTS for agent replies

## Objective

Let users listen to completed assistant responses.

Suggested message action:

```text
🔊 Speak
```

While playing:

```text
■ Stop
```

Optional later:

```text
Pause
Resume
Replay
```

Do not put TTS inside the token-rendering hot path.

Initial behavior:

```text
message completes
→ user presses Speak
→ Arc sends clean visible text to Voicebox
→ audio plays
```

Do not blindly speak:

- huge stack traces,
- raw JSON,
- internal tool metadata,
- giant diff blocks.

## Acceptance gate

```text
Speak works
Stop works
thread switching is safe
TTS failure does not break thread UI
streaming performance is unchanged
```

---

# 11. Phase V4 — Settings → Voice

Create a dedicated settings page.

Suggested structure:

```text
Voice

Runtime
Status: Ready
Version: ...
[Repair]

Speech to Text
Engine: Whisper
Model: Turbo
Language: Auto
Microphone: ...
[Test microphone]

Text to Speech
Engine: Qwen3-TTS 0.6B
Voice: ...
Speed: 1.0x
[Preview voice]

Voice Gallery
Selected Voice: ...
[Browse Voices]

My Voices
[+ Create Custom Voice]
[Manage My Voices]

Behavior
[x] Show microphone in composer
[ ] Automatically speak agent replies
[ ] Push-to-talk
[ ] Keep voice runtime warm
```

Only expose options that actually work.

## Recommended initial defaults

### STT

```text
Whisper Turbo
```

with lighter alternatives:

```text
Base
Small
Medium
```

### TTS

Recommended default:

```text
Qwen3-TTS 0.6B
```

Optional:

```text
Qwen3-TTS 1.7B
Qwen CustomVoice
Kokoro
Chatterbox
Chatterbox Multilingual
```

Use Kokoro as the lightweight fallback, not the primary default.

Do not download everything by default.

## Speech engine decision — exact STT/TTS choice

For the first Arc Voice implementation, the recommended stack is intentionally simple:

### STT — Speech to Text

```text
Voicebox
  ↓
Whisper
  ↓
MLX-Whisper on Apple Silicon
```

Recommended initial model:

```text
Whisper Turbo
```

Fallback choices:

```text
Whisper Base
Whisper Small
Whisper Medium
```

So the first Arc STT path is:

```text
Microphone
  ↓
Arc audio capture
  ↓
Voicebox
  ↓
Whisper / MLX
  ↓
transcribed text
  ↓
Arc composer
```

Arc should not implement its own speech-recognition model.

### TTS — Text to Speech

Voicebox's main modern TTS path is **Qwen3-TTS** (not "Owen"). Voicebox currently supports Qwen3-TTS in 0.6B and 1.7B variants with MLX and PyTorch backends.

Arc should therefore use:

```text
Qwen3-TTS 0.6B
```

as the recommended default for the first cross-platform release.

Why:

- It is one of Voicebox's primary TTS engines.
- It supports richer voice output than a basic lightweight engine.
- Voicebox already supports it through both MLX and PyTorch.
- It is suitable for macOS, Windows, and Linux through platform-specific inference backends.
- The 0.6B variant is a better default balance than the heavier 1.7B model.

Optional TTS choices can remain available:

```text
Qwen3-TTS 1.7B
Qwen CustomVoice
Kokoro
Chatterbox
Chatterbox Multilingual
```

Kokoro remains useful as a lightweight fallback when the user prefers lower RAM/VRAM usage or faster CPU-oriented inference.

The first Arc TTS path becomes:

```text
Agent response
  ↓
Arc Voice Service
  ↓
Voicebox
  ↓
Qwen3-TTS 0.6B
  ↓
platform inference backend
  ↓
local audio playback
```

### Initial product defaults

```text
STT engine: Whisper via Voicebox
STT model: Whisper Turbo

TTS engine: Qwen3-TTS 0.6B via Voicebox
TTS voice: user-selected Voicebox profile/preset
```

Platform backend is selected automatically:

```text
macOS Apple Silicon → MLX / Metal
Windows NVIDIA      → PyTorch / CUDA
Windows Intel Arc   → PyTorch / XPU
Windows other GPU   → DirectML where supported
Linux NVIDIA        → PyTorch / CUDA
Linux AMD           → PyTorch / ROCm
Fallback            → PyTorch / CPU
```

The architecture must keep STT/TTS engines selectable rather than permanently locking Arc to one model.

---

---


# 14. Voice Selection UX — Friendly Voice Gallery

Arc should expose Voicebox voice selection in a simple product-level experience rather than exposing engine/model internals first.

Voicebox currently supports two useful user-facing voice sources:

```text
Preset voices
├─ Qwen CustomVoice → curated preset voices + delivery instructions
└─ Kokoro           → large lightweight preset catalog

My Voices
└─ Cloned profiles  → created from user-provided reference audio
```

Voicebox also supports cloned profiles through engines such as Qwen3-TTS and other cloning-capable engines.

## Product rule

The primary Voice UI should ask:

```text
"What voice do you want Arc to use?"
```

not:

```text
"Which backend/model/profile ID do you want?"
```

Technical engine details can live under Advanced.

## Voice Gallery

Add:

```text
Settings → Voice → Voice Gallery
```

Suggested layout:

```text
Voice Gallery

Recommended
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ Atlas        │ │ Nova         │ │ Ember        │
│ Deep / Calm  │ │ Clear / Warm │ │ Crisp / Fast │
│ ▶ Preview    │ │ ▶ Preview    │ │ ▶ Preview    │
└──────────────┘ └──────────────┘ └──────────────┘

More voices
[ Professional ] [ Warm ] [ Deep ] [ Energetic ] [ Calm ]

My Voices
[ + Create from my voice sample ]
```

The displayed Arc-friendly names may wrap underlying Voicebox preset profile IDs. Do not rename upstream model IDs internally.

Each voice card should show only useful information:

```text
friendly name
short character description
language support
preview button
selected state
optional "lightweight" or "high quality" badge
```

Do not show raw model names on every card unless the user opens details.

## Preview interaction

Every selectable voice should have:

```text
▶ Preview
```

Use the same short neutral preview phrase so comparisons are meaningful.

Preview should:

- start quickly,
- stop the previous preview when another begins,
- clearly show which card is speaking,
- expose Stop,
- avoid overlapping voices.

## Voice style / delivery

Where the selected Voicebox engine supports delivery instructions, expose a friendly control:

```text
Delivery

Tone
[ Natural ] [ Calm ] [ Confident ] [ Warm ] [ Energetic ]

Pace
Slow ─────●───── Fast

Optional instruction
"Speak in a deep, cinematic, calm and deliberate narrator style."
```

This should map to Voicebox/Qwen CustomVoice instruction controls where supported.

If an engine does not support instruction-based delivery, hide or disable the control honestly.

## Real-person / celebrity-style requests

A user may ask for something like:

```text
"Make it sound like Morgan Freeman."
```

Arc should not present unlicensed celebrity identities as built-in voices.

Instead, guide the user toward a descriptive voice style such as:

```text
Deep Cinematic Narrator
calm
resonant
measured
warm
authoritative
```

This gives the desired character without pretending the preset is that real person.

If the user creates a cloned voice from reference audio, Arc should clearly label it as a custom cloned profile and require the user to confirm they have permission/rights to use that voice sample.

Do not market a cloned profile as an official celebrity voice.

## My Voices — custom voice creation (V4 core)

Custom voices are a first-class V4 capability, not an optional future add-on.

Arc should expose a guided workflow that creates a Voicebox cloned profile without exposing raw Voicebox API concepts to normal users:

```text
+ Create Custom Voice
      ↓
Record sample OR choose audio file
      ↓
10–30 seconds of clear speech
      ↓
Choose / confirm language
      ↓
Arc transcribes the sample locally when useful
      ↓
User confirms/corrects the exact reference text
      ↓
Arc chooses a compatible cloning engine
      ↓
Create Voicebox profile
      ↓
Add reference sample
      ↓
Preview
      ↓
Name + Save
```

### Why reference text is part of the flow

Voicebox cloned-profile samples store both the reference audio and the text spoken in that audio. Arc should use the existing local STT path to prefill the transcript when practical, but the user must be able to correct it before the sample is committed.

Do not silently guess incorrect reference text.

### Engine selection

Normal users should not need to choose Qwen/Chatterbox/etc. Arc should select a cloning-capable engine using:

```text
requested language
↓
installed/available Voicebox engines
↓
platform capability
↓
quality/performance preference
```

Only show engines that Voicebox actually reports as compatible. Advanced settings may allow an explicit engine override.

Do not hardcode Qwen3-TTS as the cloning engine for every language. For example, if a language such as Arabic is not supported by the selected Qwen cloning model, Arc should choose another installed Voicebox cloning engine that declares support instead of failing later.

### Sample quality UX

Show simple guidance before recording/upload:

```text
10–30 seconds
clear speech
minimal background noise
no music / overlapping speakers
natural speaking pace
WAV preferred for uploaded samples
```

One clean sample is enough to create a profile. Allow the user to add more samples later; multiple good samples may improve cloning quality.

### Consent and privacy

Before creating a cloned profile, require an explicit confirmation:

```text
I own this voice or have permission to use this voice sample.
```

Treat reference audio and cloned voice profiles as sensitive local user data.

Rules:

- Do not upload reference audio to Arc cloud services.
- Do not sync cloned profiles by default.
- Do not create hidden copies of the source audio in Arc storage.
- Voicebox remains the owner of profile samples/embeddings inside its Arc-controlled data directory.
- Arc stores only the profile reference plus Arc-owned display metadata/mapping where needed.
- Deleting a custom voice from Arc should delete the Voicebox profile/sample data after explicit confirmation, then remove Arc mappings.
- If a deleted profile was the global/thread/agent voice, fall back safely to the next valid voice in the resolution chain.

The UI should state:

```text
Use your own voice or a voice you have permission to use.
Your voice sample stays local on this device.
```

### My Voices management

Each custom voice should support:

```text
Preview
Rename
Add sample
Remove sample
Set as default
Assign to agent (V5)
Delete
```

Clearly badge cloned voices as:

```text
Custom Voice
```

Do not present a custom clone as an official or licensed celebrity/public-figure voice.

### Arc ↔ Voicebox ownership

Use Voicebox's profile lifecycle instead of inventing a parallel Arc voice database:

```text
Arc UI
  ↓
Arc Voice Service
  ↓
Voicebox profile API
  ├─ create profile
  ├─ add/remove samples
  ├─ update profile
  ├─ preview through TTS
  └─ delete profile
```

Arc may store lightweight references and assignment metadata, but it should not duplicate voice embeddings or reference audio unnecessarily.

### V4 custom voice acceptance gate

```text
record sample works
upload supported sample works
reference transcript can be reviewed/corrected
compatible cloning engine is selected safely
profile creation works
sample is attached to the profile
preview works
profile persists after restart
rename/manage works
profile deletion removes its Voicebox data after confirmation
Arc does not duplicate source audio/embedding data unnecessarily
consent is required
no automatic cloud upload occurs
deleted assigned voice falls back safely
```

## Basic vs Advanced settings

Default user view:

```text
Voice
Voice Gallery
Selected Voice
Delivery
Auto-speak
Voice button behavior
```

Advanced:

```text
TTS engine
model size
inference backend
voice profile ID
model storage
runtime details
```

The normal user should not need to understand Qwen, MLX, CUDA, or PyTorch just to select a voice.

---

# 15. Chat Thread Voice Button — ChatGPT-like Entry Point

Voice should be directly available from every normal Arc chat/thread, not hidden in Settings.

Add a dedicated **Voice Mode button** to the composer action area.

Suggested composer:

```text
┌──────────────────────────────────────────────────────────┐
│ Ask Arc anything...                                      │
│                                                          │
│ model  account  access                 🎙   ◉Voice   ➤  │
└──────────────────────────────────────────────────────────┘
```

The exact icon can be an Arc-original waveform/orb icon.

Do not copy ChatGPT artwork, but match the interaction simplicity:

```text
one obvious button
→ enter Voice Mode
```

## Distinguish Dictation from Voice Mode

These are two different actions:

```text
🎙 Dictation
   Speak once → transcript appears in composer → edit/send manually

◉ Voice Mode
   Start a continuous conversational voice session
```

Do not overload one control with ambiguous behavior.

## Voice button states

```text
Ready
Hover
Starting
Listening
Thinking
Speaking
Muted
Error
```

The button should animate subtly when the voice runtime is preparing.

If models/runtime are missing:

```text
click Voice
→ lightweight setup sheet
→ "Preparing Voice for first use..."
→ download required runtime/model
→ enter Voice Mode
```

Do not send the user to a technical setup page unless something fails.

## First-use sheet

Keep it friendly:

```text
Set up Arc Voice

Voice
Atlas — Deep & Calm      [Change]

Microphone
MacBook Pro Microphone   [Change]

Speech
Whisper Turbo

[ Start Voice ]
```

Technical model/backend details may be hidden under:

```text
Advanced
```

## In-thread continuity

Voice Mode must operate on the **same Arc thread**.

Entering Voice Mode:

```text
current thread
→ Voice Mode presentation
→ same thread ID
```

Exiting:

```text
Voice Mode
→ normal thread
→ transcript and formatted agent responses remain
```

Never create a hidden parallel voice conversation.

## Visual response while speaking

When the user asks for information that benefits from visual structure, the agent should show it on screen while speaking.

Examples:

```text
"Show me the current runtime status."
"Give me the SQL."
"Show me the code."
"Compare these two options."
"Display the error stack."
```

Arc should produce:

```text
spoken summary
+
full formatted visual response
```

The visual response must support normal thread rendering:

```text
Markdown
headings
lists
tables
syntax-highlighted code
diffs
links
tool cards where appropriate
```

### Code behavior

Default:

```text
Voice:
"I've put the implementation on screen. The key part is the health check
before activating the runtime."

Screen:
<full syntax-highlighted code>
```

Do not read large code blocks character-by-character or line-by-line unless the user explicitly asks.

## Voice response preference

Add:

```text
Spoken response detail

○ Brief
● Balanced
○ Full
```

Interpretation:

```text
Brief
→ very short spoken summary, full content on screen

Balanced
→ natural explanation, full technical details on screen

Full
→ speak most readable prose, while still avoiding painful code/log narration
```

---

# 14. Phase V5 — Per-agent voices

Let each Arc coding agent have a distinct voice.

V5 must reuse the preset and custom cloned profiles created/managed in V4. Do not create a second per-agent voice store.

```text
Codex       → Voice A
Claude Code → Voice B
OMP         → Voice C
```

Arc should own the mapping.

Suggested resolution order:

```text
explicit voice override
↓
thread voice override
↓
agent voice
↓
global default voice
```

This must not alter account routing, model selection, or runtime routing.

Both preset voices and `My Voices` custom profiles are valid assignment targets.

If an assigned custom profile is deleted or becomes unavailable:

```text
agent voice missing
↓
thread voice override if valid
↓
global default voice
↓
safe built-in fallback
```

Agent voice mappings store profile references only; Voicebox remains the owner of cloned samples/embeddings.

---

# 15. Phase V6 — Automations integration

Use the existing Arc Automations system.

Do **not** create another scheduler.

Expose an Arc-owned operation:

```text
voice.speak(...)
```

Example:

```text
Every weekday at 8:30 AM

Check my Exchange mailbox.
Summarize important messages.
Create an Arc thread with the summary.

If at least one message is urgent:
- speak a short two-sentence alert.

Do not read full email bodies aloud.
Do not send or reply to email.
```

Voice output should be explicit.

Each automation should conceptually support:

```text
Allow voice output: yes/no
```

No automation should start speaking merely because TTS is installed.

Voice failure should not fail the rest of an automation unless voice output is the automation's core purpose.

---

# 16. Phase V7 — Full Voice Mode + Premium Cinematic UI

Only begin after STT and TTS are independently stable.

The goal is a **premium cinematic AI-assistant experience** inspired by the feeling of futuristic assistants such as JARVIS, while remaining visually original to Arc rather than copying Iron Man/JARVIS artwork.

## Core interaction flow

```text
You speak
↓
STT
↓
selected Arc agent
↓
streamed response
↓
visual answer + TTS
↓
you interrupt
↓
playback stops
↓
Arc listens again
```

State machine:

```text
Idle
Listening
Transcribing
Thinking
Speaking
Interrupted
Error
```

## Voice Mode visual composition

Voice Mode should feel like a deliberate Arc experience, not a normal chat screen with a microphone added.

Suggested layout:

```text
┌─────────────────────────────────────────────────────────────┐
│ Arc Voice                                        Exit       │
│                                                             │
│                                                             │
│                    ◌  ◌  ◌                                  │
│                ◌             ◌                              │
│              ◌      ARC        ◌                            │
│                ◌             ◌                              │
│                    ◌  ◌  ◌                                  │
│                                                             │
│                 Listening...                                │
│                                                             │
│     ┌─────────────────────────────────────────────────┐     │
│     │ Visual answer / code / data appears here        │     │
│     └─────────────────────────────────────────────────┘     │
│                                                             │
│ Mic          Agent          Voice          Stop / Exit      │
└─────────────────────────────────────────────────────────────┘
```

The central object should be an **Arc Voice Ring**.

## Arc Voice Ring

Create an original circular/holographic-style voice visualization.

It should combine:

```text
central core
concentric rings
audio-reactive waveform segments
soft radial propagation waves
small particle/signal accents
state text
```

The visual must be generated from real state/audio where possible.

### Listening

When the microphone is active:

```text
microphone amplitude
      ↓
ring deformation / waveform amplitude
      ↓
outward signal propagation
```

The ring should visibly react to the user's real voice.

Desired behavior:

- Inner ring responds quickly to microphone amplitude.
- Outer rings propagate more slowly.
- Short outward ripples indicate speech energy.
- Quiet input produces minimal motion.
- Strong speech creates larger propagation.
- No fake constant full-volume animation.

### Transcribing

Transition from live waveform to a more controlled rotating/pulsing state.

```text
Listening
   ↓
short contraction
   ↓
Transcribing pulse
```

Do not imply the agent is speaking during transcription.

### Thinking

Use slower, more deliberate movement:

```text
slow orbital motion
subtle segmented rotation
soft core pulse
occasional signal sweep
```

Avoid a generic loading spinner.

The ring should communicate:

```text
"Arc is processing"
```

rather than:

```text
"the app is frozen"
```

### Speaking

The ring should react to the actual outgoing TTS signal.

```text
TTS audio amplitude
      ↓
ring/waveform modulation
      ↓
outward propagation rings
```

This creates the requested "voice propagation" effect.

The outgoing signal can visually travel from:

```text
center core
→ inner waveform ring
→ outer propagation ring
→ fade
```

This should feel synchronized to the voice rather than being a looping decorative animation.

### Interrupted

On barge-in:

```text
Speaking
↓
fast visual contraction
↓
audio stops
↓
Listening state activates
```

This should feel instantaneous.

## Visual style

Target:

```text
premium
cinematic
technical
high-end
clean
responsive
Arc-branded
```

Use Arc's design tokens and accent system.

A restrained combination of:

```text
glass depth
soft bloom
thin luminous lines
subtle gradients
controlled particle motion
```

is allowed specifically in Voice Mode.

Avoid:

```text
copying JARVIS graphics exactly
Iron Man logos
heavy sci-fi clutter
constant neon
random HUD numbers
fake diagnostic text
huge GPU-heavy particle scenes
```

The result should feel like **Arc's own futuristic voice interface**.

## Animation performance

Prefer:

```text
CSS transforms
Canvas
WebGL only if genuinely justified
requestAnimationFrame
GPU-friendly transforms
```

Do not rerender the full React tree at audio-frame frequency.

Separate:

```text
voice state
audio analyser
visual animation
thread content
```

The visualization must not interfere with agent streaming.

Target smoothness:

```text
60 FPS on normal Apple Silicon use
```

with graceful degradation.

Respect:

```text
prefers-reduced-motion
```

Reduced-motion mode should retain state indication without propagation/particle animation.

## Voice + visual answer mode

Voice Mode must **not be audio-only**.

The agent should be able to speak while also presenting a properly formatted visual answer.

Examples:

### Normal information

If the user asks:

```text
"Explain the current runtime status."
```

Arc can speak a concise answer while showing:

```text
Runtime Status

Codex        Ready
Claude       Ready
OMP          Ready
Voicebox     Running
```

### Code request

If the user asks:

```text
"Show me the code for the health check."
```

Arc should:

1. Speak a short explanation.
2. Display the code as a real syntax-highlighted code block.
3. Keep the voice ring visible and active.
4. Let the user copy the code.
5. Avoid reading every line of code aloud unless explicitly requested.

Example:

```ts
const status = await voice.getStatus();

if (!status.ready) {
  await voice.prepare();
}
```

### Structured technical answers

Voice Mode should support the same rendering capabilities as normal Arc threads:

```text
Markdown
headings
lists
tables
code blocks
syntax highlighting
diffs
links
tool-result cards where appropriate
```

Do not flatten formatted answers into plain text merely because Voice Mode is active.

## Spoken-answer policy

TTS and visual text do not have to be identical.

Recommended behavior:

```text
visual response = complete technical answer
spoken response = concise natural-language summary
```

For example:

```text
Visual:
complete code + explanation

Voice:
"I've shown the implementation on screen. The important part is that
the health check waits for Voicebox readiness before exposing it to the UI."
```

This avoids painfully reading large code blocks, JSON, tables, and logs aloud.

Add a user option:

```text
Voice response detail
○ Brief
● Balanced
○ Read full answer
```

For code, default should be:

```text
summarize code aloud
show full code visually
```

unless the user explicitly asks Arc to read the code.

## Visual answer panel

While Voice Mode is active, formatted content should appear in a dedicated content surface without hiding the voice visualization.

Responsive concepts:

### Wide window

```text
Voice Ring | Answer Panel
```

or:

```text
Voice Ring above
Formatted answer below
```

depending on available space.

### Narrow window

```text
Voice Ring
↓
Answer Panel
```

The answer panel should support scrolling independently when appropriate.

Do not let long code cause the ring/state controls to disappear.

## Transition back to thread

Voice Mode remains part of the same thread.

When Voice Mode closes:

```text
all user transcripts
all agent responses
all formatted code/info
```

must remain in the normal thread timeline.

Voice Mode must not create a separate conversation history.

## Barge-in

Target behavior:

```text
Arc speaking
↓
user interrupts
↓
TTS stops immediately
↓
voice animation contracts
↓
recording begins
```

Do not allow overlapping stale playback or duplicated conversation turns.

## Voice Mode acceptance gate

```text
Listening ring reacts to real microphone amplitude
Speaking ring reacts to real TTS output
propagation animation is smooth
Thinking has a distinct visual state
barge-in feels immediate
formatted Markdown remains available
syntax-highlighted code renders correctly
code is not automatically read line-by-line
visual response remains in normal thread history
Voice Mode does not create a separate thread
reduced-motion fallback works
normal thread streaming remains stable
```

---

# 17. Phase V8 — Advanced features

Later only:

```text
voice cloning
voice profile management
capture history
Qwen delivery instructions
Chatterbox emotion tags
voice persona integration
voice import/export
advanced model management
```

Do not automatically import Voicebox's full:

```text
Stories editor
multi-track timeline
audio effects studio
general voice studio
```

Arc remains an AI coding environment.

---

# 18. Runtime lifecycle

Voicebox should not necessarily run whenever Arc runs.

Recommended:

```text
Arc starts
↓
Voice disabled?
├─ yes → do nothing
└─ no
   ↓
voice requested?
├─ no → stay stopped
└─ yes → prepare/start
```

Start triggers can include:

- Microphone pressed.
- Speak pressed.
- Auto-speak enabled.
- Voice Settings opened.
- Automation requests voice.
- Agent invokes Arc voice tool.

Idle unload/shutdown can be evaluated later after measuring startup cost.

---

# 19. Runtime and model states

Keep runtime state separate from model state.

Runtime:

```text
Not installed
Installing
Ready
Starting
Running
Stopping
Updating
Repairing
Failed
Rollback available
Disabled
```

Model:

```text
Not downloaded
Downloading
Ready
Loaded
Unloaded
Failed
```

A ready runtime does not mean the selected model exists.

---

# 20. Security

Voicebox should be treated as a trusted local sidecar, not a public service.

Requirements:

```text
loopback only
Arc-controlled lifecycle
no LAN exposure
no arbitrary renderer access
no arbitrary endpoint supplied by a model
```

Prefer:

```text
127.0.0.1:<Arc-managed port>
```

Do not assume the default port is always free.

Before production release, review:

- Host-header handling.
- DNS-rebinding exposure.
- Origin handling.
- Loopback enforcement.
- Local API authentication.
- Model download URLs.
- Path traversal.
- Temp audio permissions.
- Voice profile imports.
- Arbitrary model paths.
- MCP exposure.

The renderer should not receive raw runtime credentials or process environment.

---

# 21. Privacy

Default behavior:

```text
speech processing is local
```

Microphone audio should not be stored permanently by default.

Temporary recordings should:

- Live in an Arc-controlled temp directory.
- Use restrictive permissions.
- Be deleted after transcription.
- Be retained only if the user explicitly enables capture history.

Future cloud providers must be clearly marked as cloud-backed.

---

# 22. Licensing

Voicebox itself is MIT licensed.

But:

```text
Voicebox source license
≠
model license
≠
permission to redistribute model weights
```

For every model Arc supports, track:

```text
model
source
license
commercial-use status
redistribution status
version/revision
download URL
checksum
platform support
```

Prefer downloading models on demand rather than bundling many gigabytes into Arc.

---

# 23. Model management

Settings should eventually show:

```text
Model
Purpose
Size
Language support
Installed status
Download progress
Disk usage
Unload
Remove
```

Initial first-run flow:

```text
Enable Voice
↓
prepare Voicebox runtime
↓
choose recommended STT/TTS
↓
download model(s)
↓
verify
↓
Ready
```

---

# 24. Diagnostics

Add Voice to:

```text
Settings → Diagnostics
```

Suggested display:

```text
Voice Runtime   Ready
Version         ...
STT engine      Whisper
STT model       Turbo / Ready
TTS engine      Kokoro
TTS model       Ready
Audio input     Available
Last health     ...
```

Useful actions:

```text
Repair runtime
Test microphone
Test speech
Open safe logs
```

Do not expose secrets or raw sensitive environment values.

---

# 25. Updates

Eventually include Voicebox in Arc's unified update surface:

```text
Arc Agent
Codex
Claude
OMP
Voicebox
```

Use:

```text
discover
download
stage
verify
health-check
activate
rollback
```

Do not update Voicebox during active recording or playback.

---

# 26. Cross-platform strategy

Cross-platform support is a **first-class requirement**, not a later port.

Arc Voice must be designed from the beginning for:

```text
macOS
Windows
Linux
```

The same Arc Voice API and UI should work across platforms while the managed runtime chooses the correct inference backend.

| Platform | Preferred backend |
|---|---|
| macOS Apple Silicon | MLX / Metal |
| macOS Intel | PyTorch / CPU |
| Windows + NVIDIA | PyTorch / CUDA |
| Windows + Intel Arc | PyTorch / XPU |
| Windows + other supported GPU | DirectML |
| Linux + NVIDIA | PyTorch / CUDA |
| Linux + AMD | PyTorch / ROCm |
| Generic fallback | PyTorch / CPU |

Voicebox already has platform-aware inference support across these backend families. Arc should preserve that design rather than hard-coding MLX.

## Packaging rule

Do not assume one Voicebox runtime artifact can be copied to every OS.

Use an OS/architecture-aware manifest:

```text
voicebox
├─ darwin-arm64
├─ darwin-x64
├─ win32-x64
├─ linux-x64
└─ future architectures
```

Each platform entry should define:

```text
runtime source
version
checksum
launch command
health probe
supported inference backends
model compatibility
```

## Cross-platform acceptance gate

Before calling Arc Voice production-ready:

```text
macOS clean-machine STT/TTS passes
Windows clean-machine STT/TTS passes
Linux clean-machine STT/TTS passes

same Arc Voice API contract
same Settings → Voice concepts
same thread microphone/speak UX

platform-specific runtime differences remain behind Arc Voice Manager
```

Do not let platform-specific Python, CUDA, ROCm, MLX, XPU, or DirectML details leak into normal thread code.

---

# 27. Performance

Measure before optimizing.

Track:

```text
cold start
warm start
STT model load
STT latency
TTS model load
TTS first-audio latency
peak RAM
idle RAM
disk usage
GPU/Metal usage
```

Important product requirement:

```text
normal Arc use should not pay voice GPU/RAM cost when Voice is unused
```

Use model unload support when practical.

---

# 28. Failure handling

Voice must never break the main thread experience.

Handle:

```text
microphone unavailable
permission denied
runtime start failure
model unavailable
model download failure
transcription failure
TTS failure
audio output failure
```

Expected behavior:

```text
show clear error
keep thread usable
preserve composer draft
allow retry
do not crash Codex/Claude/OMP
```

---

# 29. Accessibility

Required:

- Keyboard-accessible microphone.
- Keyboard-accessible Speak/Stop.
- Screen-reader labels.
- Visible recording state.
- Visible speaking state.
- Reduced-motion support.
- No unexpected speech unless configured.
- Clear microphone permission guidance.

---

# 30. Clean-machine validation

Before release, validate using an isolated environment similar to Arc Phase 16.

Use isolated:

```text
HOME
BB_DATA_DIR
Arc userData
PATH
```

Verify:

```text
no global Voicebox install
no global Python dependency
no pip setup
no shell-profile dependency
runtime installs itself
models go to Arc-owned storage
permissions are correct
STT works
TTS works
```

Do not rely on a developer-machine Voicebox installation.

---

# 31. Packaging decision

Preferred direction:

```text
Arc.app
↓
small voice runtime manager/bootstrap
↓
Voicebox downloaded when Voice is first enabled
↓
speech models downloaded on demand
```

Do not bundle all speech models inside Arc.app.

During V0/V1 measure:

- Voicebox runtime size.
- Runtime dependency footprint.
- Official release artifacts.
- Signing status.
- Notarization implications.
- Gatekeeper behavior.

Every downloaded executable should have a known source/version/checksum and pass Arc health validation.

---

# 32. UX direction

Keep the feature compact.

Composer:

```text
┌─────────────────────────────────────────┐
│ Ask Arc anything...                     │
│                                         │
│ model account access        🎙      ➤  │
└─────────────────────────────────────────┘
```

Recording:

```text
● Recording... 00:07              Cancel
```

Transcribing:

```text
◌ Transcribing locally...
```

Assistant message:

```text
Copy   Retry   🔊 Speak
```

Speaking pill:

```text
🔊 Claude · Morgan       00:08   ■
```

Avoid giant visualizers, neon/glow effects, or a separate large voice dashboard.

---

# 33. Terrain implementation policy

For every non-trivial phase:

- Check Terrain freshness first.
- Use Terrain knowledge before direct repo exploration.
- Use CodeGraph for dependency/caller/impact analysis.
- Use `grep-pack` and `read-pack-file` for targeted inspection.
- Avoid recursive scans unless Terrain is insufficient.
- Do not load the full Repomix pack.
- Do not repeat identical searches.
- Explain exact file-level changes before editing.
- **Wait for approval before implementation.**
- Prefer focused tests first.

After implementation:

```text
refresh/re-index Terrain
verify freshness
confirm CodeGraph reflects changes
```

---

# 34. Per-phase execution workflow

```text
1. Check Terrain freshness
2. Inspect with Terrain
3. Use CodeGraph
4. Identify exact files
5. Propose file-level plan
6. HARD STOP
7. Wait for approval
8. Implement
9. Run focused tests
10. Typecheck/build
11. Manual verification
12. Refresh Terrain
13. Commit
14. Push
15. Build Arc Agent.app
16. Preserve ~/.bb
17. Install over /Applications/Arc Agent.app
18. Final report
```

Do not combine all voice phases into one huge implementation.

---

# 35. Testing strategy

## Unit

```text
voice state machine
configuration
profile resolution
agent voice resolution
runtime status mapping
model status mapping
error mapping
```

## Integration

Mock Voicebox and test:

```text
health
transcribe
speak
stop
list profiles
timeout
malformed response
runtime unavailable
```

## Runtime

Real local checks:

```text
start
health
transcribe test WAV
speak harmless sentence
stop
restart
```

## UI

```text
microphone state
draft preservation
Speak
Stop
Settings → Voice
Voice Gallery
voice preview start/stop
selected voice persistence
custom voice record/upload
custom voice transcript confirmation
custom voice create/preview/rename/delete
custom voice deletion fallback
Voice Mode button
Dictation vs Voice Mode separation
formatted code while speaking
model unavailable
permission denied
```

## Regression

```text
Codex unaffected
Claude unaffected
OMP unaffected
account routing unaffected
thread persistence unaffected
usage/cache unaffected
Automations unaffected when Voice disabled
```

---

# 36. Release milestones

## Milestone A — Useful Voice

Contains:

```text
V0
V1
V2
V3
V4
```

Ships:

```text
🎙 Dictation
◉ Voice button in every thread
🔊 Speak responses
friendly Voice Gallery with previews
My Voices custom voice creation + management
local models
Settings → Voice
managed runtime
```

## Milestone B — Arc personality

Contains:

```text
V5
V6
```

Ships:

```text
per-agent voice assignment using preset or My Voices profiles
safe fallback when an assigned voice disappears
voice-enabled Automations
```

## Milestone C — Conversational Arc

Contains:

```text
V7
```

Ships:

```text
full voice conversation
premium Arc Voice Ring
real audio-reactive propagation animation
Listening / Thinking / Speaking states
barge-in
formatted visual answers during voice conversations
syntax-highlighted code while Arc speaks concise explanations
voice state UI
```

## Milestone D — Advanced Voice

Selected V8 capabilities based on actual value.

---

# 37. Go / No-Go criteria

Do not call Voice production-ready until:

```text
clean-machine install succeeds
no global dependency exists
runtime health is reliable
STT is reliable
TTS is reliable
permissions UX is clear
thread survives Voice failure
runtime can be repaired
model downloads are verified
model licensing reviewed
no unexpected LAN exposure
no orphan processes
Arc remains responsive during model load
voice selection is understandable without knowing model names
preset voice preview works
custom voice creation works from local record/upload
custom voice consent is explicit
custom voice data remains local by default
custom voice deletion removes local profile data and mappings safely
Dictation and Voice Mode controls are clearly distinct
Voice Mode stays attached to the current thread
formatted code/Markdown remains visible while speech is active
```

---

# 38. Final architecture decision

Preferred:

```text
Voicebox = managed internal speech runtime
Arc      = product/UI/orchestration owner
```

Avoid:

```text
Arc embeds the whole Voicebox app
```

and avoid:

```text
each agent independently configures Voicebox MCP
```

Stable Arc-facing contract:

```text
Arc Voice Service
├─ transcribe()
├─ speak()
├─ stop()
├─ listProfiles()
├─ getProfile()
├─ createProfile()
├─ updateProfile()
├─ deleteProfile()
├─ addProfileSample()
├─ removeProfileSample()
├─ previewProfile()
├─ setDefaultProfile()
├─ runtimeStatus()
└─ modelStatus()
```

---

# 39. Recommended next action

Start with **Phase V0 only**.

The executor should:

```text
1. Use Terrain to inspect Arc runtime/process patterns.
2. Use CodeGraph for impact.
3. Inspect current Voicebox launch/API requirements.
4. Propose exact file-level architecture.
5. Explain process launch, isolation, health, shutdown.
6. Explain model-storage redirection.
7. Explain endpoint/port security.
8. Explain runtime/download strategy.
9. HARD STOP.
10. Wait for approval.
```

Do not begin composer or Settings work until V0 proves the runtime integration.

---

# 40. Phase V0 executor prompt

> ## ARC PHASE V0 — VOICEBOX INTEGRATION SPIKE
>
> Work on the current Arc Agent `self-contained` branch.
>
> The goal is to prove Arc can safely manage the local Voicebox backend and call STT/TTS before production UI work.
>
> ### Terrain policy
>
> - Check Terrain freshness.
> - Use Terrain knowledge first.
> - Use CodeGraph for runtime/process/dependency impact.
> - Use `grep-pack` and `read-pack-file` for targeted inspection.
> - Avoid recursive scans unless Terrain is insufficient.
> - Do not load the full Repomix pack.
> - Explain exact file-level changes before editing.
> - HARD STOP and wait for approval.
>
> ### Inspect
>
> Locate:
>
> ```text
> Arc runtime primitives
> runtime manifest/update/health architecture
> process spawning/lifecycle
> shutdown cleanup
> RPC boundaries
> userData/runtime storage helpers
> Diagnostics patterns
> ```
>
> Inspect Voicebox for:
>
> ```text
> startup command/binary
> readiness/health
> /transcribe
> /speak
> profile listing
> model directory override
> Apple Silicon/MLX behavior
> shutdown behavior
> ```
>
> ### Proposed spike
>
> Prove:
>
> ```text
> Arc launches Voicebox without a global install
> Arc waits for readiness
> Arc lists profiles
> Arc transcribes a harmless test WAV
> Arc speaks a harmless sentence
> Arc stops Voicebox
> no orphan process remains
> model storage is Arc-owned
> ```
>
> Do not add:
>
> ```text
> composer UI
> Voice Settings
> Automations integration
> agent/account changes
> ```
>
> ### Before editing report
>
> ```text
> ARC VOICE V0 PLAN
>
> Current Arc runtime components:
> Voicebox launch mechanism:
> Proposed runtime location:
> Proposed model location:
> Endpoint/port strategy:
> Health-check strategy:
> Shutdown strategy:
> Security boundary:
> Files to add/change:
> Tests to add:
> Known risks:
> ```
>
> Then STOP and wait for approval.
>
> ### After approval
>
> Implement the smallest safe spike and measure:
>
> ```text
> cold start
> warm start
> idle RAM
> STT latency
> TTS first-audio latency
> model disk usage
> ```
>
> Run focused tests/typecheck/build only as needed.
>
> Do not commit/deploy until the spike results are reviewed.
>
> Refresh Terrain after implementation.
>
> ### Final report
>
> ```text
> ARC VOICE V0
>
> STATUS:
>
> RUNTIME
> launch:
> ready:
> stop:
> orphan process:
>
> STT
> model:
> result:
> latency:
>
> TTS
> engine:
> result:
> first-audio latency:
>
> STORAGE
> runtime:
> models:
>
> SECURITY
> bind address:
> port:
> renderer exposure:
>
> PERFORMANCE
> cold start:
> warm start:
> idle RAM:
>
> TESTS:
> FILES CHANGED:
> RECOMMENDATION FOR V1:
> ```
