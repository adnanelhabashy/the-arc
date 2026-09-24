export const meta = {
  name: "arc-voice-v2",
  description: "Arc managed-voice V2: STT dictation in the thread composer",
  phases: [
    { title: "Plan" },
    { title: "Implement" },
    { title: "Test" },
    { title: "Review" },
    { title: "Fix" },
    { title: "Re-review" },
    { title: "Validate" },
  ],
};

// Mission Control Router resolved live immediately before this run (2026-09-23) via
// resolve_mission_role for PLAN/TASK/REVIEW/ARCHITECT — all four matched the tuples already
// used by arc-voice.js/arc-voice-v1.js, so they are inlined unchanged. Re-resolve before reusing
// this file if the Router mapping may have changed.
//   PLAN      -> claude-code / claude-sonnet-5               reasoning low
//   TASK      -> acp-omp / opencode-go/deepseek-v4.1-flash    reasoning low   (only code-writing role)
//   REVIEW    -> codex / gpt-5.6-terra                        reasoning low
//   ARCHITECT -> claude-code / claude-sonnet-5                reasoning low   (invoked: V2 crosses the
//     renderer/backend RPC boundary and microphone permission architecture, per plan rule 13)

const TERRAIN_POLICY =
  "Terrain-first: check freshness, use .terrain/agent/context.md and knowledge/ before grepping the repo, " +
  "use CodeGraph for callers/dependencies/impact, use grep-pack/read-pack-file for exact targeted source lines. " +
  "Do not do a recursive repo scan, do not load the full Repomix pack, do not repeat identical searches.";

// Compact V0/V1 PHASE_STATE — contracts_for_next_phase + constraints only, not the full block or
// the master plan. See .bb/workflows/arc-voice-phase-state.md for the authoritative full text.
const V0_V1_CONTRACT =
  "V0/V1 contracts (PASS, do not re-verify, do not re-implement):\n" +
  "- ArcVoiceRuntimeService (voiceRuntime.* shape): status()/prepare()/start()/stop()/repair()/update()/" +
  "rollback()/recordRuntimeExit(); start() always launches from paths.executablePath (Arc-owned, never PATH)\n" +
  "- HTTP contract (runtime-verified in V1): POST /transcribe (multipart file+language+model) -> {text,duration}; " +
  "GET /health -> {status}; error paths 422/404/500 confirmed\n" +
  "- Loopback-only binding; renderer must never call Voicebox directly, never see its executable path or " +
  "HTTP endpoint — go through Arc's backend/RPC boundary only\n" +
  "- Orphan/process-tree cleanup (killResidualTree, process-group-safety in process.ts) already handled by the " +
  "runtime layer — V2 must not duplicate process lifecycle management, just call the service\n" +
  "- cold-start model download can be slow and progress reporting is unreliable — do not block the composer UI " +
  "on a progress percentage, use a simple recording/transcribing state machine instead\n" +
  "- no product wiring existed before V2: no composer/STT UI exists yet, this phase creates it";

const MAX_FIX_RETRIES = 2;

const FINDINGS_SCHEMA = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "summary"],
        properties: {
          severity: { enum: ["critical", "high", "medium", "low"] },
          summary: { type: "string" },
          file: { type: "string" },
        },
      },
    },
  },
};

const RECHECK_SCHEMA = {
  type: "object",
  required: ["decision", "remaining_findings"],
  properties: {
    decision: { enum: ["PASS", "FIX_REQUIRED", "BLOCKED"] },
    remaining_findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "summary"],
        properties: {
          severity: { enum: ["critical", "high", "medium", "low"] },
          summary: { type: "string" },
          file: { type: "string" },
        },
      },
    },
  },
};

const FIX_REPORT_SCHEMA = {
  type: "object",
  required: ["status", "files_changed", "diff_summary", "tests"],
  properties: {
    status: { enum: ["PASS", "BLOCKED", "FAIL"] },
    files_changed: { type: "array", items: { type: "string" } },
    diff_summary: { type: "string" },
    tests: { type: "string" },
  },
};

async function runPhase(spec) {
  phase("Plan");
  const scope = await agent(
    `${TERRAIN_POLICY}\n\n${V0_V1_CONTRACT}\n\n` +
      `Phase ${spec.id} of the Arc managed-voice plan (docs/ARC_AGENT_MANAGED_VOICE_INTEGRATION_PLAN-2.md, section 9).\n` +
      `Objective: ${spec.objective}\n\n` +
      `Find and return a COMPACT PHASE_PACKET (not full file dumps) covering:\n` +
      `- the existing thread composer component(s): draft state, send handler, where a mic button/icon would live\n` +
      `- the renderer-to-backend RPC boundary used for other backend calls (pattern to reuse for voiceRuntime.*)\n` +
      `- how microphone permission is/would be requested in this Electron app\n` +
      `- any existing audio-capture or temp-file-cleanup pattern to reuse\n` +
      `- anything that blocks or changes the plan below\n` +
      `This is planning only — do not write or edit any code. Keep the packet under ~1000 tokens.`,
    {
      label: "plan-terrain-scope",
      phase: "Plan",
      provider: "claude-code",
      model: "claude-sonnet-5",
      reasoningLevel: "low",
    },
  );

  phase("Implement");
  const impl = await agent(
    `Objective: ${spec.objective}\n\n` +
      `Exact scope:\n${spec.scope}\n\n` +
      `Acceptance criteria:\n${spec.acceptance}\n\n` +
      `${V0_V1_CONTRACT}\n\n` +
      `PHASE_PACKET (Terrain findings, use this instead of re-scanning the repo):\n${scope}\n\n` +
      `${TERRAIN_POLICY}\n` +
      `Implement the smallest safe version: click mic -> record, click again -> stop+transcribe, Esc -> cancel, ` +
      `insert transcript into the existing draft without erasing existing text, never auto-send. Call the ` +
      `existing voiceRuntime service through the existing RPC boundary — do not add a new HTTP client, do not ` +
      `expose Voicebox paths/endpoints to the renderer, do not build a second runtime manager. Do NOT spawn or ` +
      `start the real Voicebox process, and do NOT start/run the Arc app itself in this phase — this workspace ` +
      `is the app currently being edited through. Write capture/transcribe logic behind a seam so it can be ` +
      `exercised with fake MediaRecorder/permission/runtime responses in tests. If a step is infeasible without ` +
      `a live process or live browser APIs, say so explicitly and stub it rather than guessing.`,
    {
      label: "task-implement",
      phase: "Implement",
      provider: "acp-omp",
      model: "opencode-go/deepseek-v4.1-flash",
      reasoningLevel: "low",
    },
  );

  phase("Test");
  const tests = await agent(
    `Objective: ${spec.objective}\n\n` +
      `You just implemented this:\n${impl}\n\n` +
      `Write and run the focused tests required by this phase:\n${spec.tests}\n\n` +
      `Tests must use fake/mock MediaRecorder, fake/mock microphone-permission results, and a fake/mock ` +
      `voiceRuntime service — do not spawn a real Voicebox process or start the real Arc app while testing.\n` +
      `Report pass/fail per test and any typecheck/build output.`,
    {
      label: "task-tests",
      phase: "Test",
      provider: "acp-omp",
      model: "opencode-go/deepseek-v4.1-flash",
      reasoningLevel: "low",
    },
  );

  phase("Review");
  const REPORT_ONLY_POLICY =
    "Review the reports below only. Do not open, read, or search any files in the repository, and do not run " +
    "any commands — judge strictly from the implementation summary and test results text you were given.";
  const [correctnessReview, archSecReview] = await parallel([
    () =>
      agent(
        `Independent correctness/testing/regression review. Do not fix anything, only report findings.\n\n` +
          `Objective: ${spec.objective}\nAcceptance criteria:\n${spec.acceptance}\n\n` +
          `Implementation summary:\n${impl}\n\nTest results:\n${tests}\n\n` +
          `Pay special attention to: existing draft text preservation/merge, no automatic send, cancel-with-Esc ` +
          `behavior, and cleanup of temporary audio on success/cancel/failure/thread-switch/unmount.\n\n` +
          `${REPORT_ONLY_POLICY}`,
        {
          label: "review-correctness",
          phase: "Review",
          provider: "codex",
          model: "gpt-5.6-terra",
          reasoningLevel: "low",
          schema: FINDINGS_SCHEMA,
        },
      ),
    () =>
      agent(
        `Independent architecture/security/design review. Do not fix anything, only report findings.\n\n` +
          `Objective: ${spec.objective}\nAcceptance criteria:\n${spec.acceptance}\n\n` +
          `Implementation summary:\n${impl}\n\nTest results:\n${tests}\n\n` +
          `Security focus for this phase: renderer must never call Voicebox directly or see its executable path/` +
          `endpoint, all voice calls go through the existing backend/RPC boundary, microphone permission handling ` +
          `is correct and denial is handled gracefully, no persistent accumulation of captured audio, no new ` +
          `HTTP client or runtime manager was introduced.\n${REPORT_ONLY_POLICY}`,
        {
          label: "review-architecture-security",
          phase: "Review",
          provider: "claude-code",
          model: "claude-sonnet-5",
          reasoningLevel: "low",
          schema: FINDINGS_SCHEMA,
        },
      ),
  ]);

  let findings = []
    .concat(correctnessReview ? correctnessReview.findings : [])
    .concat(archSecReview ? archSecReview.findings : [])
    .filter((f) => f.severity === "critical" || f.severity === "high");

  let fix = "No critical/high findings; no fix pass needed.";
  let rereviewOutcome = findings.length ? "PENDING" : "NOT_NEEDED";
  let correctnessRecheck;
  let archSecRecheck;
  let retryCount = 0;

  while (findings.length && rereviewOutcome === "PENDING") {
    phase("Fix");
    fix = await agent(
      `Address only these verified critical/high findings from independent review. Do not do unrelated cleanup.\n\n` +
        JSON.stringify(findings, null, 2) +
        `\n\nImplementation summary for context:\n${impl}`,
      {
        label: retryCount === 0 ? "task-fix" : `task-fix-retry-${retryCount}`,
        phase: "Fix",
        provider: "acp-omp",
        model: "opencode-go/deepseek-v4.1-flash",
        reasoningLevel: "low",
        schema: FIX_REPORT_SCHEMA,
      },
    );

    phase("Re-review");
    const RECHECK_POLICY =
      "You are a report-only re-reviewer for a fix pass. Do not open, read, or search any files in the " +
      "repository, and do not run any commands — judge strictly from the compact evidence below. You do " +
      "not have and must not assume access to any worker's conversation history. Judge only whether the " +
      "findings below were actually resolved by the fix, and whether the fix itself introduces a new " +
      "critical/high issue.";
    [correctnessRecheck, archSecRecheck] = await parallel([
      () =>
        agent(
          `${RECHECK_POLICY}\n\n` +
            `ORIGINAL FINDINGS TO VERIFY RESOLVED:\n${JSON.stringify(findings, null, 2)}\n\n` +
            `FIX_REPORT:\n${JSON.stringify(fix, null, 2)}\n\n` +
            `Return ONLY a re-check: decision (PASS if every listed finding is resolved and the fix adds no ` +
            `new critical/high issue, FIX_REQUIRED otherwise, BLOCKED if you cannot judge from this ` +
            `evidence), remaining_findings (array, empty if none).`,
          {
            label: retryCount === 0 ? "review-recheck" : `review-recheck-retry-${retryCount}`,
            phase: "Re-review",
            provider: "codex",
            model: "gpt-5.6-terra",
            reasoningLevel: "low",
            schema: RECHECK_SCHEMA,
          },
        ),
      () =>
        agent(
          `${RECHECK_POLICY}\n\n` +
            `ORIGINAL FINDINGS TO VERIFY RESOLVED:\n${JSON.stringify(findings, null, 2)}\n\n` +
            `FIX_REPORT:\n${JSON.stringify(fix, null, 2)}\n\n` +
            `Return ONLY a re-check: decision (PASS if every listed finding is resolved and the fix adds no ` +
            `new critical/high issue, FIX_REQUIRED otherwise, BLOCKED if you cannot judge from this ` +
            `evidence), remaining_findings (array, empty if none).`,
          {
            label: retryCount === 0 ? "architect-recheck" : `architect-recheck-retry-${retryCount}`,
            phase: "Re-review",
            provider: "claude-code",
            model: "claude-sonnet-5",
            reasoningLevel: "low",
            schema: RECHECK_SCHEMA,
          },
        ),
    ]);

    if (correctnessRecheck.decision === "BLOCKED" || archSecRecheck.decision === "BLOCKED") {
      rereviewOutcome = "BLOCKED";
      break;
    }
    if (correctnessRecheck.decision === "PASS" && archSecRecheck.decision === "PASS") {
      rereviewOutcome = "PASS";
      break;
    }

    findings = []
      .concat(correctnessRecheck.remaining_findings || [])
      .concat(archSecRecheck.remaining_findings || [])
      .filter((f) => f.severity === "critical" || f.severity === "high");

    retryCount += 1;
    if (retryCount > MAX_FIX_RETRIES) {
      rereviewOutcome = findings.length ? "BLOCKED_RETRY_LIMIT" : "PASS";
      break;
    }
  }

  log(`Phase ${spec.id} fix/re-review outcome: ${rereviewOutcome} after ${retryCount} retry/retries.`);

  phase("Validate");
  const validation = await agent(
    `Final validation for phase ${spec.id}.\n\n` +
      `Acceptance criteria:\n${spec.acceptance}\n\n` +
      `Implementation:\n${impl}\n\nTests:\n${tests}\n\nFix pass:\n${JSON.stringify(fix, null, 2)}\n\n` +
      `Fix/re-review outcome: ${rereviewOutcome} (retries used: ${retryCount}). Re-review reports:\n` +
      `${JSON.stringify({ correctnessRecheck, archSecRecheck }, null, 2)}\n\n` +
      `Based only on the reports above, judge each acceptance-gate line as PASS/FAIL/NOT-APPLICABLE with a ` +
      `one-line reason for each, and list the files the reports say changed. If rereviewOutcome is BLOCKED ` +
      `or BLOCKED_RETRY_LIMIT, the phase must not be judged PASS overall. This is a report review only — ` +
      `do not open, search, or run anything in the repository.`,
    {
      label: "plan-final-validation",
      phase: "Validate",
      provider: "claude-code",
      model: "claude-sonnet-5",
      reasoningLevel: "low",
    },
  );

  return {
    id: spec.id,
    impl,
    tests,
    correctnessReview,
    archSecReview,
    fix,
    rereviewOutcome,
    retryCount,
    correctnessRecheck,
    archSecRecheck,
    validation,
  };
}

const V2 = {
  id: "V2",
  objective:
    "Add microphone dictation (speech-to-text) to Arc's existing thread composer: record -> stop -> transcribe " +
    "-> insert transcript into the existing draft. This is dictation only, not continuous Voice Mode.",
  scope:
    "- Composer mic button: idle -> recording -> transcribing state machine\n" +
    "- click mic starts recording; click again stops and transcribes; Esc cancels\n" +
    "- capture audio in the renderer, send it to the backend over the existing RPC boundary, backend calls " +
    "the V1 ArcVoiceRuntimeService.transcribe path (start runtime if needed, POST /transcribe), return text\n" +
    "- insert the transcript into the existing draft (merge with existing text, e.g. append/insert at cursor, " +
    "never replace/erase unless the user had actually selected text through normal composer editing)\n" +
    "- transcript remains editable after insertion; user must click send themselves — no automatic submit\n" +
    "- handle: microphone permission denial, recording error, runtime unavailable, transcription error, thread " +
    "switch or composer unmount mid-recording/mid-transcription\n" +
    "- delete/clean up temporary captured audio after successful transcription, cancellation, or failure\n" +
    "EXCLUDED from this phase: streaming/partial transcription, TTS/voice playback, Voice Mode, Voice Gallery, " +
    "per-agent voices, Automations voice, barge-in, continuous listening, any change to voice runtime process " +
    "lifecycle beyond calling the existing service.",
  acceptance:
    "- recording works (click mic starts capture)\n" +
    "- cancel works (Esc stops and discards without transcribing or inserting)\n" +
    "- transcription works (stop triggers transcribe call and returns text)\n" +
    "- existing draft text is preserved when transcript is inserted (merge, not replace)\n" +
    "- transcript remains editable after insertion\n" +
    "- no automatic send ever occurs after transcription\n" +
    "- microphone permission denial is handled with a visible, non-crashing state\n" +
    "- voice runtime failure/unavailability is handled without losing the draft\n" +
    "- transcription failure is handled without losing the draft or existing text\n" +
    "- temporary audio is cleaned up after success, cancel, or failure (no accumulation)\n" +
    "- existing normal composer send/edit behavior is not regressed",
  tests:
    "start recording; stop recording; cancel with Esc; successful transcription; existing draft preservation " +
    "(non-empty draft + dictated text merges correctly); empty draft; microphone permission denial; recording " +
    "error; voice runtime unavailable; transcription error; temporary audio cleanup after each outcome; no " +
    "automatic send after transcription; repeated dictation in the same composer session; thread switch or " +
    "composer unmount during recording/transcribing does not leak state or leftover audio.",
};

log("Running Arc Voice phase V2 (STT dictation in thread composer) — V0/V1 already PASS, V3+ out of scope.");
const v2Result = await runPhase(V2);
return v2Result;
