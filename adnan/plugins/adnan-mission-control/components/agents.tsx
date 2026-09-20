// Agents tab (Phase 10): the three Arc product agents — OMP, Codex, Claude
// Code — reported by ArcAgentManager through the arc-core proxy. Each card
// shows runtime state, version, compatibility, account readiness, and the
// prepare/repair actions the backend declares. This replaces the old thread
// tree, which moved to components/threads.tsx.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type {
  ArcAgentStatus,
  ArcRuntimeRollbackOutcome,
  ArcRuntimeSource,
  ArcRuntimeUpdateOutcome,
} from "@/lib/arc-types";
import { useArcAgents } from "@/lib/data";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Chip, EmptyState } from "@/components/common";
import { cn } from "@/lib/utils";

type ChipTone = "ok" | "warn" | "danger" | "muted";

const CHIP_TONE_TEXT: Record<ChipTone, string> = {
  ok: "text-emerald-400 border-emerald-400/40",
  warn: "text-amber-400 border-amber-400/40",
  danger: "text-red-400 border-red-400/40",
  muted: "text-muted-foreground border-border",
};

const CHIP_DOT: Record<ChipTone, string> = {
  ok: "bg-emerald-400",
  warn: "bg-amber-400",
  danger: "bg-red-400",
  muted: "bg-muted-foreground/50",
};

const ACCOUNT_LABELS: Record<ArcAgentStatus["account"]["state"], string> = {
  connected: "Account connected",
  "not-connected": "Account required",
  unknown: "Checking…",
  expired: "Account expired",
  error: "Account error",
};

// §7 status-chip mapping. "Unknown" (provider/account unresolved) never
// renders green: a runtime-ready agent whose account or provider status is
// unknown stays muted rather than claiming readiness.
function chipFor(agent: ArcAgentStatus): { label: string; tone: ChipTone } {
  const runtime = agent.runtime.state;
  let chip: { label: string; tone: ChipTone };
  if (runtime === "ready" || runtime === "ready-with-warning") {
    if (agent.overallState === "account-required") {
      chip = { label: "Account required", tone: "warn" };
    } else if (agent.overallState === "runtime-ready") {
      chip = { label: runtime === "ready-with-warning" ? "Ready · Untested version" : "Ready", tone: "muted" };
    } else {
      chip = { label: runtime === "ready-with-warning" ? "Ready · Untested version" : "Ready", tone: runtime === "ready-with-warning" ? "warn" : "ok" };
    }
  } else {
    switch (runtime) {
      case "not-prepared":
        chip = { label: "Setup required", tone: "warn" };
        break;
      case "preparing":
        chip = { label: "Preparing…", tone: "muted" };
        break;
      case "broken":
        chip = { label: "Needs repair", tone: "danger" };
        break;
      case "unsupported":
        chip = { label: "Unsupported version", tone: "danger" };
        break;
      case "unavailable":
        chip = { label: "Unavailable", tone: "muted" };
        break;
    }
  }
  // An unknown provider status must never present as green: downgrade a
  // "ready" reading to muted rather than claiming readiness.
  if (agent.provider.state === "unknown" && chip.tone === "ok") {
    return { ...chip, tone: "muted" };
  }
  return chip;
}

function StatusChip({ agent }: { agent: ArcAgentStatus }) {
  const chip = chipFor(agent);
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium", CHIP_TONE_TEXT[chip.tone])}>
      <span className={cn("size-1.5 rounded-full", CHIP_DOT[chip.tone])} />
      {chip.label}
    </span>
  );
}

function compatibilityLine(agent: ArcAgentStatus): { label: string; reason: string | null } | null {
  const compatibility = agent.runtime.compatibility;
  if (compatibility === "untested") return { label: "Untested version", reason: agent.runtime.compatibilityReason };
  if (compatibility === "blocked") return { label: "Unsupported version", reason: agent.runtime.compatibilityReason };
  return null;
}

function sourceLabel(source: ArcRuntimeSource | null): string | null {
  if (source === null) return null;
  return source === "external-override" ? "Source: External" : "Source: Arc-managed";
}

const CLAUDE_STEPS = [
  "Downloading from Anthropic",
  "Verifying download",
  "Checking macOS signature",
  "Installing for Arc",
  "Checking version",
];

function ClaudePrepareDialog({
  open,
  onOpenChange,
  agent,
  prepare,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: ArcAgentStatus;
  prepare: (id: string) => Promise<ArcAgentStatus>;
}) {
  const [phase, setPhase] = useState<"preparing" | "success" | "failure">("preparing");
  const [version, setVersion] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  async function runPrepare() {
    setPhase("preparing");
    setDiagnostic(null);
    setDiagnosticsOpen(false);
    try {
      const result = await prepare("claude-code");
      setVersion(result.runtime.version);
      setPhase("success");
    } catch (error) {
      setDiagnostic((error instanceof Error ? error.message : String(error)) || agent.runtime.compatibilityReason);
      setPhase("failure");
    }
  }

  useEffect(() => {
    if (open) void runPrepare();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Set up Claude Code</DialogTitle>
          <DialogDescription>Arc downloads and verifies the official Claude Code runtime.</DialogDescription>
        </DialogHeader>

        {phase === "preparing" ? (
          <ol className="space-y-1.5">
            {CLAUDE_STEPS.map((step, index) => (
              <li key={step} className="flex items-center gap-2 text-xs text-muted-foreground">
                {index === 0 ? (
                  <span aria-label="In progress" className="inline-flex size-3.5 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
                ) : (
                  <span className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border border-muted-foreground/30" />
                )}
                {step}
              </li>
            ))}
          </ol>
        ) : phase === "success" ? (
          <div className="space-y-3">
            <p className="text-sm">Claude Code is ready · Version {version ?? "unknown"}</p>
            <Button className="w-full" onClick={() => onOpenChange(false)}>
              Continue
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-red-400">Couldn&apos;t be prepared</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="flex-1" onClick={() => void runPrepare()}>
                Try Again
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => setDiagnosticsOpen((value) => !value)}
                disabled={diagnostic === null}
              >
                View Diagnostics
              </Button>
            </div>
            {diagnosticsOpen && diagnostic !== null ? (
              <details open className="rounded-md border border-border bg-background/60">
                <summary className="cursor-pointer px-3 py-1.5 text-xs text-muted-foreground">Diagnostics</summary>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap px-3 pb-3 font-mono text-[11px] leading-relaxed text-muted-foreground">{diagnostic}</pre>
              </details>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// Minimal, unpolished messaging for the update/rollback outcomes — the
// polished Updates UI (progress steps, version history) is Phase 23; this
// just makes the already-working backend reachable without curl.
function updateOutcomeMessage(outcome: ArcRuntimeUpdateOutcome): { text: string; isError: boolean } {
  switch (outcome.kind) {
    case "updated":
      return { text: outcome.detail, isError: false };
    case "up-to-date":
      return { text: `Already up to date${outcome.version !== null ? ` (${outcome.version})` : ""}`, isError: false };
    case "no-trusted-update":
      return { text: `Couldn't check for updates: ${outcome.reason}`, isError: true };
    case "staging-failed":
      return { text: `Download/verification failed: ${outcome.reason}`, isError: true };
    case "pre-activation-health-failed":
      return { text: `Candidate failed a health check before activating: ${outcome.reason}`, isError: true };
    case "activation-failed":
      return { text: `Activation failed: ${outcome.reason}`, isError: true };
    case "post-activation-unhealthy-rolled-back":
      return {
        text: `${outcome.to} failed a health check after activating and was rolled back from ${outcome.from} automatically.`,
        isError: true,
      };
    case "post-activation-unhealthy-no-rollback-target":
      return {
        text: `${outcome.version} failed a health check after activating; no known-good version was available to roll back to.`,
        isError: true,
      };
  }
}

function rollbackOutcomeMessage(outcome: ArcRuntimeRollbackOutcome): { text: string; isError: boolean } {
  switch (outcome.kind) {
    case "rolled-back":
      return { text: `Rolled back from ${outcome.from} to ${outcome.to}`, isError: false };
    case "unavailable":
      return { text: `Rollback unavailable: ${outcome.reason}`, isError: true };
    case "failed":
      return { text: `Rollback failed: ${outcome.reason}`, isError: true };
  }
}

function AgentCard({
  agent,
  prepare,
  repair,
  update,
  rollback,
}: {
  agent: ArcAgentStatus;
  prepare: (id: string) => Promise<ArcAgentStatus>;
  repair: (id: string) => Promise<ArcAgentStatus>;
  update: (id: string) => Promise<{ outcome: ArcRuntimeUpdateOutcome; agent: ArcAgentStatus }>;
  rollback: (id: string) => Promise<{ outcome: ArcRuntimeRollbackOutcome; agent: ArcAgentStatus }>;
}) {
  const [busy, setBusy] = useState<"prepare" | "repair" | "update" | "rollback" | null>(null);
  const [claudeOpen, setClaudeOpen] = useState(false);

  const hasPrepare = agent.actions.some((action) => action.id === "prepare" && action.available);
  const hasRepair = agent.actions.some((action) => action.id === "repair" && action.available);
  const hasUpdate = agent.actions.some((action) => action.id === "update" && action.available);
  const hasRollback = agent.actions.some((action) => action.id === "rollback" && action.available);
  const compatibility = compatibilityLine(agent);
  const source = sourceLabel(agent.runtime.source);

  async function runPrepare() {
    setBusy("prepare");
    try {
      await prepare(agent.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function runRepair() {
    setBusy("repair");
    try {
      await repair(agent.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function runUpdate() {
    setBusy("update");
    try {
      const { outcome } = await update(agent.id);
      const { text, isError } = updateOutcomeMessage(outcome);
      if (isError) toast.error(text);
      else toast.success(text);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function runRollback() {
    setBusy("rollback");
    try {
      const { outcome } = await rollback(agent.id);
      const { text, isError } = rollbackOutcomeMessage(outcome);
      if (isError) toast.error(text);
      else toast.success(text);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{agent.displayName}</h3>
        <StatusChip agent={agent} />
      </div>

      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <span>{agent.runtime.version !== null ? `Runtime ${agent.runtime.version}` : "Version unknown"}</span>
        {compatibility !== null ? (
          <span
            className={compatibility.label === "Unsupported version" ? "text-red-400" : "text-amber-400"}
            title={compatibility.reason ?? undefined}
          >
            {compatibility.label}
          </span>
        ) : null}
        <span>{ACCOUNT_LABELS[agent.account.state]}</span>
        {source !== null ? <span className="text-[11px] text-muted-foreground/70">{source}</span> : null}
      </div>

      {hasPrepare || hasRepair || hasUpdate || hasRollback ? (
        <div className="mt-1 flex flex-wrap gap-2">
          {hasPrepare && agent.id === "claude-code" ? (
            <Button size="sm" onClick={() => setClaudeOpen(true)} disabled={busy !== null}>
              {busy === "prepare" ? "Setting up…" : `Set Up ${agent.displayName}`}
            </Button>
          ) : hasPrepare ? (
            <Button size="sm" onClick={() => void runPrepare()} disabled={busy !== null}>
              {busy === "prepare" ? "Setting up…" : `Set Up ${agent.displayName}`}
            </Button>
          ) : null}
          {hasRepair ? (
            <Button variant="outline" size="sm" onClick={() => void runRepair()} disabled={busy !== null}>
              {busy === "repair" ? "Repairing…" : "Repair"}
            </Button>
          ) : null}
          {hasUpdate ? (
            <Button variant="outline" size="sm" onClick={() => void runUpdate()} disabled={busy !== null}>
              {busy === "update" ? "Updating…" : "Update"}
            </Button>
          ) : null}
          {hasRollback ? (
            <Button variant="outline" size="sm" onClick={() => void runRollback()} disabled={busy !== null}>
              {busy === "rollback" ? "Rolling back…" : "Roll Back"}
            </Button>
          ) : null}
        </div>
      ) : null}

      {agent.id === "claude-code" ? (
        <ClaudePrepareDialog open={claudeOpen} onOpenChange={setClaudeOpen} agent={agent} prepare={prepare} />
      ) : null}
    </article>
  );
}

export function AgentsPage() {
  const { agents, isLoading, error, prepare, repair, update, rollback } = useArcAgents();

  if (error !== null && agents === null) {
    return (
      <div className="p-4">
        <EmptyState title={`Failed to load agents: ${error}`} />
      </div>
    );
  }
  if (agents === null || isLoading) {
    return (
      <div className="p-4">
        <EmptyState title="Loading agents…" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-3 p-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} prepare={prepare} repair={repair} update={update} rollback={rollback} />
        ))}
      </div>
    </div>
  );
}
