export const meta = {
  name: "arc-voice-v1-post-fix-rereview",
  description: "V1 post-fix re-review only: ARCHITECT + REVIEW re-check the process-ownership fix, report-only, bounded fix/re-review retry",
  phases: [{ title: "Architect" }, { title: "Review" }, { title: "Fix" }],
};

// Roles resolved live via resolve_mission_role on 2026-09-23 (unchanged from the V1 run):
// ARCHITECT -> claude-code / claude-sonnet-5   reasoning low
// REVIEW    -> codex / gpt-5.6-terra           reasoning low
// TASK      -> acp-omp / opencode-go/deepseek-v4.1-flash   reasoning low

const ORIGINAL_ARCHITECT_FINDINGS = [
  {
    severity: "high",
    file: "packages/arc-domains/src/arc-voice/process.ts",
    summary:
      "Primary process-group kill path (signalGroup, used by kill()) never probes group existence before " +
      "signalling, unlike killResidualTree() which does; a PID that has already exited and been reused as " +
      "another process group's leader can be SIGTERM/SIGKILL'd by mistake.",
  },
  {
    severity: "medium",
    file: "packages/arc-domains/src/arc-voice/runtime-manager.ts",
    summary:
      "stop() calls process_.kill(\"SIGTERM\") unconditionally without first checking process_.hasExited(), " +
      "so on a process that already exited (race between exit and stop()), the group-kill path in process.ts " +
      "can target a reused PID's unrelated group instead of being skipped.",
  },
];

const ORIGINAL_REVIEW_FINDINGS = [
  {
    severity: "high",
    file: "packages/arc-domains/src/arc-voice/process.ts",
    summary:
      "The primary process-group termination path used by kill() signals a process group without first " +
      "proving that the group still exists. If the former child PID is reused as an unrelated process-group " +
      "leader, SIGTERM or SIGKILL can terminate unrelated processes.",
  },
  {
    severity: "medium",
    file: "packages/arc-domains/src/arc-voice/runtime-manager.ts",
    summary:
      "stop() invokes process_.kill(\"SIGTERM\") without first checking hasExited(). In an exit/stop race, " +
      "this can enter the unsafe group-kill path with a reused PID instead of skipping termination.",
  },
];

const FIX_REPORT_SUMMARY =
  "status: PASS. files_changed: packages/arc-domains/src/arc-voice/process.ts, " +
  "packages/arc-domains/test/arc-voice-process.test.ts, " +
  "packages/arc-domains/test/integration/arc-voice-process-ownership.test.ts.\n\n" +
  "Fix: added a groupExists() probe (kill(-pid, 0)) required before any group signal, AND an ownership " +
  "guard on the primary kill() path — kill(signal) now returns false without signalling anything once " +
  "hasExited() is true (child.exitCode/signalCode set), because the existence probe alone cannot prove " +
  "ownership: after the direct child is reaped, its pid can be reused as a *different* group's leader, and " +
  "kill(-pid, 0) would then succeed against that unrelated group. While the child has not exited, the group " +
  "id is definitionally our own child's pid, so group signalling remains safe in that window. " +
  "killResidualTree() keeps its previous probe-then-SIGKILL semantics (needed for post-exit residual " +
  "sweeping) and is unchanged.\n\n" +
  "Tests: new unit suite (mocked child_process + process.kill spy) asserts the exact signal stream for a " +
  "live child, an exited child (no signal at all), and a group already gone. New real-process integration " +
  "suite spawns real node children (no Voicebox artifact required) and proves via pgrep -g / kill(-pgid,0) " +
  "that: (a) once a child exits, kill() no longer signals its former group even if a surviving sibling is " +
  "still in that group, while killResidualTree() still sweeps it; (b) a live child leading a multi-member " +
  "group is still killed as a whole group. Both suites were run against the pre-fix code first and failed " +
  "at the exact ownership assertion, confirming the fix changes real behavior, not just types.\n\n" +
  "All focused suites (process/runtime-manager/runtime-service, 61 tests) passed; full @bb/arc-domains " +
  "vitest run passed except 4 pre-existing, unrelated failures in arc-runtime-claude-discovery.test.ts " +
  "caused by denied network egress in the verifier's own sandbox, not by this change; tsc --noEmit clean.";

const TARGETED_DIFF =
  "packages/arc-domains/src/arc-voice/process.ts (current, post-fix):\n" +
  "```ts\n" +
  "const hasExited = (): boolean =>\n" +
  "  child.exitCode !== null || child.signalCode !== null;\n" +
  "const groupExists = (): boolean => {\n" +
  "  if (child.pid === undefined || !detached) return false;\n" +
  "  try {\n" +
  "    process.kill(-child.pid, 0);\n" +
  "    return true;\n" +
  "  } catch {\n" +
  "    return false;\n" +
  "  }\n" +
  "};\n" +
  "const signalGroup = (signal: NodeJS.Signals): boolean => {\n" +
  "  const pid = child.pid;\n" +
  "  if (pid === undefined || !detached || !groupExists()) return false;\n" +
  "  try {\n" +
  "    return process.kill(-pid, signal);\n" +
  "  } catch {\n" +
  "    return false;\n" +
  "  }\n" +
  "};\n" +
  "return {\n" +
  "  pid: child.pid,\n" +
  "  kill: (signal) => {\n" +
  "    if (hasExited()) return false;\n" +
  "    return signalGroup(signal) ? true : child.kill(signal);\n" +
  "  },\n" +
  "  killResidualTree: () => signalGroup(\"SIGKILL\"),\n" +
  "  hasExited,\n" +
  "  ...\n" +
  "};\n" +
  "```\n\n" +
  "packages/arc-domains/src/arc-voice/runtime-manager.ts stop() (current, unchanged by this fix pass):\n" +
  "```ts\n" +
  "async stop(): Promise<ArcVoiceStopResult> {\n" +
  "  ...\n" +
  "  const graceful = this.#awaitClose(process_, this.#gracefulStopTimeoutMs);\n" +
  "  process_.kill(\"SIGTERM\"); // no hasExited() check here — relies on kill() to be a safe no-op if already exited\n" +
  "  if (await graceful) {\n" +
  "    const residual = process_.killResidualTree();\n" +
  "    ...\n" +
  "  }\n" +
  "  const forced = this.#awaitClose(process_, this.#forceStopTimeoutMs);\n" +
  "  process_.kill(\"SIGKILL\");\n" +
  "  ...\n" +
  "}\n" +
  "```\n\n" +
  "packages/arc-domains/src/arc-voice/runtime-manager.ts #terminate() (current, unchanged, for comparison — " +
  "this one already checked hasExited() before the original fix):\n" +
  "```ts\n" +
  "async #terminate(process_: ArcVoiceProcess): Promise<void> {\n" +
  "  if (process_.hasExited()) {\n" +
  "    process_.killResidualTree();\n" +
  "    return;\n" +
  "  }\n" +
  "  const graceful = this.#awaitClose(process_, this.#gracefulStopTimeoutMs);\n" +
  "  process_.kill(\"SIGTERM\");\n" +
  "  ...\n" +
  "}\n" +
  "```";

const FOCUSED_TEST_RESULTS =
  "Independently re-run by the coordinator (not just self-reported by the fix worker): " +
  "`vitest run arc-voice-process arc-voice-runtime-manager arc-voice-runtime-service` -> 61/61 passed. " +
  "Full `@bb/arc-domains` suite -> 591 passed, 4 failed (pre-existing, unrelated network-egress failures in " +
  "arc-runtime-claude-discovery.test.ts, not touched by this change). `tsc --noEmit` via turbo -> clean. " +
  "`git status` confirms the diff is scoped to packages/arc-domains/src/arc-voice/*, its tests, " +
  "packages/arc-domains/{package.json,vitest.config.ts,vitest.integration.config.ts}, " +
  "apps/desktop/scripts/prepare-arc-voice-runtime.mts, apps/desktop/package.json, " +
  "packages/arc-domains/src/index.ts — no unrelated files modified. No residual voicebox-server processes.";

const ARCHITECT_REVIEW_SCHEMA = {
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

const REVIEW_RECHECK_SCHEMA = {
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

const REPORT_ONLY_POLICY =
  "You are a report-only re-reviewer. Do not open, read, or search any files in the repository, and do not " +
  "run any commands — judge strictly from the compact evidence given below. You do not have and must not " +
  "assume access to any worker's conversation history.";

const MAX_RETRIES = 2;

async function architectRecheck(fixReportText, priorArchitectFindings) {
  phase("Architect");
  return agent(
    `${REPORT_ONLY_POLICY}\n\n` +
      "This is a post-fix re-review for Arc Voice V1. A fix pass claims to have resolved the process " +
      "ownership / PID-reuse / process-group-safety findings your earlier V1 architecture review raised. " +
      "Answer only: (1) were the original findings correctly resolved? (2) are there any remaining " +
      "architecture/security blockers for V1?\n\n" +
      `ORIGINAL ARCHITECT FINDINGS:\n${JSON.stringify(priorArchitectFindings, null, 2)}\n\n` +
      `FIX_REPORT:\n${fixReportText}\n\n` +
      `TARGETED DIFF (process.ts / runtime-manager.ts):\n${TARGETED_DIFF}\n\n` +
      `FOCUSED TEST RESULTS:\n${FOCUSED_TEST_RESULTS}\n\n` +
      "Return ONLY an ARCHITECT_REVIEW: decision (PASS if every original finding is resolved and no new " +
      "blocker exists, FIX_REQUIRED if a finding is not actually resolved or a new blocker is introduced by " +
      "the fix, BLOCKED if you cannot judge from this evidence), remaining_findings (array, empty if none).",
    {
      label: "architect-v1-post-fix-recheck",
      phase: "Architect",
      provider: "claude-code",
      model: "claude-sonnet-5",
      reasoningLevel: "low",
      schema: ARCHITECT_REVIEW_SCHEMA,
    },
  );
}

async function reviewRecheck(fixReportText, priorReviewFindings, architectReview) {
  phase("Review");
  return agent(
    `${REPORT_ONLY_POLICY}\n\n` +
      "This is a post-fix re-review for Arc Voice V1. A fix pass claims to have resolved the findings your " +
      "earlier V1 review raised. Judge only whether the original findings are resolved and whether any " +
      "blocker remains, using the compact evidence below plus the architect's own post-fix verdict.\n\n" +
      `ORIGINAL REVIEW FINDINGS:\n${JSON.stringify(priorReviewFindings, null, 2)}\n\n` +
      `FIX_REPORT:\n${fixReportText}\n\n` +
      `FOCUSED TEST SUMMARY:\n${FOCUSED_TEST_RESULTS}\n\n` +
      `ARCHITECT_REVIEW (post-fix):\n${JSON.stringify(architectReview, null, 2)}\n\n` +
      "Return ONLY a REVIEW_RECHECK: decision (PASS/FIX_REQUIRED/BLOCKED), remaining_findings (array, empty " +
      "if none).",
    {
      label: "review-v1-post-fix-recheck",
      phase: "Review",
      provider: "codex",
      model: "gpt-5.6-terra",
      reasoningLevel: "low",
      schema: REVIEW_RECHECK_SCHEMA,
    },
  );
}

let fixReportText = FIX_REPORT_SUMMARY;
let priorArchitectFindings = ORIGINAL_ARCHITECT_FINDINGS;
let priorReviewFindings = ORIGINAL_REVIEW_FINDINGS;
let architectReview;
let reviewRecheckResult;
let attempt = 0;
let outcome = "PENDING";

while (attempt <= MAX_RETRIES) {
  architectReview = await architectRecheck(fixReportText, priorArchitectFindings);
  reviewRecheckResult = await reviewRecheck(fixReportText, priorReviewFindings, architectReview);

  const architectBlocked = architectReview.decision === "BLOCKED";
  const reviewBlocked = reviewRecheckResult.decision === "BLOCKED";
  if (architectBlocked || reviewBlocked) {
    outcome = "BLOCKED";
    break;
  }

  const architectPass = architectReview.decision === "PASS";
  const reviewPass = reviewRecheckResult.decision === "PASS";
  if (architectPass && reviewPass) {
    outcome = "PASS";
    break;
  }

  attempt += 1;
  if (attempt > MAX_RETRIES) {
    outcome = "BLOCKED_RETRY_LIMIT";
    break;
  }

  phase("Fix");
  const findings = []
    .concat(architectReview.remaining_findings || [])
    .concat(reviewRecheckResult.remaining_findings || []);
  const fix = await agent(
    "Address only these verified remaining findings from the V1 post-fix re-review. Do not do unrelated " +
      "cleanup, do not touch anything outside packages/arc-domains/src/arc-voice/* and its tests unless a " +
      "finding names another file explicitly.\n\n" +
      JSON.stringify(findings, null, 2) +
      "\n\nPrior fix context for reference:\n" +
      fixReportText,
    {
      label: `task-v1-fix-retry-${attempt}`,
      phase: "Fix",
      provider: "acp-omp",
      model: "opencode-go/deepseek-v4.1-flash",
      reasoningLevel: "low",
    },
  );
  fixReportText = typeof fix === "string" ? fix : JSON.stringify(fix, null, 2);
  priorArchitectFindings = architectReview.remaining_findings || [];
  priorReviewFindings = reviewRecheckResult.remaining_findings || [];
}

log(`V1 post-fix re-review outcome: ${outcome} after ${attempt} fix/re-review retr${attempt === 1 ? "y" : "ies"}.`);

return {
  id: "V1-post-fix-rereview",
  outcome,
  attempts: attempt,
  architectReview,
  reviewRecheck: reviewRecheckResult,
  v1: outcome === "PASS" ? "PASS" : outcome === "BLOCKED" || outcome === "BLOCKED_RETRY_LIMIT" ? "BLOCKED" : "FAIL",
  readyForV2: outcome === "PASS" ? "YES" : "NO",
};
