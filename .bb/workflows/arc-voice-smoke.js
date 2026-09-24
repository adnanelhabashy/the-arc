export const meta = {
  name: "arc-voice-smoke",
  description: "Orchestration smoke test for the Arc Voice workflow (PLAN -> TASK -> REVIEW, no source changes)",
  phases: [{ title: "Plan" }, { title: "Task" }, { title: "Review" }],
};

// Roles resolved live via resolve_mission_role on 2026-09-23 — see .bb/workflows/arc-voice.js header
// for the full rationale. This script only proves the pipe works; it does not touch source.

phase("Plan");
const plan = await agent(
  "This is a workflow orchestration smoke test, not real planning. Produce a tiny test plan: state that " +
    "the TASK worker below should run a harmless, read-only repository inspection (pwd + targeted git " +
    "status) and nothing else, and that REVIEW should only check the TASK_REPORT is well-formed and " +
    "confirms no files were modified. Keep the response under 100 words.",
  // role: PLAN (claude-code / claude-sonnet-5, reasoning low)
  {
    label: "smoke-plan",
    phase: "Plan",
    provider: "claude-code",
    model: "claude-sonnet-5",
    reasoningLevel: "low",
  },
);

phase("Task");
const TASK_REPORT_SCHEMA = {
  type: "object",
  required: ["status", "pwd_output", "git_status_output", "files_modified"],
  properties: {
    status: { enum: ["PASS", "BLOCKED", "FAIL"] },
    pwd_output: { type: "string" },
    git_status_output: { type: "string" },
    files_modified: { type: "boolean" },
  },
};
const taskReport = await agent(
  `Phase packet:\n${plan}\n\n` +
    "Run exactly two read-only commands: `pwd` and `git status --porcelain=v1`. Do not run, write, or edit " +
    "anything else. Do not modify any file. Return status PASS if both commands ran and the working tree " +
    "shows no new changes caused by you, set files_modified to false in that case.",
  // role: TASK (acp-omp / opencode-go/deepseek-v4.1-flash, reasoning low)
  {
    label: "smoke-task",
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
  required: ["decision", "findings"],
  properties: {
    decision: { enum: ["PASS", "FIX_REQUIRED", "BLOCKED"] },
    findings: { type: "array", items: { type: "string" } },
  },
};
const reviewReport = await agent(
  "Review only the TASK_REPORT JSON below. Do not open, read, or search any files, and do not run any " +
    "commands. Judge only whether the report is well-formed (status/pwd_output/git_status_output/" +
    "files_modified all present) and whether files_modified is false. If both hold, decision is PASS.\n\n" +
    `TASK_REPORT:\n${JSON.stringify(taskReport, null, 2)}`,
  // role: REVIEW (codex / gpt-5.6-terra, reasoning low)
  {
    label: "smoke-review",
    phase: "Review",
    provider: "codex",
    model: "gpt-5.6-terra",
    reasoningLevel: "low",
    schema: REVIEW_REPORT_SCHEMA,
  },
);

return { plan, taskReport, reviewReport };
