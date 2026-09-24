export const meta = {
  name: "arc-voice",
  description: "Arc managed-voice integration, phase by phase (V0 first)",
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

// Mission Control Role Router is the source of truth for model assignment. Workflows requires
// literal {provider, model, reasoningLevel} tuples in agent() calls (no runtime role lookup inside
// the QuickJS script), so each role below was resolved via resolve_mission_role OUTSIDE this script
// and the exact returned tuple is inlined at each call site, tagged with a "role:" comment. Re-resolve
// and re-inline before reusing this file for a later phase if the Router mapping may have changed.
//
// Resolved 2026-09-23 (all four roles resolve live now, no manual overrides):
//   PLAN      -> claude-code / claude-sonnet-5               reasoning low   (planning/context scoping, no edits)
//   TASK      -> acp-omp / opencode-go/deepseek-v4.1-flash    reasoning low   (only code-writing role)
//   REVIEW    -> codex / gpt-5.6-terra                        reasoning low   (report review only, no edits)
//   ARCHITECT -> claude-code / claude-sonnet-5                reasoning low   (architecture/security review, no edits)

const TERRAIN_POLICY =
  "Terrain-first: check freshness, use .terrain/agent/context.md and knowledge/ before grepping the repo, " +
  "use CodeGraph for callers/dependencies/impact, use grep-pack/read-pack-file for exact targeted source lines. " +
  "Do not do a recursive repo scan, do not load the full Repomix pack, do not repeat identical searches.";

// A reusable phase pipeline: PLAN (Terrain scope) -> TASK implement -> TASK test -> parallel
// independent review (REVIEW report-review, ARCHITECT architecture/security) -> if findings exist:
// TASK fix pass on verified findings -> parallel RE-REVIEW of specifically those original findings
// (report-only, compact evidence only — never a worker's conversation history) -> repeat
// Fix -> Re-review up to MAX_FIX_RETRIES if re-review still returns FIX_REQUIRED -> PLAN final
// validation only runs once re-review is conclusively PASS or the retry limit is hit (BLOCKED).
// V1..V8 can reuse this by adding a new PHASE spec below and calling runPhase(spec). Only TASK
// (DeepSeek) ever writes code; PLAN/ARCHITECT/REVIEW are report-only and never touch the repo or
// run commands.
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
  // role: PLAN (overridden to claude-code / claude-sonnet-5, reasoning medium — see header note)
  const scope = await agent(
    `${TERRAIN_POLICY}\n\n` +
      `Phase ${spec.id} of the Arc managed-voice plan (docs/ARC_AGENT_MANAGED_VOICE_INTEGRATION_PLAN-2.md).\n` +
      `Objective: ${spec.objective}\n\n` +
      `Find and return a COMPACT context packet (not full file dumps) covering:\n` +
      `- exact files/modules for: Arc runtime primitives, process spawning/lifecycle, shutdown cleanup, ` +
      `RPC boundaries, userData/runtime storage helpers, diagnostics patterns\n` +
      `- any existing managed-runtime pattern (download/stage/verify/activate/health/repair/rollback) to reuse\n` +
      `- relevant interfaces/types already in the codebase\n` +
      `- anything that blocks or changes the plan below\n` +
      `This is planning only — do not write or edit any code.`,
    // role: PLAN (claude-code / claude-sonnet-5, reasoning low)
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
      `Terrain findings (use this instead of re-scanning the repo):\n${scope}\n\n` +
      `${TERRAIN_POLICY}\n` +
      `Implement the smallest safe version. Do not touch composer UI, Settings, Automations, or agent/account ` +
      `routing in this phase. Do NOT spawn, launch, or start the real Voicebox process or any other external ` +
      `process, and do NOT start/run the Arc app itself — this workspace is the app currently being edited ` +
      `through, so no live process execution in this phase. Write the runtime-manager code (launch/health/` +
      `transcribe/speak/stop, loopback binding, model-dir redirection, backend-selectable abstraction) behind ` +
      `a clear seam so it can be exercised with a fake/mock process and a fake/mock HTTP client in tests. If a ` +
      `step is infeasible without a live process, say so explicitly and stub it rather than guessing.`,
    // role: TASK (acp-omp / opencode-go/deepseek-v4.1-flash, reasoning low)
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
      `Tests must use a fake/mock process and fake/mock HTTP layer — do not spawn a real Voicebox process or ` +
      `start the real Arc app while testing.\n` +
      `Report pass/fail per test and any typecheck/build output.`,
    // role: TASK (acp-omp / opencode-go/deepseek-v4.1-flash, reasoning low)
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
          `${REPORT_ONLY_POLICY}`,
        // role: REVIEW (codex / gpt-5.6-terra, reasoning low)
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
          `Security focus for this plan: loopback-only binding, no LAN exposure, no arbitrary renderer access, ` +
          `no arbitrary endpoint supplied by a model, orphan-process prevention, Arc-owned model/runtime storage.\n` +
          `${REPORT_ONLY_POLICY}`,
        // role: ARCHITECT (claude-code / claude-sonnet-5, reasoning low)
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
      // role: TASK (acp-omp / opencode-go/deepseek-v4.1-flash, reasoning low)
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
          // role: REVIEW (codex / gpt-5.6-terra, reasoning low)
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
          // role: ARCHITECT (claude-code / claude-sonnet-5, reasoning low)
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
    // role: PLAN (claude-code / claude-sonnet-5, reasoning low) — closes the phase-plan loop
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

const V0 = {
  id: "V0",
  objective:
    "Write and unit-test the runtime-manager code that will let Arc safely launch, use, and cleanly stop a " +
    "local Voicebox process — code + mocked tests only in this run, no live process execution. Integration " +
    "spike design, not a live spike.",
  scope:
    "- Runtime-manager module: launch Voicebox as an Arc-controlled child process, bound to loopback only\n" +
    "- Readiness-wait logic driven by an injectable health-check dependency\n" +
    "- Client methods for profile listing, /transcribe, /speak against an injectable HTTP client\n" +
    "- Clean stop/shutdown path with orphan-process guarding (e.g. tracked PID, kill-on-exit)\n" +
    "- Model-storage path redirected under an Arc-owned data directory (pure path/config logic)\n" +
    "- Keep the runtime abstraction backend-selectable (MLX/CUDA/XPU/DirectML/ROCm/CPU), not macOS/MLX-only\n" +
    "- Do NOT actually spawn Voicebox, start any real server, or run the Arc app in this phase — this workspace " +
    "is the app currently being edited through\n" +
    "EXCLUDED from this phase: composer microphone UI, Voice Settings, Automation integration, voice cloning UI, " +
    "full voice mode, any agent/account routing change, live performance measurements (defer to a later, " +
    "explicitly-approved live run).",
  acceptance:
    "- Runtime-manager code exists with launch/health-wait/transcribe/speak/stop functions behind an injectable " +
    "process+HTTP seam\n" +
    "- Loopback-only binding is enforced in code (not just documented)\n" +
    "- Orphan-process guarding exists and is covered by a test using a fake process\n" +
    "- Model directory redirection is covered by a test\n" +
    "- Backend-selection logic is not hard-coded to macOS/MLX\n" +
    "- No real process was spawned and the Arc app was not run during implementation or testing",
  tests:
    "Unit tests against fakes/mocks only (no real Voicebox process, no real Arc app run): launch calls the " +
    "injected process spawner with loopback-only args, health-wait resolves/times out correctly, transcribe/" +
    "speak call the injected HTTP client with expected requests, stop terminates the tracked process and " +
    "clears tracking (orphan guard), model-dir redirection resolves to the Arc-owned path, backend-selection " +
    "mapping covers all listed platforms plus a CPU fallback.",
};

log(
  "Running Arc Voice phase V0 (code + mocked tests only, no live process execution) — V1..V8 stay out of scope for this run.",
);
const v0Result = await runPhase(V0);
return v0Result;
