export const meta = {
  name: "arc-voice-v0-remediation",
  description: "Arc Voice V0 remediation: fix acceptance-gate-6 violation with mocked-only process tests, report-only review",
  phases: [{ title: "Task" }, { title: "Review" }],
};

// Roles resolved live via resolve_mission_role on 2026-09-23 — see .bb/workflows/arc-voice.js header.
// TASK -> acp-omp / opencode-go/deepseek-v4.1-flash (reasoning low)
// REVIEW -> codex / gpt-5.6-terra (reasoning low)

const V0_ACCEPTANCE_CRITERIA =
  "- Runtime-manager code exists with launch/health-wait/transcribe/speak/stop functions behind an injectable " +
  "process+HTTP seam\n" +
  "- Loopback-only binding is enforced in code (not just documented)\n" +
  "- Orphan-process guarding exists and is covered by a test using a fake process\n" +
  "- Model directory redirection is covered by a test\n" +
  "- Backend-selection logic is not hard-coded to macOS/MLX\n" +
  "- No real process was spawned and the Arc app was not run during implementation or testing " +
  "(gate 6 — HARD, non-waivable: live_process_spawned must be NO)";

const TASK_REPORT_SCHEMA = {
  type: "object",
  required: [
    "status",
    "files_changed",
    "tests",
    "gate_results",
    "live_process_spawned",
    "residual_processes",
    "remaining_findings",
  ],
  properties: {
    status: { enum: ["PASS", "BLOCKED", "FAIL"] },
    files_changed: { type: "array", items: { type: "string" } },
    tests: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "result"],
        properties: { name: { type: "string" }, result: { enum: ["pass", "fail"] } },
      },
    },
    gate_results: {
      type: "array",
      items: {
        type: "object",
        required: ["criterion", "result"],
        properties: { criterion: { type: "string" }, result: { enum: ["PASS", "FAIL", "NOT-APPLICABLE"] } },
      },
    },
    live_process_spawned: { enum: ["YES", "NO"] },
    residual_processes: { enum: ["YES", "NO"] },
    remaining_findings: { type: "array", items: { type: "string" } },
  },
};

phase("Task");
const remediation = await agent(
  "V0 remediation pass for the Arc managed-voice runtime-manager. V0 was marked FAILED because acceptance " +
    "gate 6 was violated: the previous fix pass spawned a real OS child process via a throwaway script " +
    "while addressing review findings. That gate is NOT waived and must not be reinterpreted.\n\n" +
    "HARD RULE (non-negotiable, applies to this entire pass):\n" +
    "No real Voicebox process, child process, Arc process, server, or external runtime may be started " +
    "during this remediation. Do not call spawn, exec, execFile, fork, or child_process, and do not run " +
    "the Voicebox binary, against a real OS process — not in implementation code paths you exercise, not " +
    "in a throwaway/scratch script, not manually. Replace process execution during tests with " +
    "mocks/fakes/stubs only. If verifying something requires starting a real process, do NOT do it — " +
    "return status BLOCKED and describe exactly what you could not verify without violating the rule. " +
    "A worker may never reinterpret a phase safety constraint.\n\n" +
    "Terrain-first: check freshness, use .terrain/agent/context.md and knowledge/ before grepping the repo, " +
    "use CodeGraph for callers/dependencies/impact, use grep-pack/read-pack-file for exact targeted source " +
    "lines. Do not do a recursive repo scan, do not load the full Repomix pack.\n\n" +
    "Scope: inspect and, only where an actual defect exists, fix packages/arc-domains/src/arc-voice/* and " +
    "its tests under packages/arc-domains/test/arc-voice-*.test.ts. Preserve the current implementation " +
    "otherwise — do not refactor or rewrite what already works. This is a remediation pass, not a rewrite.\n\n" +
    "Verify (via mocked/fake process+HTTP adapters only, no real OS process):\n" +
    "- command construction (buildVoiceboxLaunchArgs)\n" +
    "- environment construction (buildVoiceboxEnvironment)\n" +
    "- executable discovery / paths\n" +
    "- backend selection\n" +
    "- health state transitions (waitForArcVoiceReady, recheckHealth)\n" +
    "- restartPolicy behavior\n" +
    "- onRuntimeExit callback\n" +
    "- recheckHealth()\n" +
    "- HTTP client request/response contracts (listProfiles/transcribe/speak)\n" +
    "- process cleanup / orphan-guard logic\n\n" +
    "All process lifecycle tests must use mocked/fake process adapters (the existing ArcVoiceProcessSpawner " +
    "/ ArcVoiceProcess seam) — never a real node:child_process spawn.\n\n" +
    "Run: pnpm exec turbo run test --filter=@bb/arc-domains -- --run arc-voice, and " +
    "pnpm exec turbo run typecheck --filter=@bb/arc-domains, to produce real evidence, not replayed logs.\n\n" +
    "Return ONLY a V0_REMEDIATION_REPORT with these exact fields: status (PASS|BLOCKED|FAIL), " +
    "files_changed (array of paths), tests (array of {name, result}), gate_results (array of " +
    "{criterion, result} — one entry per V0 acceptance criterion below, including gate 6 by name), " +
    "live_process_spawned (YES|NO — must be NO), residual_processes (YES|NO — must be NO), " +
    "remaining_findings (array of strings, empty if none).\n\n" +
    `V0 acceptance criteria:\n${V0_ACCEPTANCE_CRITERIA}`,
  {
    label: "task-v0-remediation",
    phase: "Task",
    provider: "acp-omp",
    model: "opencode-go/deepseek-v4.1-flash",
    reasoningLevel: "low",
    schema: TASK_REPORT_SCHEMA,
  },
);

phase("Review");
const REVIEW_REPORT_SCHEMA = {
  type: "object",
  required: ["decision", "findings", "missing_evidence"],
  properties: {
    decision: { enum: ["PASS", "FIX_REQUIRED", "BLOCKED"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "issue"],
        properties: {
          severity: { enum: ["critical", "high", "medium", "low"] },
          issue: { type: "string" },
          required_fix: { type: "string" },
        },
      },
    },
    missing_evidence: { type: "array", items: { type: "string" } },
  },
};
const review = await agent(
  "Review this V0 remediation report against the V0 acceptance criteria only. You do NOT have and must " +
    "not assume access to the worker's conversation, tool calls, or file contents beyond what's quoted " +
    "below — judge strictly from the report text.\n\n" +
    "Gate 6 (no real process spawned) is HARD and non-waivable: decision must be FIX_REQUIRED if " +
    "live_process_spawned is not exactly \"NO\", if residual_processes is not exactly \"NO\", or if any " +
    "gate_results entry for gate 6 is not PASS. Do not accept a status of PASS from the worker at face " +
    "value if the report's own fields contradict it (e.g. status PASS but live_process_spawned YES) — flag " +
    "that as critical and require FIX_REQUIRED. If the worker returned BLOCKED, decision is BLOCKED " +
    "(escalate, do not attempt to force a fix). Also check every other V0 acceptance criterion is covered.\n\n" +
    "Do not open, read, or search any files in the repository, and do not run any commands. If you " +
    "genuinely need more evidence than the report gives, list it in missing_evidence instead of guessing.\n\n" +
    `V0 acceptance criteria:\n${V0_ACCEPTANCE_CRITERIA}\n\n` +
    `V0_REMEDIATION_REPORT:\n${JSON.stringify(remediation, null, 2)}`,
  {
    label: "review-v0-remediation",
    phase: "Review",
    provider: "codex",
    model: "gpt-5.6-terra",
    reasoningLevel: "low",
    schema: REVIEW_REPORT_SCHEMA,
  },
);

return { remediation, review };
