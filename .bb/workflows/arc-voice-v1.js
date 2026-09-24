export const meta = {
  name: "arc-voice-v1",
  description: "Arc Voice V1 managed runtime: live contract spike gate, then implementation, ARCHITECT review, REVIEW, fix",
  phases: [{ title: "Spike" }, { title: "Implement" }, { title: "Architect" }, { title: "Review" }, { title: "Fix" }, { title: "Validate" }],
};

// Roles resolved live via resolve_mission_role on 2026-09-23 (unchanged since V0/remediation):
//   PLAN      -> claude-code / claude-sonnet-5               reasoning low
//   TASK      -> acp-omp / opencode-go/deepseek-v4.1-flash    reasoning low  (only code-writing role)
//   REVIEW    -> codex / gpt-5.6-terra                        reasoning low
//   ARCHITECT -> claude-code / claude-sonnet-5                reasoning low

const TERRAIN_POLICY =
  "Terrain-first: check freshness, use .terrain/agent/context.md and knowledge/ before grepping the repo, " +
  "use CodeGraph for callers/dependencies/impact, use grep-pack/read-pack-file for exact targeted source lines. " +
  "Do not do a recursive repo scan, do not load the full Repomix pack, do not repeat identical searches.";

// Compact carry-over from V0 — not the full Voice plan.
const V0_PHASE_STATE = `
phase: V0
result: PASS
interfaces_created:
- packages/arc-domains/src/arc-voice/{types,backend,binding,paths,process,health,client,runtime-manager,index}.ts
- packages/arc-domains/src/index.ts: + export * from "./arc-voice/index.js"
contracts_for_next_phase:
- Voicebox CLI (SOURCE-VERIFIED ONLY, not runtime-verified): --host/--port/--data-dir/--parent-pid/--version,
  no \`serve\` subcommand, no \`--backend\` flag
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
`.trim();

phase("Spike");
const SPIKE_REPORT_SCHEMA = {
  type: "object",
  required: [
    "status",
    "contract_status",
    "executable_verified",
    "endpoints_checked",
    "mismatches",
    "live_process_used",
    "residual_processes",
    "notes",
  ],
  properties: {
    status: { enum: ["PASS", "BLOCKED", "FAIL"] },
    contract_status: { enum: ["MATCH", "MISMATCH", "NOT_VERIFIED"] },
    executable_verified: { enum: ["YES", "NO"] },
    endpoints_checked: { type: "array", items: { type: "string" } },
    mismatches: { type: "array", items: { type: "string" } },
    live_process_used: { enum: ["YES", "NO"] },
    residual_processes: { enum: ["YES", "NO"] },
    notes: { type: "string" },
  },
};
const spike = await agent(
  `${TERRAIN_POLICY}\n\n` +
    "V1 controlled live-verification spike for the Arc managed-voice runtime. This is the first phase " +
    "where starting a real Voicebox process is allowed — everywhere else in this project it is forbidden.\n\n" +
    `Previous-phase contract (V0 PHASE_STATE — treat as the assumptions to verify, not fact):\n${V0_PHASE_STATE}\n\n` +
    "HARD CONTAINMENT RULES for this spike (non-negotiable, do not reinterpret):\n" +
    "- Disposable Voicebox data only, in an isolated temporary directory you create for this spike and can " +
    "delete afterward\n" +
    "- localhost/loopback only, never bind or connect anywhere else\n" +
    "- Do NOT modify any Arc user data directory\n" +
    "- Do NOT touch credentials, secrets, or any EGX/work system\n" +
    "- Do NOT install anything globally (no global pip/npm/brew install, no PATH mutation)\n" +
    "- Do NOT rely on a pre-existing PATH-installed voicebox — obtain/build/run it fully inside your " +
    "disposable temp directory\n" +
    "- If you cannot obtain a real voicebox-server binary without violating one of these rules (e.g. no " +
    "network egress available, no way to build it in isolation), do NOT fake it and do NOT skip the " +
    "constraint — return status BLOCKED and explain exactly what stopped you\n" +
    "- Whatever process you start, you must stop it and confirm zero residual processes before returning\n\n" +
    "ACQUISITION PATH FOR THIS SPIKE (explicit user decision, do not deviate):\n" +
    "The official pinned Voicebox v0.5.0 macOS arm64 application artifact has already been downloaded and " +
    "extracted for you — do NOT download it again. It is staged at " +
    "/tmp/claude-501/arc-voice-spike-input/Voicebox.app (already-extracted app bundle, NOT to be installed " +
    "or launched from that location).\n" +
    "1. Copy ONLY the sidecar binary you need (Voicebox.app/Contents/MacOS/voicebox-server, and its " +
    "siblings voicebox / voicebox-mcp if you need them) from that staged location into your own disposable " +
    "temp directory. Do not copy or touch the rest of the app bundle, and do not modify or delete anything " +
    "under /tmp/claude-501/arc-voice-spike-input/ — that staged copy is not yours to clean up.\n" +
    "2. Do NOT install or launch Voicebox.app itself from either location.\n" +
    "3. Verify the binary's identity where available (e.g. its own --version output) before executing it.\n" +
    "4. Run your copy of the extracted server only bound to 127.0.0.1, with a disposable data directory " +
    "and a disposable port, entirely inside your own disposable temp directory.\n" +
    "5. After verification: terminate the server, verify zero residual process, and remove every " +
    "disposable file/directory you created (your copy of the binary, the temp dir) — but leave the " +
    "originally staged /tmp/claude-501/arc-voice-spike-input/Voicebox.app alone.\n\n" +
    "This acquisition path is for THIS SPIKE ONLY, to obtain a real binary to test against — it is not the " +
    "production design. Do not implement Arc downloading the ~512 MiB GUI bundle at product runtime; that " +
    "is handled separately as a design requirement in the Implement phase.\n\n" +
    "Verify against the real running process:\n" +
    "1. The real executable is literally named voicebox-server (or has a -cuda/-rocm variant) — report what " +
    "you actually found\n" +
    "2. Actual supported CLI arguments: --host, --port, --data-dir, --parent-pid, --version — do they exist, " +
    "do they behave as V0 assumed?\n" +
    "3. GET /health, GET /profiles, POST /transcribe, GET /history/{id}, GET /audio/{id} — verify request/" +
    "response shapes against V0's assumptions. Do NOT perform expensive full speech generation unless " +
    "actually necessary to prove the POST /speak contract works end to end; a minimal/short case is enough.\n\n" +
    "If the real runtime contradicts any V0 assumption: do not silently adapt the code around it. Set " +
    "contract_status to MISMATCH, status to BLOCKED, list every mismatch precisely, and stop — implementation " +
    "must not proceed on a known-wrong contract.\n\n" +
    "Return ONLY a structured spike report: status (PASS only if the spike fully succeeded and the contract " +
    "matches or only differs in ways you've precisely documented as safe to proceed on; BLOCKED if you " +
    "could not safely verify or found a mismatch; FAIL if something else went wrong), contract_status " +
    "(MATCH/MISMATCH/NOT_VERIFIED), executable_verified (YES/NO), endpoints_checked (array of endpoint " +
    "names you actually exercised), mismatches (array, empty if none), live_process_used (YES — this phase " +
    "allows it), residual_processes (YES/NO — must be NO), notes (free text).\n\n" +
    "Your final response must be ONLY the JSON object matching the schema above — no prose, headings, or " +
    "narration before or after it, and no markdown code fences around it. Put every observation (artifact " +
    "size, download progress, verification detail, anything you'd otherwise narrate) into the notes field " +
    "as plain text instead of writing it outside the JSON.",
  {
    label: "task-v1-spike",
    phase: "Spike",
    provider: "acp-omp",
    model: "opencode-go/deepseek-v4.1-flash",
    reasoningLevel: "low",
    schema: SPIKE_REPORT_SCHEMA,
  },
);

if (spike.status !== "PASS" || spike.contract_status === "MISMATCH" || spike.residual_processes === "YES") {
  log("V1 spike did not clear the gate — stopping before implementation. Not silently adapting around it.");
  return {
    id: "V1",
    stoppedAt: "Spike",
    spike,
    reason:
      spike.residual_processes === "YES"
        ? "residual Voicebox process reported after spike"
        : spike.contract_status === "MISMATCH"
          ? "real runtime contradicts V0 assumptions"
          : "spike did not return PASS",
  };
}

phase("Implement");
const TASK_REPORT_SCHEMA = {
  type: "object",
  required: ["status", "files_changed", "diff_summary", "tests", "live_process_used", "residual_processes", "notes"],
  properties: {
    status: { enum: ["PASS", "BLOCKED", "FAIL"] },
    files_changed: { type: "array", items: { type: "string" } },
    diff_summary: { type: "string" },
    tests: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "result"],
        properties: { name: { type: "string" }, result: { enum: ["pass", "fail"] } },
      },
    },
    live_process_used: { enum: ["YES", "NO"] },
    residual_processes: { enum: ["YES", "NO"] },
    notes: { type: "string" },
  },
};
const impl = await agent(
  `${TERRAIN_POLICY}\n\n` +
    `Confirmed live contract from the V1 spike (use this, not V0's assumptions, where they differ):\n` +
    `${JSON.stringify(spike, null, 2)}\n\n` +
    `V0 PHASE_STATE (previous-phase contract):\n${V0_PHASE_STATE}\n\n` +
    "V1 scope — build on packages/arc-domains/src/arc-voice/ (read the approved V1 section of " +
    "docs/ARC_AGENT_MANAGED_VOICE_INTEGRATION_PLAN-2.md for exact requirements, do not load the whole plan " +
    "into your head speculatively, read only the V1-relevant section):\n" +
    "- managed runtime acquisition/location — design requirement (explicit user decision): production Arc " +
    "must NOT download the ~512 MiB Voicebox GUI app bundle at runtime. Instead determine how Arc's " +
    "release/build acquisition pipeline can obtain the pinned upstream macOS artifact, extract only the " +
    "required voicebox-server component, verify it (checksum/version), and package/manage only the " +
    "Arc-required runtime artifacts — not the full upstream GUI bundle. Design/scaffold this at whatever " +
    "level is appropriate for V1 (e.g. an acquisition step/interface consistent with arc-runtime's existing " +
    "download/stage/verify/activate pattern); do not attempt an actual multi-hundred-MB download as part of " +
    "test execution.\n" +
    "- managed executable ownership\n" +
    "- start lifecycle\n" +
    "- stop lifecycle\n" +
    "- health\n" +
    "- restart policy\n" +
    "- crash detection\n" +
    "- cleanup\n" +
    "- parent-process behavior\n" +
    "- data-dir isolation\n" +
    "- runtime status reporting\n" +
    "No composer UI, no STT UI, no TTS UI, no V2 work — implementation and focused tests only.\n\n" +
    "Also fix the deferred V0 defect: ArcVoiceRuntimeManager#awaitClose starts a sleep(timeoutMs) that is " +
    "never cancelled, leaving one pending timer alive per stop() call even when the process closes " +
    "promptly. Make timer cleanup deterministic (cancel the pending timer once close resolves) and add a " +
    "focused regression test proving no timer survives a prompt stop.\n\n" +
    "Process-safety rules for this phase:\n" +
    "- Tests use fakes/mocks by default, as in every prior phase\n" +
    "- Real-process tests are now allowed for runtime-ownership coverage, but must be isolated integration/" +
    "smoke tests, clearly separated from the unit suite, using disposable directories, and must always " +
    "terminate every spawned process and verify no residual child survives\n" +
    "- Never use a live process merely because mocking was inconvenient — mock by default, real process only " +
    "where the test's actual purpose is to prove real process ownership/cleanup\n\n" +
    "Return ONLY a structured report: status, files_changed, diff_summary (compact — file-by-file bullet " +
    "summary of what changed and why, enough for an architecture reviewer who has not seen your session), " +
    "tests (array of {name, result}), live_process_used (YES/NO), residual_processes (YES/NO — must be NO " +
    "if live_process_used is YES), notes.",
  {
    label: "task-v1-implement",
    phase: "Implement",
    provider: "acp-omp",
    model: "opencode-go/deepseek-v4.1-flash",
    reasoningLevel: "low",
    schema: TASK_REPORT_SCHEMA,
  },
);

phase("Architect");
const REPORT_SCHEMA = {
  type: "object",
  required: ["decision", "findings"],
  properties: {
    decision: { enum: ["PASS", "FIX_REQUIRED", "BLOCKED"] },
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
const architectReview = await agent(
  `${TERRAIN_POLICY}\n\n` +
    "Independent architecture/security review of the V1 managed-runtime implementation. Report-only — do " +
    "not edit any code. You may use CodeGraph for impact analysis on the changed files listed below, and " +
    "read the specific changed source files directly if needed, but do not do a repo-wide scan.\n\n" +
    `V1 PHASE_PACKET (previous-phase contract):\n${V0_PHASE_STATE}\n\n` +
    `TASK_REPORT (implementation just completed):\n${JSON.stringify(impl, null, 2)}\n\n` +
    "Review specifically: process ownership, cleanup, restart loops, crash handling, filesystem/data " +
    "isolation, security boundaries (loopback-only, no arbitrary endpoint, no LAN exposure), and " +
    "update/replacement assumptions (does activation assume a layout consistent with arc-runtime's own " +
    "pattern, or does it silently diverge in a way that will bite an update/rollback flow later).",
  {
    label: "architect-v1",
    phase: "Architect",
    provider: "claude-code",
    model: "claude-sonnet-5",
    reasoningLevel: "low",
    schema: REPORT_SCHEMA,
  },
);

phase("Review");
const REPORT_ONLY_POLICY =
  "Review the reports below only. Do not open, read, or search any files in the repository, and do not run " +
  "any commands — judge strictly from the text you were given.";
const review = await agent(
  `Independent correctness/testing/regression review of V1. ${REPORT_ONLY_POLICY}\n\n` +
    `V1 PHASE_PACKET:\n${V0_PHASE_STATE}\n\n` +
    `TASK_REPORT:\n${JSON.stringify(impl, null, 2)}\n\n` +
    `ARCHITECT_REPORT:\n${JSON.stringify(architectReview, null, 2)}\n\n` +
    "Also confirm: the timer-cleanup fix has a named regression test in TASK_REPORT.tests, and " +
    "residual_processes is NO if live_process_used was YES. Treat either of those being wrong as at least " +
    "a high-severity finding.",
  {
    label: "review-v1",
    phase: "Review",
    provider: "codex",
    model: "gpt-5.6-terra",
    reasoningLevel: "low",
    schema: REPORT_SCHEMA,
  },
);

const findings = []
  .concat(architectReview.findings || [])
  .concat(review.findings || [])
  .filter((f) => f.severity === "critical" || f.severity === "high");

let fix = null;
if (architectReview.decision !== "PASS" || review.decision !== "PASS" || findings.length) {
  phase("Fix");
  fix = await agent(
    `${TERRAIN_POLICY}\n\n` +
      "Address only these verified critical/high findings from independent review. Do not do unrelated " +
      "cleanup. Same process-safety rules as the implementation phase apply: mock by default, real-process " +
      "tests only where they specifically prove ownership/cleanup, always terminate and verify zero " +
      "residual processes.\n\n" +
      JSON.stringify(findings, null, 2) +
      `\n\nOriginal implementation report for context:\n${JSON.stringify(impl, null, 2)}`,
    {
      label: "task-v1-fix",
      phase: "Fix",
      provider: "acp-omp",
      model: "opencode-go/deepseek-v4.1-flash",
      reasoningLevel: "low",
      schema: TASK_REPORT_SCHEMA,
    },
  );
}

phase("Validate");
const V1_ACCEPTANCE =
  "- real Voicebox CLI contract verified\n- real health endpoint verified\n- Arc-owned runtime starts " +
  "successfully\n- Arc-owned runtime stops successfully\n- no residual Voicebox process remains\n- crash/" +
  "exit state is detected\n- restart policy behaves correctly\n- data directory is isolated\n- timer " +
  "cleanup issue is resolved\n- focused tests pass\n- architecture review passes\n- no V2 product/UI work added";
const validation = await agent(
  "Final validation for V1, report-only — do not open, search, or run anything in the repository.\n\n" +
    `Acceptance criteria:\n${V1_ACCEPTANCE}\n\n` +
    `Spike report:\n${JSON.stringify(spike, null, 2)}\n\n` +
    `Implementation report:\n${JSON.stringify(impl, null, 2)}\n\n` +
    `Architect report:\n${JSON.stringify(architectReview, null, 2)}\n\n` +
    `Review report:\n${JSON.stringify(review, null, 2)}\n\n` +
    `Fix report (if any):\n${fix ? JSON.stringify(fix, null, 2) : "none needed"}\n\n` +
    "Judge each acceptance-gate line as PASS/FAIL/NOT-APPLICABLE with a one-line reason, based only on the " +
    "reports above. Also state explicitly: residual Voicebox processes YES/NO, unrelated files modified " +
    "YES/NO (infer from files_changed/diff_summary vs. the V1 scope).",
  {
    label: "plan-v1-validation",
    phase: "Validate",
    provider: "claude-code",
    model: "claude-sonnet-5",
    reasoningLevel: "low",
  },
);

return { id: "V1", spike, impl, architectReview, review, fix, validation };
