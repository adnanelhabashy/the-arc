# Arc Voice — durable PHASE_STATE

Compact carry-over contract between phases. Each phase's workflow script embeds the latest
block below as a template-string constant (see `V0_PHASE_STATE` in `arc-voice-v1.js` for the
pattern) — do not hand a future phase the full plan doc or a worker's conversation history,
only this block.

## V0 (PASS)

```
phase: V0
result: PASS
interfaces_created:
- packages/arc-domains/src/arc-voice/{types,backend,binding,paths,process,health,client,runtime-manager,index}.ts
- packages/arc-domains/src/index.ts: + export * from "./arc-voice/index.js"
contracts_for_next_phase:
- Voicebox CLI (SOURCE-VERIFIED ONLY, not runtime-verified): --host/--port/--data-dir/--parent-pid/--version,
  no `serve` subcommand, no `--backend` flag
- Backend variant via binary name (voicebox-server[-cuda|-rocm]) or VOICEBOX_BACKEND_VARIANT env
- HTTP (SOURCE-VERIFIED ONLY): GET /health -> {status:"healthy"}, GET /profiles -> bare array,
  POST /transcribe (multipart file+language+model) -> {text,duration}, POST /speak -> async generation
  polled via /history/{id} then fetched via /audio/{id}
- restartPolicy on ArcVoiceRuntimeManager; onRuntimeExit callback; recheckHealth()
- Tests must always inject an explicit guard/spawner/http fake — never rely on production defaults
constraints:
- executable name is "voicebox-server" (PyInstaller entry), not "voicebox"
- --parent-pid only exists in the frozen entry point, not the dev entrypoint (parentWatchdog:false needed there)
- no product wiring yet constructs ArcVoiceRuntimeManager
unresolved:
- HTTP/CLI contract remains source-verified only, never runtime-verified
- #awaitClose leaves one uncancelled timer per stop() call (up to 5s) — deferred, must be fixed in V1
```

## V1 (PASS — closed 2026-09-23, post-fix re-review confirmed)

```
phase: V1
result: PASS
spike:
- real Voicebox v0.5.0 server verified live on 127.0.0.1: contract_status MATCH, executable_verified YES
- --parent-pid is DECORATIVE — no watchdog effect observed across 3 live configurations; Arc's own
  createArcVoiceOrphanGuard (process.on("exit") + SIGKILL) is load-bearing, not belt-and-braces
- PyInstaller bootloader spawns a child+grandchild process tree — stop paths must kill the tree, not
  just the direct pid (see interfaces_created: killResidualTree)
- full HTTP contract confirmed live for all 5 V0-assumed endpoints plus error paths (422/404/500);
  OpenAPI's declared media type for GET /audio/{id} is wrong (says json, is audio/x-wav) — harmless,
  client doesn't trust it
- cold-start model download is slow (~9 min) and /tasks/active progress is bursty/unreliable — V1 UI
  should not trust that field for progress feedback (deferred to a later phase, no UI in V1 scope)
interfaces_created:
- packages/arc-domains/src/arc-voice/{release,seed,manifest,acquire,activation,cleanup,runtime}.ts
  (acquire -> stage -> verify -> activate -> health -> repair -> rollback pattern, mirrors arc-runtime;
  Arc packages ONLY the voicebox-server component, never the ~512MB upstream GUI bundle, at build/release
  time via apps/desktop/scripts/prepare-arc-voice-runtime.mts)
- process.ts: ArcVoiceProcess.kill() now refuses to signal any process group once hasExited() is true
  (fixes a PID-reuse process-group-safety hazard found by both ARCHITECT and REVIEW, confirmed resolved
  by an independent post-fix re-review of both roles); killResidualTree() unchanged (still needed for
  post-exit residual sweeping of orphaned grandchildren)
- runtime-manager.ts: #awaitClose uncancelled-timer issue from V0 fixed via injectable scheduleTimeout
contracts_for_next_phase:
- ArcVoiceRuntimeService (voiceRuntime.* shape): status()/prepare()/start()/stop()/repair()/update()/
  rollback()/recordRuntimeExit() — start() always launches from paths.executablePath (Arc-owned,
  never PATH), update()/rollback() never redownload, only re-verify the pinned digest
- runtime-manifest.json shape: schemaVersion/runtimeId/createdByArcVersion/platform/arch/activeVersion/
  previousVersion/knownGoodVersion/source/installPath/digest/digestsByVersion/installedAt/healthState
constraints:
- no product wiring, no composer/STT/TTS UI exists yet — V1 was library/runtime-manager scope only
- pinned release digest for voicebox-server 0.5.0 darwin-arm64:
  c8e7fd28b0177ad2c0bd9feb8de5f5415f73fbf3588afedd0f03a0621263967a
unresolved:
- low-severity TOCTOU noted by post-fix re-review in process.ts kill(): hasExited() then groupExists()
  checked before signalling, theoretical PID-reuse race in the gap; accepted as safe for V1 given the
  synchronous Node event loop, but any future refactor introducing async work between those checks and
  the actual signal must not silently reopen this — add a comment noting the ceiling at that point
- CUDA/ROCm backend-variant env var is unverifiable on darwin/arm64 (platform gap, not a contract issue)
```

## V2 (PASS — closed 2026-09-23, final validation re-ran the focused checks on the frozen tree)

```
phase: V2
result: PASS
objective: one-shot dictation in the existing thread composer — first mic click records, second click
  transcribes, the transcript is appended editable to the live draft and is never auto-submitted
interfaces_created:
- packages/arc-voice-host/** (new non-@bb package bb-arc-voice-host): the entire V1 Arc Voice implementation
  moved out of private @bb/arc-domains (14 src + 16 test files, imports rewritten), plus new src/digest.ts
  (sha256File) and src/platform.ts (resolveArcPlatformIdentity) because the host boundary forbids sharing them
- packages/arc-voice-host/src/runtime.ts: ArcVoiceRuntimeService.transcribe(args) — starts the runtime on
  demand, reuses it across dictations, refuses an already-aborted call before touching the client, delegates
  to the single ArcVoiceRuntimeManager
- plugins/arc-core/src/voice-host.ts (new host entry): ai.voice.transcribe handler + typed refusal for
  ai.inference.complete, lazily owns ONE ArcVoiceRuntimeService, stops it on dispose
- plugins/arc-core/src/server.ts: registers the `arc-voice` voice AI service (Arc launches only)
- apps/app PromptBoxHandle.appendVoiceTranscript(text): append-at-end with whitespace reconciliation
- useVoiceInput(options.scopeKey) / usePromptVoice(ref, scopeKey): composer scope identity into the lifecycle
- apps/server voice-transcription: AbortSignal threaded route -> typed AI-service host RPC; cancellation maps
  to 408 transcription_cancelled (retryable false) and suppresses late success
- packages/arc-domains/src/arc-runtime/environment.ts: ARC_VOICE_RUNTIME_ROOT / ARC_VOICE_SEED_ROOT /
  ARC_VOICE_APP_VERSION (non-BB_ prefixed, so the daemon's BB_* stripping keeps them) plus
  BB_TRANSCRIPTION=arc-voice/default for Arc-owned launches (an explicit value still wins)
contracts_for_next_phase:
- host-facing Arc Voice now lives in bb-arc-voice-host, NOT @bb/arc-domains/arc-voice: bb-plugin-build
  rejects any private @bb/* import anywhere in a host artifact's graph
  (packages/plugin-build/src/build-plugin-host.ts). A later phase importing the old path must use the new package
- V1 service surface unchanged (status/prepare/start/stop/repair/update/rollback/recordRuntimeExit) and all
  160 moved V1 tests pass; only transcribe() was added
- renderer contract unchanged: POST /system/voice-transcription -> {text}; the host entry returns only
  {ok, model, text} or {ok:false, code, message} — no Voicebox address/port/token/path/pid crosses it
- launcher contract: a plugin worker started without ARC_VOICE_* reports service_unavailable with an
  actionable message, never a silent failure
constraints:
- no TTS/V3, no ACP/MCP transport, no second runtime/HTTP manager, no persisted audio, no auto-send
- audio is in-memory only; the failed-capture download affordance and the infinite toast are gone on every
  terminal path (success, cancel, failure, scope switch, unmount)
- no live Voicebox, no live Arc desktop launch, and no live-browser run was performed in V2
evidence:
- focused re-run on the final tree: bb-arc-voice-host 14 files/160 tests; bb-plugin-arc-core 6 files/34 tests;
  @bb/arc-domains test/arc-runtime-environment 18 tests; @bb/server test/ai/voice-transcription 15 tests;
  @bb/app useVoiceInput + usePromptVoice + PromptBoxInternal 3 files/175 tests; packages/scripts
  bundled-plugin-tasks 2 tests
- typecheck 10/10 for @bb/app, @bb/server, @bb/desktop, bb-plugin-arc-core, bb-arc-voice-host, @bb/arc-domains
- bundled host artifact plugins/arc-core/.bundled-runtime/dist/host.js = 1,208,243 bytes, 0 "@bb/" imports
  (proves the private-package boundary holds)
- terrain freshness --project the-arc = 68, stale_reason working_tree_dirty (V2 uncommitted, expected);
  source index 95 / agent context 85 / human docs 68, baseline cc04882
unresolved:
- cold first use installs Voicebox (stage + digest verify + version probe) and can exceed the 10s
  transcription timeout and 11s host-RPC budget; nothing calls prepare/update at Arc startup yet, so a first
  dictation on a machine without Voicebox may surface as a timeout before a retry succeeds
- host-worker ARC_VOICE_* propagation, real Voicebox install and real transcription are not verified against
  a live Arc desktop launch; the V1 integration tests stay gated behind ARC_VOICEBOX_INTEGRATION_ARTIFACT
- sha256File / resolveArcPlatformIdentity are duplicated between bb-arc-voice-host and @bb/arc-domains; keep
  them in lockstep by review or hoist into a neutral host-primitives package
- bb-arc-voice-host/src/manifest.ts no longer cross-checks its runtime source list against arc-runtime's
  ArcRuntimeSource union (compile-time guarantee lost in the move)
- manager stop allows 5s graceful + 2s force, above the documented 5s host dispose budget, so a hard worker
  kill is possible; V1's orphan guard (process.on("exit") + SIGKILL) is then the remaining protection
- removing the download affordance / infinite toast also changes the shared non-Arc dictation path
  (product-owner confirmation pending)
- pre-existing and not V2-caused: apps/server/test/services/plugins/plugin-ai-services.test.ts flaked once in
  8 runs (esbuild plugin-load test in an unmodified file, 14.3s vs 6.8s); passed 7 consecutive runs after
- carries over from V1: the process.ts kill() TOCTOU ceiling and the unverifiable CUDA/ROCm backend variant
```

## V2.1 (PASS on the reported defect — closed 2026-09-24; two runtime-lifecycle items left open, see unresolved)

```
phase: V2.1
result: PASS for the reported defect (installed-app dictation of a normal Chromium recording works end to end);
  V2 as a whole still has an open first-dictation cold-start failure — see unresolved
objective: fix the V2 production validation failure "Arc Voice cannot transcribe audio of type
  audio/webm;codecs=opus" — the first dictation from the installed /Applications/Arc Agent.app
root_cause:
- TWO independent defects, in order of encounter:
  1. plugins/arc-core/src/voice-host.ts gated input.mimeType with
     /^audio\/[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/u, whose charset excludes ";" — so every real Chromium
     recording type ("audio/webm;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/ogg;codecs=opus")
     was rejected before the runtime was ever touched. This produced the exact user-visible message.
  2. behind that gate, Voicebox 0.5.0 cannot decode those bytes at all, so loosening the pattern alone
     (the naive fix) would only have moved the failure to HTTP 500 "could not open/decode file".
voicebox_supported_input_formats (live-probed against the real managed 0.5.0 binary, loopback + disposable
--data-dir, real speech fixture from `say`):
- ACCEPTED: RIFF/WAVE PCM — 16k/44.1k/48k, mono and stereo, 16-bit and float32 (HTTP 200 + correct text)
- REJECTED: WebM/Opus, MP4/AAC, MP3, Ogg/Opus, AIFF — HTTP 500 {"detail":"could not open/decode file"}
  (the set is exactly Python stdlib `wave`-shaped: RIFF containers only)
- MIME type and filename are IGNORED by Voicebox: WAV bytes sent as name "blob" + application/octet-stream
  returned 200; WebM bytes named "tricky.wav" returned 500. Decoding is content-based, so a MIME/filename
  relabel can never fix this — the bytes must genuinely be converted.
recorded_arc_mime: Electron/Chromium MediaRecorder produces "audio/webm;codecs=opus" (verified live:
  a real MediaRecorder in Chromium captured 1.39 s of speech as 22,443 bytes of WebM/Opus)
normalization_chosen: renderer-side Web Audio, no new dependency (no ffmpeg, no new HTTP client):
- apps/app/src/lib/voice-audio-normalization.ts: Blob -> AudioContext.decodeAudioData ->
  OfflineAudioContext(1, ceil(duration*16000), 16000) render (mono downmix + 16 kHz resample in one step)
  -> hand-written 16-bit PCM RIFF/WAVE encoder -> File("recording.wav", "audio/wav")
- 16 kHz was chosen over the source rate because it is Whisper's native rate and keeps a 10-minute dictation
  at 19.2 MB, inside the server's existing 20 MB AI-service cap; a 48 kHz upload also works but triples the
  payload for no gain
- the renderer never learns the recording's container: it only labels the error message with it, so every
  Chromium variant (webm/opus, mp4/aac, ogg/opus) takes the identical path
- the host no longer decides on the MIME label at all: it requires RIFF/WAVE magic bytes
  (isRiffWaveAudio) on the decoded payload and answers a typed {ok:false, code:"request_failed"} otherwise.
  Bytes are the boundary contract, so a mislabelled WAV (bb voice transcribe, application/octet-stream
  fallback) still works and unnormalized WebM fails with a clear typed error instead of a Voicebox 500
  (the pre-fix MIME pattern was itself the bug class, so making MIME authoritative again was rejected)
interfaces_created (all in existing files, no new packages):
- apps/app/src/lib/voice-audio-normalization.ts (+ test, 8 tests) — normalizeVoiceRecordingToWav,
  VoiceAudioNormalizationError; aborts before decode / after decode / after render; AudioContext closed on
  every path
- apps/app/src/hooks/useVoiceInput.ts: MAX_RECORDING_DURATION_MS = 10 min guard (renderer decode is what
  makes an unbounded capture dangerous), and the transcription continuation now resets state only when it is
  still the current session (a stale conversion settling after a restart used to clobber a live recording)
- plugins/arc-core/src/voice-host.ts: audio MIME-type pattern (header safety: type/subtype + parameters,
  no CRLF, unambiguous — the parameter body class excludes ";" so the repetition cannot backtrack), a
  128-char bound on mimeType/filename checked before .test(), a 25 MB base64 cap checked before decode,
  and the RIFF/WAVE magic gate
review_loop:
- round 1 (correctness + architecture/security, report-only, no repo access for the reviewers' first pass):
  2 medium + 2 low — unbounded renderer conversion with an un-interruptible decode, WAV size vs the server's
  20/25 MB caps, unvalidated mimeType reaching the outbound multipart header, no host payload cap — plus
  2 correctness items (a stale conversion settling late could clobber a restarted recording and strand a
  live mic; the post-render abort check had no test). All six addressed in the fix pass
- round 2 (same two roles): all six RESOLVED, plus ONE new medium that the fix pass itself introduced —
  AUDIO_MIME_TYPE_PATTERN's "(?:;[ -~]{0,63})*" was exponentially ambiguous because the body class contained
  ";" (measured: 16.5 ms @20 semicolons, 38.4 ms @24, 133 ms @26, still running when killed at 120 s @50,
  on a client-controlled field). Fixed by excluding ";" from the body class and bounding both fields at 128
  chars: <=0.05 ms at every N tested, accept set unchanged, adversarial case added as a test
  (voice-host.test.ts "rejects audio whose content type could break the outbound request"). Round-2 verdict:
  every finding RESOLVED, no further findings; residual noted by the re-reviewer: the pattern no longer
  requires an "audio/" prefix (text/html passes the label gate) — harmless because content is gated by the
  RIFF/WAVE magic check, and it is what keeps application/octet-stream working
contracts_for_next_phase:
- POST /transcribe accepts RIFF/WAVE PCM bytes only; Arc normalizes in the renderer before upload; the
  renderer -> Arc RPC -> host -> Voicebox boundary is unchanged and the renderer still never sees a
  Voicebox path, port, token, or process
- the ai.voice.transcribe RPC schema is unchanged (no audio-format field was added; HOST_DAEMON_PROTOCOL_VERSION
  did not need a bump)
evidence:
- focused (frozen tree): @bb/app 31 tests over useVoiceInput + voice-input-support + usePromptVoice +
  voice-audio-normalization; bb-plugin-arc-core test/voice-host 18 tests; @bb/server test/ai/voice-transcription
  15 tests; PromptBoxInternal 160 tests (full file, incl. the dictation-append and no-autosend suites);
  typecheck 5/5 (@bb/app, bb-plugin-arc-core)
- mutation-checked (each fails pre-fix, passes post-fix): stale-session state clobber, post-render abort
  check, and the MIME-backtracking case (with the ambiguous pattern the plugin suite could not finish in
  120 s; with the fix it is 18 tests in 317 ms)
- byte-level live proof (real Chromium MediaRecorder -> production normalizer -> real Voicebox 0.5.0):
  webm/opus 22,443 B -> raw POST HTTP 500 could-not-decode; production-normalized output 44,204 B
  (RIFF/WAVE, PCM=1, 1 ch, 16 kHz, 16-bit, data 44,160 B) -> HTTP 200 {"text":"This is a voicetest!"}
- installed-app proof: built twice with `pnpm --filter @bb/desktop package` (the second build carried the
  ReDoS fix, so the shipped app matches the final source); the pre-fix installs were moved aside and kept as
  /Applications/Arc Agent.backup-20260924-091652.app and /tmp/arc-voice-probe/Arc Agent.previous-install-*
  (2026-09-23 backup also kept); installed app.asar, MacOS/Arc Agent, server index.js and
  arc-core/dist/host.js are hash-identical to the build; the running arc-core host artifact digest
  95a9e97de54efd08718d07a361280495405ca201de5e2f1d5f025420231da2ff matched the then-installed app's
  arc-core/dist/host.js, and the packaged renderer chunk contains the normalizer + the 10-minute guard and
  the packaged host plugin contains the final gate
- real microphone smoke test on the installed app (draft "Hello ", spoken "this is a voice test" through the
  speakers into the built-in mic): composer became "Hello This is a voice test." in 3.2 s — draft preserved,
  single separating space, transcript editable, nothing sent. Run first on the first install (3.2 s) and
  repeated on the final install; only deviation from the literal expected string is Whisper's own sentence
  casing/period, which the app must not rewrite
- the managed runtime was verified as the one used: the app spawned
  <Arc Agent>/arc-runtimes/voicebox/active/voicebox-server --host 127.0.0.1 --port 47873 --parent-pid <arc-core
  worker>, /health 200, 621 MB RSS with the model loaded; a direct POST of a WAV to that port returned the
  correct transcript in 3.1 s, and POST /api/v1/system/voice-transcription (WAV) returned 200 in 3.1 s
- cleanup: <Arc Agent>/voice/temp is empty after dictation; the source Blob and chunks are dropped, the
  AudioContext is closed, no object URL or temp file is created anywhere in the path
unresolved:
- FIRST DICTATION AFTER A COLD RUNTIME STILL FAILS — pre-existing, documented in V2, now the next blocker in
  line: a cold voicebox-server costs ~18.5 s for its first /transcribe (PyInstaller boot + MLX model load),
  far above the 11 s host-RPC budget, so the first attempt after app launch ends in
  "host plugin call ... exceeded its deadline" (server log, durationMs 16016 / 11004); the retry succeeds and
  the model then serves in ~3 s. Nothing prewarms the runtime at app startup (V2 noted this); fixing it is a
  product decision (prewarm cost vs first-use latency) and was not taken in this pass
- arc-core plugin-host worker reaping can orphan the runtime: the worker that spawned it (pid 37541) was gone
  while its voicebox-server tree survived with PPID 1 (it even survived an app quit), and
  ArcVoiceRuntimeManager.start() always launches a new process with no adoption path — the replacement
  worker's spawn fails to bind and is only "ready" because the orphan answers the port health check. After
  the reinstall a second, duplicate instance was observed running alongside the orphan (PIDs 47339/47361,
  spawned by the new worker, model loading again), which is the same gap from the other side. Worth a
  dedicated pass; not touched here
- Whisper-base hallucinates words over the silence at either end of a dictation (observed "HI.", "As you see
  on screen." repeated, and a repeated foreign phrase) — a model/prompt-quality issue on the shared dictation
  path, not a format defect; the app faithfully appends whatever the service returns
- carries over: V1's process.ts kill() TOCTOU ceiling, the unverifiable CUDA/ROCm backend variant, the V2
  duplication of sha256File / resolveArcPlatformIdentity, and the ArcRuntimeSource compile-time check lost in
  the V2 move
- the pre-existing repo-wide @bb/app lint baseline (157 errors) is unrelated to this pass: the five files
  touched here report only one pre-existing react(set-state-in-effect) warning in useVoiceInput.ts
```

## V2.2 (PASS — closed 2026-09-24; closes the runtime-ownership item V2.1 left open)

```
phase: V2.2
result: PASS — Arc no longer treats "something healthy is answering the Voicebox port" as proof that it
  owns the runtime: an existing Arc-owned runtime is adopted, a foreign holder is refused, a reaped worker
  no longer produces a duplicate, and shutdown leaves no orphan
root_cause:
- ArcVoiceRuntimeManager.start() -> launch() -> #spawnProcess() spawned unconditionally. When the plugin-host
  worker was reaped (observed: the daemon SIGKILLs the worker at 16 s while a call is pending), the detached
  voicebox-server survived with PPID 1 and kept the loopback port; the replacement worker spawned a DUPLICATE,
  its child failed to bind, and waitForReady() polled /health which the ORPHAN answered — so Arc reported a
  ready runtime it did not own. Nothing killed the orphan on quit: its owner was gone and the replacement
  worker never tracked it.
ownership_adoption_design:
- new file packages/arc-voice-host/src/ownership.ts (pure classification + adopted-process handle)
- identity = argv[0] equals Arc's staged executable (<userData>/arc-runtimes/voicebox/active/voicebox-server)
  AND argv carries "--data-dir <Arc voice state dir>" AND "--port <Arc port>", plus the `ps` start-time token
  (lstart) as the anti-PID-reuse discriminator. Listeners come from `lsof -nP -iTCP:<port> -sTCP:LISTEN -t`;
  ps/lsof are resolved by absolute path, never through PATH.
- verdicts (pure function, unit-tested): vacant | owned(listener, duplicates) | owned without listener
  (stale trees to clean) | foreign | unsupported. A listener is adoptable only when it is ITSELF argv-verified;
  a listener that merely shares an Arc-owned process group is treated as cleanup (terminate our tree, spawn
  fresh), so an adopted handle can never be inert.
- start()/launch(): probe -> refuse on a foreign holder (typed failure, never signalled) -> terminate
  non-listening Arc-owned duplicates -> adopt the verified listener, or spawn when the port is vacant.
  After a spawn the process answering the port must belong to our own tree (same pid or same process group)
  or start fails and our child is terminated.
- adopted handles: kill()/killResidualTree() re-verify identity with a fresh, timeout-bounded `ps` read
  BEFORE signalling; group signalling requires an argv-verified group leader with pgid === pid and refuses
  this process's own group (fail-closed when the own group is unknown: single-pid signal only); a failed read
  is never taken as an exit (tri-state lookup found/gone/unknown) so a transient ps failure cannot release
  the orphan guard; the residual SIGKILL ignores the closed latch so the tree is genuinely force-killed;
  liveness polling is asynchronous (no blocking fork/exec on the event loop).
- launch() serializes in-flight acquisition, and start()/recover() re-check the generation after every await,
  so concurrent starts cannot double-spawn and stop() always wins over an in-flight acquisition.
- the restart path performs the same ownership confirmation as start().
contracts_for_next_phase:
- ownership verification is injected (ownershipProbe + adoptedProcessFactory); production wiring in
  plugins/arc-core/src/voice-host.ts injects createPosixArcVoiceOwnershipProbe(). An absent probe or an
  `unsupported` verdict keeps the pre-change trust model — the documented fallback for a platform where
  ps/lsof ownership inspection is impossible.
- ArcVoiceStartResult's ready variant carries `adopted`; ArcVoiceLaunchResult gained an `adopted` variant;
  ArcVoiceProcess gained an optional dispose().
evidence:
- tests: bb-arc-voice-host 200 (was 160; +40 for classification, adopted-handle signalling, manager
  adoption/refusal/concurrency/restart), integration 7/7 against the real pinned 0.5.0 binary (adopt after a
  reaped worker with exactly one tree, foreign-port refusal, real process-group ownership), bb-plugin-arc-core
  40, @bb/app 5175; typecheck 5/5
- real app on the installed /Applications/Arc Agent.app (installed artifacts hash-identical to the build):
  created a deliberate orphan (leader 95994 + listener 96156 with PPID 1) -> the first dictation failed on the
  pre-existing 11 s cold deadline (host-daemon log: `host plugin call … exceeded its deadline`) and the
  process set was UNCHANGED by that attempt (adopted, no duplicate; the orphan spawned its own model worker
  97542 inside its existing group) -> the retry transcribed in 2.9 s and appended to the preserved draft ->
  quitting killed the whole adopted tree within 1.5 s (zero voicebox processes, zero port listeners) ->
  relaunch spawned exactly one owned tree and a later dictation returned "this is a voice test" in 4.7 s
review:
- two independent report-only passes. Correctness found: concurrent start() double-spawn (a regression
  against the pre-change synchronous spawn), stop() racing an in-flight acquisition, and the
  group-only-listener/adopted-handle identity inconsistency. Safety found: killResidualTree() inert once the
  close latch is set (no SIGKILL ever delivered), a failed ps read treated as an exit (guard released, orphan
  survives), fail-open own-group check, an inert handle for group-only listeners, PATH-resolved ps/lsof, and
  the restart path skipping the ownership confirmation. All were fixed and re-verified; the new tests also
  caught a defect in the async lsof exit-code handling (exit 1 misread as failure, so a vacant port reported
  `unsupported`), fixed with them.
unresolved:
- the V2/V2.1 cold-start blocker is unchanged and deliberately untouched: the first dictation after a cold
  runtime still fails against the 11 s host-RPC budget (~18.5 s first /transcribe); no timeout change and no
  prewarm was introduced.
- adopting a runtime left by a PREVIOUS Arc version promotes the installed version as known-good even though
  the running process is the older binary (argv identity cannot distinguish file contents). Bounded: the
  adopted process dies on the next stop/quit and the transcribe contract is unchanged.
- an `unsupported` probe (win32, or ps/lsof unavailable) silently falls back to the pre-change trust model;
  documented here rather than surfaced to the user.
```

## V2.3 (PASS — closed 2026-09-24; the last V2 blocker, cold first transcription)

```
phase: V2.3
result: PASS — a legitimately cold first dictation now has a budget that covers the model load, warm
  dictation stays fast, cancellation is still prompt, a hung Voicebox still ends in a typed timeout, and
  the voice budget is voice-specific (the global plugin-host timeout is untouched)
root_cause:
- the voice transcription operation budget was INFERENCE_POLICY.voiceTranscription.timeoutMs = 10_000, so
  the server asked the host for `timeoutMs: 10_000 + hostRpcGraceMs 1_000` = 11_000. That 11 s value was the
  daemon's `plugin.host.call` deadline, and the daemon force-kills the plugin worker 5 s later
  (CANCEL_GRACE_MS), which is the 16 s SIGKILL observed in the V2.1/V2.2 sessions. Voicebox loads its
  Whisper model lazily on the first /transcribe, measured here at 52.7-53.8 s cold against 2.9-5.1 s warm,
  so the deadline always expired mid-load.
- three timeouts sat on the path and only one of them mattered: the client's own request budget
  (DEFAULT_REQUEST_TIMEOUT_MS 60_000, inert because the daemon cancelled first), the 11 s daemon deadline
  (first to expire, and the one that killed the worker), and Voicebox itself (no timeout). The contract's
  `input.timeoutMs` was accepted and ignored by the plugin, so nothing carried the server's intent down.
timeout_ownership:
- expected cold transcription (measured worst): 53_000 ms
- transcription operation budget (Voicebox /transcribe, and the `input.timeoutMs` the server sends): 120_000 ms
- host/plugin deadline (plugin.host.call timeoutMs): 135_000 ms (operation budget + 15_000 ms margin)
- server transport rpc budget: 141_000 ms (host deadline + HOST_RPC_TRANSPORT_GRACE_MS 6_000); the transport
  call uses callHostOnlineRpc (retryOnTransportFailure false), so the budget is not halved by the retry path
- host daemon force-kill backstop: 140_000 ms (host deadline + CANCEL_GRACE_MS 5_000)
- renderer: no deadline of its own; the user's cancel is the only abort
- unchanged: COMMAND_TIMEOUT_MS 30_000 for every other plugin call, and the OpenAI transcription path's
  10_000 ms budget
implementation:
- apps/server/src/services/ai/inference.ts: VOICE_TRANSCRIPTION_MEASURED_COLD_TRANSCRIPTION_MS 53_000,
  VOICE_TRANSCRIPTION_OPERATION_BUDGET_MS 120_000, VOICE_TRANSCRIPTION_HOST_DEADLINE_MARGIN_MS 15_000,
  INFERENCE_POLICY.voiceTranscriptionHostDeadlineMs 135_000, INFERENCE_POLICY.openAiVoiceTranscriptionTimeoutMs
  10_000 (the OpenAI path no longer rides on the voice budget)
- apps/server/src/services/ai/voice-transcription.ts: the host call now requests
  voiceTranscriptionHostDeadlineMs instead of `timeoutMs + hostRpcGraceMs`
- packages/arc-voice-host/src/client.ts: ArcVoiceCallFailureCode ("aborted" | "timeout" | "transport" |
  "http" | "protocol" | "unavailable") is now required on every error result; ArcVoiceTranscribeArgs gained
  timeoutMs; transcribe owns its own deadline (AbortSignal.timeout composed with the caller's signal) and
  classifies the outcome from its own signals rather than from DOMException names, so a hung request is a
  typed `timeout` and a cancelled one is `aborted`
- plugins/arc-core/src/voice-host.ts: forwards `input.timeoutMs` to the runtime (previously ignored) and maps
  a typed `timeout` to the RPC `timeout` code, so a hung Voicebox is reported before the daemon deadline; a
  runtime that cannot be started (`unavailable`) is reported as the retryable `service_unavailable` instead of
  the non-retryable `request_failed`, matching the plugin's own requireService failure path
- a plugin-reported timeout is now final: transcribeWithAiService throws the user-facing 504
  transcription_timeout instead of an AiServiceCallError, so a 2 minute stuck runtime is not retried for a
  further 2 minutes. Transient (rate_limited / service_unavailable) retries are unchanged.
- packages/arc-voice-host/src/runtime.ts: the operation budget now bounds the WHOLE transcription, runtime
  start included, not just the HTTP request. transcribe arms AbortSignal.timeout(timeoutMs) at entry, races the
  operation (start + client transcribe) against it, and resolves with a typed `timeout` (or `aborted`) the
  moment the budget or the caller signal fires; the abandoned operation keeps running in the worker, so the
  runtime finishes starting for the next call. Without a budget the caller signal is passed through untouched
review:
- one independent report-only pass (TimeoutChainReview) over the whole chain. Confirmed: no timeout expires
  before a legitimate cold transcription; the transport call does not halve the budget; a plugin timeout is
  final while transient failures still retry; cancellation is prompt at every layer; no request can hang
  forever; adding the required `code` broke no consumer. Two findings, both fixed:
  1. the host-deadline margin (15 s) was smaller than the runtime start readiness bound (30 s + acquire probe),
     and the operation budget was armed only after start, so a slow cold start followed by a hung /transcribe
     could exceed the host deadline and be SIGKILLed instead of timing out. Fixed by bounding the whole call
     (above), which makes the guarantee hold for any start duration without widening the outer budgets.
  2. `unavailable` was collapsed into the non-retryable request_failed. Fixed by mapping it to
     service_unavailable.
- residual, not fixed: only 5 s separates the daemon force-kill (140 s) from the server transport timeout
  (141 s), and a server-side command_timeout is transient, so a stalled daemon can still cost two budgets;
  the daemon normally answers first and this ordering was strictly worse before V2.3 (transport 12 s <
  force-kill 16 s)
evidence:
- tests: bb-arc-voice-host 204 (client timeout/abort typing, budget forwarding, whole-call budget for a slow
  start and for a cancel during start, codes), bb-plugin-arc-core 43, @bb/server 3041 passed with the
  voice+inference budget-ordering tests, @bb/host-daemon 727, @bb/app 5175; integration 7/7 against the real
  pinned 0.5.0 binary; typecheck 7/7 across the touched packages; @bb/server has one unrelated pre-existing
  failure (install-machine-script.test.ts spawns a daemon that aborts inside node::InitializeOncePerProcessInternal
  before any app code runs - crash report node-2026-09-24-105233.ips, files untouched by this pass)
- real installed app (/Applications/Arc Agent.app, artifacts hash-identical to the build; installed budgets
  verified in the packed bundle: operation 120_000, host deadline 135_000, transport 141_000, global
  command timeout still 30_000, plugin forwards the budget and maps timeout/service_unavailable):
  fully cold app and runtime (zero voicebox processes before) -> first dictation with the draft "Hello "
  returned "Hello " + the spoken phrase in 40.5 s on the final build (52.7 s and 53.8 s on the two earlier
  cold runs) with the transcribing state visible and no error toast -> second (warm) dictation returned in
  9.1 s (5.1 s on an earlier run) -> quit killed the whole tree within 1.2 s (zero voicebox processes, port
  47873 free) 
- no-deadline / no-kill proof: across every V2.3 run the host-daemon log added zero "exceeded its deadline"
  entries (8 before and after) and the only worker SIGKILL was the pre-fix cancellation probe; after the fix,
  cancelling twice (once during a cold runtime start) added no SIGKILL and the same runtime tree leader
  survived both, with the runtime finishing its start in the background
- cancellation: "Cancel transcription" returned the composer to idle in 9 ms, kept the draft intact and
  inserted nothing later, while the operation kept warming the runtime server-side
- runtime ownership: one tree (leader + port listener + model worker, one pgid) unchanged across every
  dictation and across the cancel; no duplicate or orphan; V2.2 unit and integration suites still green
unresolved:
- the operation budget is sized from measurements taken on this machine under load (52.7 s cold on a fresh
  install, 53.8 s cold on the interim build, 40.5 s cold on the final build); a materially slower host or disk
  would need the constants raised again, and the only signal is the 504 transcription_timeout.
- maxAttempts stays 2 for transient failures, so a *single* stuck runtime is bounded at one operation budget
  (120 s) and a transient failure still costs one retry.
- the plugin does not clamp input.timeoutMs; the daemon's own host deadline is the only upper bound.
- a dictation that follows a *cancelled cold start* still pays the model load (37.4 s observed): the cancel
  prevents the /transcribe that would have loaded the model, so the next call loads it. The runtime process
  itself is reused (same leader pid across the cancel), which is what the pre-fix code could not do.
- transcription quality is out of scope: whisper-base hallucinated repeated trailing words on some TTS
  captures ("technology", "Appointment") while the same phrase transcribed cleanly on other runs.
```

## V3 (PASS — closed 2026-09-24; TTS for agent replies + truthful cold-STT phases)
```
phase: V3
result: PASS
interfaces_created:
- packages/plugin-sdk/src/ai-services.ts: "ai.voice.status" {serviceId} -> {ok, runtimeState:
  stopped|starting|ready, speechModelLoaded, voiceModel: {engine, size, downloaded, loaded, downloading,
  downloadPercent|null} | null} | failure; "ai.voice.speak" {serviceId, text(1..1200), language|null,
  profile|null, engine|null, timeoutMs} -> {ok, audioBase64, contentType, durationMs|null} | failure
- packages/server-contract: GET /api/v1/system/voice-status -> SystemVoiceStatusResponse (transcriptionEnabled,
  speech); POST /api/v1/system/voice-speak {text} -> binaryResponse<Uint8Array> (audio bytes + content type)
- packages/arc-voice-host: ArcVoiceClient.modelStatus/loadVoiceModel/voiceModelProgress; ArcVoiceSpeakArgs
  gained signal/timeoutMs; ArcVoiceRuntimeService.speechStatus()/speak() (whole-call budget, typed
  timeout/aborted, generation cancel on abort); types ArcVoiceTtsStatus/ArcVoiceSpeechStatus
- apps/server/src/services/ai/voice-speech.ts: readVoiceSpeechStatus(), speakVoiceText();
  apps/server/src/services/ai/voice-speakable-text.ts: deriveSpeakableText() (MAX_SPEAK_TEXT_CHARS 1200)
- apps/app/src/lib/api.ts: readVoiceStatus(), speakVoiceText(); apps/app/src/lib/speech-chunks.ts:
  chunkSpeechText(); apps/app/src/components/thread/timeline/message-speech.tsx: MessageSpeechProvider,
  useMessageSpeech() (idle|preparing|generating|speaking)
- apps/cli/src/commands/voice.ts: `bb voice speak <text> [--out <file>]`
contracts_for_next_phase:
- Voicebox TTS (runtime-verified): POST /speak needs a resolvable voice; Arc ensures a preset profile
  ("Arc Voice", engine kokoro, preset voice af_heart) through GET/POST /profiles, then polls GET /history/{id}
  and fetches GET /audio/{id}, which returns audio/x-wav at ~48 kB/s (24 kHz mono PCM, RIFF magic);
  POST /generate/{id}/cancel cancels an in-flight generation; GET /profiles/presets/{engine} lists preset
  voices (qwen: none — cloning engine; qwen_custom_voice: Ryan/Aiden in en; kokoro: 50 incl. many en)
- model state is observable and truthful: GET /health.model_loaded (TTS), GET /models/status per model
  downloaded/downloading/loaded (whisper-* = STT, qwen-tts-*/qwen-custom-voice-*/kokoro = TTS),
  GET /models/progress/{model} (SSE text; `progress` arrives as 0..1 or as a percentage depending on the
  sample, and tracks the current file — Arc normalizes and clamps to 0..1)
- speechModelLoaded is not a "stays warm" guarantee: loading the TTS model evicts the whisper model, so the
  next dictation truthfully shows "Preparing speech model…" and pays a re-load (25.7 s measured after TTS use)
- Arc default TTS is engine kokoro + preset voice af_heart + profile "Arc Voice" (configurable through
  ARC_VOICE_TTS_ENGINE / ARC_VOICE_TTS_VOICE). The plan's Qwen3-TTS base engine cannot speak without a cloned
  profile, and qwen_custom_voice works only with a 4.16 GB first-use download, so Qwen stays a V4 choice
constraints:
- the renderer speaks only the completed assistant conversation row's visible `text` (speakText is withheld
  while the row is streaming); the server derives the spoken form: fences, diffs, tracebacks, JSON/key-value
  dumps and internal markers are stripped and the result is capped at 1200 chars
- the renderer chunks the raw visible text at 600 chars on sentence boundaries, fence-aware and
  newline-preserving, because the server's stripping rules are line-oriented (flattening newlines silently
  disables the filter)
- one MessageSpeechProvider is mounted per timeline surface (inside ThreadTimelineSurface, keyed by threadId);
  the provider owns the single HTMLAudioElement, aborts in flight requests, revokes object URLs, and tears
  down on Stop, a second Speak, a thread switch and unmount
- the composer's `preparing` state comes from one status read taken before the first state set, so warm
  dictations never show it; the Speak chip seeds `generating` and the status poll corrects it to `preparing`
- no launch-time or idle voice work: nothing reads voice status, loads a model or starts the runtime until the
  user stops a recording or presses Speak
evidence:
- tests: bb-arc-voice-host 215 (model status parsing, load abort, progress first line, speechStatus without
  starting the runtime, speak budget/abort), bb-plugin-arc-core 49 (status passthrough, speak validation,
  code mapping, audio cap), @bb/server 3057 passed (voice-speakable-text 10, voice-speech; one pre-existing
  install-machine-script failure, one builtin-plugins hot-reload flake that passes in isolation), @bb/app 275
  across the 9 voice-focused files (useVoiceInput 20 incl. cold/warm/cancel-during-status-read, speech-chunks 8
  incl. fence preservation, message-speech 8, MessageActionBar 40, PromptBoxInternal 161, VoiceRecordingBar,
  usePromptVoice, ConversationMessageContent incl. streaming), integration 7/7 against the real pinned 0.5.0
  binary, typecheck clean across the eight touched packages
- installed app (/Applications/Arc Agent.app, asar hash-identical to the build, zero voicebox processes before
  launch): no process starts at launch; cold dictation 47.3 s showing "Preparing speech model…" then
  "Transcribing locally…" with the draft "Hello " preserved; warm dictation 4.8 s with no preparation state;
  a later dictation truthfully showed "Preparing speech model…" for 25.7 s because TTS use had evicted whisper
- the composer phase text is a visible label, not only an sr-only live region: the installed app renders
  "Preparing speech model…" / "Transcribing locally…" as a 100x14 px span beside the waveform (verified in the
  live DOM), and "Recording" still has no visible label
- Speak: real click on a completed assistant reply -> "Generating speech…" then "Speaking…" within 4.4-4.9 s,
  Stop returned to idle in under 0.1 s, a second Speak left exactly one active playback (one Stop chip, no
  overlap), switching threads during playback cleared the action and the phase chip, and no run produced a
  failure toast. 8 real kokoro generations are recorded in the runtime database (35.33 s for a long chunk)
  whose text matches the assistant message's visible opening words
- hard boundary proof through the real runtime: the same prose with and without an embedded ```ts block
  produced byte-identical audio (126 044 bytes), i.e. the code block was never spoken
- no regressions: worker SIGKILL count and "exceeded its deadline" count in the host-daemon log were unchanged
  from the V2.3 baselines (5 and 8) across every V3 run; quitting Arc left zero voicebox processes and freed
  the runtime port within 1.6 s
review:
- one independent report-only pass found five defects, all fixed and re-checked: the chunker flattened
  newlines (which silently disabled the server's line-oriented stripping, so fenced code would have been
  spoken), Speak was offered on a still-streaming row, a cancel issued while the post-recording status read was
  pending was dropped, a superseded prefetch rejection was left unhandled, and an unused hook field remained.
  The live validation that followed found one more: the speak provider had been mounted only in
  ThreadTimelinePanelContent, which the main thread view does not render, so the Speak button was inert there.
  The focused re-review passed five items and required one more fix (the scope-key/unmount teardown could still
  re-enable a pending transcription after a thread switch), which was applied together with a regression test;
  the composer phase label was also made visible rather than screen-reader-only.
unresolved:
- downloadPercent is carried through the contract but no V3 surface reads it: a first-use kokoro download
  (327 MB) shows only "Preparing voice…" with no percentage — V4 surfaces it in the settings download UI
- both status readers poll the same route every 400 ms; there is no push channel, so a phase can lag by up to
  one interval
- state is provider-local per timeline surface, so two simultaneously mounted surfaces could each play
- a long reply is spoken as several sequential chunks with no pause/seek/replay, and the chip is text-only
- the voice is a fixed English preset; per-user/per-agent voices, a voice gallery and the Qwen3-TTS path
  remain V4 work (done in V4)
- a speak that follows a *cancelled cold start* still pays the model load; cancelling does not warm anything

## V4 (PASS — closed 2026-09-24; Settings → Voice + Voice Gallery + custom voices + STT hardening)
```
phase: V4
result: PASS
sdd: .bb/workflows/arc-voice-v4-sdd.md (design artifact; live-probed Voicebox 0.5.0 API contract
  transcript embedded: profile CRUD + samples verified by real mutation, /transcribe model field
  verified to accept base|small|medium|large|turbo, /speak verified to have NO speed/instruction
  field, /transcribe returns {text,duration} only — no confidence signal exists)
interfaces_created:
- packages/domain/src/voice-settings.ts: voiceSettingsSchema (stt{model,language}, tts{engine,
  voiceKind,presetEngine,presetVoiceId,profileId,playbackSpeed}, input{reduceBackgroundNoise},
  behavior{showMicrophone,autoSpeakReplies,keepWarm}) + defaultVoiceSettings (whisper-base /
  kokoro af_heart / noise on) — extends strict appSettingsSchema; old DB rows parse to defaults,
  no migration (getAppSettings per-key safeParse)
- packages/plugin-sdk/src/ai-services.ts: transcribe input +language; status output +version;
  speak input +voiceId; new RPCs ai.voice.capabilities/profiles/profileCreate/profileUpdate/
  profileDelete/profileSampleAdd/profileSampleRemove/modelDownload/modelDownloadCancel/repair/prepare
  (HOST_DAEMON_PROTOCOL_VERSION 215 -> 216)
- packages/server-contract: systemVoiceCapabilities/Profile*/Model* schemas + 11 new routes under
  /system/voice-*; speak request +engine/profile/voiceId/language; status speech +version
- packages/arc-voice-host: client listProfileDetails/createProfile/updateProfile/deleteProfile/
  addProfileSample/removeProfileSample/listPresets/listModels/downloadModel/cancelModelDownload
  (HTTP method union widened to PUT/DELETE); ensureProfile generalized to per-preset profiles
  "Arc Voice · <voiceId>" (was single fixed "Arc Voice" — V3's af_heart-only world); runtime
  service #ensureStarted + capabilities()/prepareForSpeech()/profile+model passthroughs
- plugins/arc-core/src/voice-host.ts: all 14 handlers; transcribe accepts whisper-* models
  (strips prefix; "default" preserved) + validated language; sample upload reuses the WAV/base64/
  MIME gates; qwen without a cloned profile is a typed refusal, never a silent kokoro fallback
- apps/server: speakVoiceText resolves engine/profile/voiceId from persisted settings (explicit
  request args win); voice-transcription sends settings stt model/language only for the
  arc-voice "default" modelId (other providers untouched); voice-speech.ts control plane
  (capabilities/profiles CRUD/samples/models/repair/prepare); keep-warm prepare after plugin
  start when behavior.keepWarm (apps/server/src/start-server.ts)
- apps/app: api.ts speakVoiceText options {engine,profile,voiceId,language} + 11 voice API
  functions; settings nav "voice" + components/settings/voice/ (18 files: section, gallery,
  my-voices, create wizard, shared non-overlapping preview controller, download controls,
  4 test suites); autoSpeakReplies auto-invokes the existing Speak handler once per completed
  row (visible tab only, per-session dedupe); STT hardening: capture constraints
  (echoCancellation/noiseSuppression/autoGainControl as ideal constraints, toggle-driven),
  analyzeVoiceEnergy silence detection over the rendered 16 kHz PCM (skips Whisper entirely),
  isPathologicalRepetition transcript guard (repeating-unit detector, genuine "haha"/short
  dictation/Arabic-English pass), rejection = "No clear speech detected. Try again." with the
  draft untouched
contracts_for_next_phase:
- Voicebox preset speaking requires a per-preset profile: server passes voiceId; host ensures
  "Arc Voice · <voiceId>" (GET /profiles -> POST /profiles if missing). Arc stores NO Voicebox
  internals beyond settings.profileId for cloned voices — Voicebox owns all audio/embeddings
- Model state is truthful from GET /models/status; existing downloads (V3 probing) are detected
  there, never redownloaded; downloads only from explicit user action with SSE-normalized
  progress + /models/download/cancel
- /transcribe model values are SIZES (base|small|medium|large|turbo); /speak has no speed field
  (playback speed is renderer audio.playbackRate); /transcribe exposes no confidence
- Settings flow through the existing whole-blob PUT /settings/general (appSettingsUpdateSchema
  union absorbs the voice block); renderer invalidates voice queries via
  hooks/cache-owners/system-cache-effects.ts invalidateVoiceCapabilities/Profiles
  (voiceCapabilitiesQueryKey/voiceProfilesQueryKey in hooks/queries/query-keys.ts)
review:
- cycle 1 (independent report-only reviewer, 5 axes): 1 medium-high + 3 medium + 3 low
  + 1 info. Security and V2/V3-regression axes PASS outright. The material finds:
  cloned voices used the wrong engine in the UI (qwen_custom_voice REJECTS cloned
  profiles — live-probed "Engine 'qwen_custom_voice' does not support cloned voice
  profiles"; cloned profiles speak ONLY via engine qwen, and Voicebox picks
  qwen-tts-1.7B (4.54 GB) for cloned speak, auto-downloading it on demand); qwen
  without a profile had no typed refusal; ensureProfile was name-keyed (hijack/race/
  hardcoded language); wizard stranded on transient sample-add failure; profiles/
  prepare ignored caller cancellation; presets:null conflated failure with
  verified-empty; prepare runtimeState type mismatch
- fix cycle (all applied, SDD engine matrix corrected): UI cloned-voice paths use
  engine "qwen" + gate on qwen-tts-1.7B (CLONED_VOICE_ENGINE/CLONED_VOICE_SPEAK_MODEL
  in voice-models.ts); typed 400 invalid_request for qwen-without-profile on BOTH
  settings and explicit paths before any host RPC; ensureProfile matches
  voice_type=preset + preset_engine + preset_voice_id from the detail listing
  (same-named user profiles ignored, 2 new tests); wizard renders "Retry add sample"
  and blocks Save while the sample add is unresolved; context.signal threaded
  plugin -> service -> runtime -> manager -> client for profiles/prepare; presets
  null only for requiresClonedProfile engines on fetch failure; api type widened
- cycle 2 re-review: PASS — all 7 findings RESOLVED with file:line evidence, no new
  patch defects (residual note: an explicit profile-without-engine request bypasses
  the qwen refusal; no caller produces that shape)
- live proof on the installed app (fixed build, asar hash-identical): cloned speak
  via engine qwen succeeds by BOTH profile id (226 KB WAV, 18.8 s cold) and profile
  name (230 KB WAV, 7.8 s warm) — /speak resolves either identifier; typed refusal
  verified (400 + "Qwen speaks only through a cloned voice…"); full custom-voice
  flow create -> sample -> speak -> delete green on the corrected engine;
  qwen-tts-1.7B downloaded through the app's on-demand flow with live progress
  (~16 min, 4.54 GB, machine kept awake with caffeinate — two earlier attempts died
  to system sleep + idle worker exit, an environmental cause, not a code defect)
evidence:
- domain 268; plugin-sdk 346; arc-voice-host 227 (incl. per-preset profile create/
  reuse + same-name-user-profile tests); bb-plugin-arc-core 34; @bb/db 60; @bb/server
  3060 passed + authoring-docs index updated (new SDK exports documented);
  @bb/app 5246 passed | 3 skipped; typecheck 13/13 via turbo
- installed app (/Applications/Arc Agent.app, asar hash-identical to the build, previous install
  kept as backup): voice-status returns the new version field; capabilities assembled truthfully
  (kokoro 50 presets / qwen 0 presets + requiresClonedProfile / qwen_custom_voice 9 presets;
  V3-downloaded qwen-tts-0.6B + whisper-base + kokoro reported downloaded — zero redownloads);
  custom voice lifecycle create -> sample (multipart WAV + reference_text) -> rename -> delete
  all 200 through the real runtime; PUT settings (whisper-small/af_bella/noise-off) survived a
  full app restart; speak through the persisted selection returned audio/x-wav RIFF and created
  the "Arc Voice · af_bella" profile on first use; whisper-small download showed
  downloading:true with percent then cancelled cleanly; repair ok; STT transcribed 200;
  packaged renderer contains "No clear speech detected" + voice-capabilities + the settings
  chunk; packaged arc-core host.js serves all 14 ai.voice.* methods; quit left zero voicebox
  processes; smoke settings restored to defaults
unresolved:
- real-microphone noisy-input smoke is a manual step (the guard is renderer-side; unit matrix
  covers silence/noise/repetition/false-positives/Arabic-English, and the string + code path are
  present in the packaged bundle)
- Whisper transcribed the synthetic tone fixture as gibberish text ("orada") — the pipeline is
  correct; model quality on non-speech input remains Whisper's own behavior when the renderer
  guards are bypassed (e.g. CLI uploads)
- preset helper profiles ("Arc Voice · <voiceId>") accumulate in Voicebox as presets are
  previewed; Voicebox owns them (Arc stores nothing); they are hidden from My Voices (cloned only)
- qwen_custom_voice curated presets include zh-dominant voices; the UI shows language honestly
- push-to-talk deferred (needs a dedicated voice session — V5); no delivery/instruction controls
  (Voicebox /speak has no such field); chatterbox/luxtts/tada stay hidden (unverified by Arc)
- carries over: V1 kill() TOCTOU ceiling, CUDA/ROCm variant unverifiable on darwin/arm64,
  sha256File/resolveArcPlatformIdentity duplication, speechModelLoaded eviction semantics,
  whisper-base trailing-hallucination quality notes (V4's repetition guard catches the
  pathological cases on the dictation path)
```


## V5 (PASS)
```
phase: V5
result: PASS (review cycle 1 PASS w/ 1 medium + 3 lows, all fixed; cycle 2 PASS, no new defects)
date: 2026-09-24
features:
- Per-agent voices: Settings → Voice → Agent Voices assigns a preset or My Voices
  custom voice to each Arc agent (codex / claude-code / omp). Renderer resolves the
  agent from the thread providerId via the existing providerIdToAgentId mapping
  (apps/app/.../ProviderUsageSection.tsx) and passes agentId on /system/voice-speak.
  Server resolution order (voice-speech.ts): explicit override → [thread override
  slot reserved, null in V5] → agent voice (VALIDATED against live profiles/
  capabilities; invalid → user's own global default, never a random voice) → global
  default. agentId influences voice selection only — no account/model/routing touch.
- Master voice switch: voice.enabled (.default(true)) gates every voice entry point.
  OFF = typed 403 voice_disabled on speak/local-transcribe/prepare/profile
  mutations/downloads/repair; capabilities/status/profiles serve empty shapes with
  voiceEnabled:false and ZERO host RPC (no silent Voicebox start); settings/galleries
  remain inspectable. OFF transition releases the runtime: in-flight drain (5s,
  counter now covers agent-validation RPCs) → host release (best-effort model unload
  → manager stop). OFF overrides keep-warm (startup prepare gated on
  enabled && keepWarm; OFF→ON with keepWarm re-warms). Renderer: playback stops on
  disable, Speak hidden, auto-speak no-ops, mic refuses+cancels, previews refuse+
  stop, keep-warm switch disabled.
- Memory policy (user-directed): behavior.releaseModelsAfterUse (.default(true))
  unloads every loaded model after each speak/transcribe settles; host refuses the
  unload while a speak is in flight (2s settle wait, skip if busy — release() still
  unloads unconditionally before stop). VOICEBOX QUIRK live-probed: global
  POST /models/unload is a NO-OP for the resident model (returns success, model
  stays); per-model POST /models/{name}/unload genuinely unloads and lazy reload
  works — the host client iterates /models/status and unloads per-model.
- Qwen 0.6B request (user): VERIFIED IMPOSSIBLE in Voicebox 0.5.0 — with 0.6B
  downloaded and 1.7B absent, cloned speak auto-downloads 1.7B (model_size "1.7B");
  both qwen engine paths prefer 1.7B; /speak has no model field; no config knob.
  Recorded in SDD; no fake 0.6B-default offered. Memory levers above are the real
  answer (RAM only held during actual synthesis).
interfaces_created:
- host RPCs ai.voice.release + ai.voice.unloadModels (HOST_DAEMON_PROTOCOL_VERSION
  216→217); SDK experimental_aiVoiceReleaseOutputSchema + contract entries; registry
  releaseVoiceRuntime/unloadVoiceModels; arc-core handlers; arc-voice-host
  runtime.release (unload→stop) + runtime.unloadModels (guarded) + client.unloadModels
  (per-model); server releaseVoiceSpeechRuntime + release-after-settings-change;
  contract: speak request agentId; capabilities/status/profiles voiceEnabled
- domain: voice.enabled, voice.agentVoices (VoiceAgentSelection per agent, references
  only), behavior.releaseModelsAfterUse — all .default() (strict blob otherwise
  resets user settings via getAppSettings' safeParse-per-key)
- renderer: VoiceEnabledContext + useVoiceEnabled; useThreadVoiceAgent;
  MessageSpeechProvider agentId + stop-on-disable; PromptVoiceConfig.isEnabled;
  Voice page master switch + Agent Voices section (per-row preview);
  "Unload models after use" behavior switch
contracts_for_next_phase:
- thread voice override slot exists in resolution order (null); a future phase can
  add per-thread voice without schema churn
- Voicebox 0.5.0 model policy: qwen paths demand/prefer 1.7B (auto-download on
  cloned speak); global /models/unload no-ops on the resident model — always
  per-model; downloaded-detection is strict (unrecognized partial caches re-download)
- OFF semantics are release-based, never deletion; models/profiles/assignments
  survive OFF→ON cycles (verified live)
evidence:
- domain 271; plugin-sdk 346; server-contract 79; arc-voice-host 234 (incl. release
  3, speak/unload race 2, per-model client unload 2); bb-plugin-arc-core 56 (contract
  surface updated); @bb/server 3075 passed + authoring-docs index updated for new
  SDK exports (2 pre-existing failures unchanged: install-machine-script daemon
  abort since V2.3, + host-branches flakes); @bb/app 5251 passed | 3 skipped
- REVIEW cycle 1: PASS (1 medium unload-during-speak race + 3 lows: qwen_custom_voice
  no-profile 502, validation RPCs outside drain counter, request_failed conflation) —
  all fixed; cycle 2: PASS, no new defects
- installed-app smoke (fixed build, asar-verified, prior versions backed up):
  per-agent voices end-to-end — codex→af_heart, claude-code→am_adam, omp→Morgan
  cloned (Voicebox history shows distinct profiles per agent, all HTTP 200);
  master OFF — speak/transcribe 403 voice_disabled, capabilities/profiles empty
  with no host RPC, zero voicebox processes in ~8s, 15GB models on disk untouched;
  restart — OFF persists, keepWarm ON overridden (no runtime at settle), all three
  agent mappings intact; re-enable — mappings intact, speak 200, per-agent voice
  resolution intact (claude→am_adam after OFF→ON); unload-after-use verified live
  (loaded list empty seconds after each speak; next speak 200 = lazy reload);
  clean quit, zero orphans; settings restored to defaults afterward
review: PASS (cycle 2)
unresolved:
- transient 503 voice_speak_unavailable when a speak arrives while the runtime is
  mid-boot (e.g. immediately after keep-warm re-warm) — retryable by design, retry
  succeeds; pre-existing V3-era cold-start semantics, not a V5 regression
- the per-model unload fix landed after the review cycles (smoke-discovered Voicebox
  quirk); covered by 2 new client tests + live smoke evidence rather than re-review
- release maps transient request_failed to not-running (old-daemon accommodation;
  self-resolves on daemon update)
- a speak that follows a cancelled cold start still pays the model load (V3-known)
```
