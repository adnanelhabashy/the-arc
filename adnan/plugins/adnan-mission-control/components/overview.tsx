// Overview tab: BB-observed counters, mission state card, approval scope,
// verification expectations, and the provider capability probe.
import { useState, type FormEvent, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import type { MissionState, MissionValues, Probe, rpcContract } from "../server";
import { useMission, useTree, useArcAccounts, useArcAgents, useArcStatus, useArcUsage } from "@/lib/data";
import {
  Chip,
  EmptyState,
  ProvenanceBadge,
  SectionCard,
  relativeTime,
} from "@/components/common";

const INTENT_PRESETS = [
  "LEARN",
  "INVESTIGATE",
  "FIX",
  "BUILD",
  "DESIGN",
  "REVIEW",
  "VERIFY",
  "OPERATE",
  "RESEARCH",
  "META",
];

function FieldRow({ label, field, state, children }: { label: string; field: keyof MissionState["values"]; state: MissionState | null; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5 sm:grid-cols-[7rem_minmax(0,1fr)_auto]">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
      <ProvenanceBadge
        provenance={state?.fieldProvenance[field] ?? "agent-reported"}
        className="col-start-2 justify-self-start sm:col-start-3 sm:justify-self-end"
      />
    </div>
  );
}

function RiskBadge({ risk }: { risk: NonNullable<MissionValues["risk"]> }) {
  const tone = risk === "high" ? "text-red-400 border-red-400/40" : risk === "normal" ? "text-amber-400 border-amber-400/40" : "text-emerald-400 border-emerald-400/40";
  return <Chip className={`font-semibold uppercase ${tone}`}>{risk}</Chip>;
}

function MissionEditor({ open, onOpenChange, initial, onSave }: { open: boolean; onOpenChange: (open: boolean) => void; initial: MissionState | null; onSave: (values: Partial<MissionValues>) => Promise<void> }) {
  const v = initial?.values;
  const [task, setTask] = useState(v?.task ?? "");
  const [intent, setIntent] = useState(v?.intent ?? "");
  const [risk, setRisk] = useState(v?.risk ?? "");
  const [phase, setPhase] = useState(v?.phase ?? "");
  const [domains, setDomains] = useState(v?.domains.join(", ") ?? "");
  const [concerns, setConcerns] = useState(v?.concerns.join(", ") ?? "");
  const [skills, setSkills] = useState(v?.activeSkills.join(", ") ?? "");
  const [scopePhase, setScopePhase] = useState(v?.approvalScope?.phase ?? "");
  const [allowed, setAllowed] = useState(v?.approvalScope?.allowed.join(", ") ?? "");
  const [blocked, setBlocked] = useState(v?.approvalScope?.blocked.join(", ") ?? "");
  const [isSaving, setIsSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setIsSaving(true);
    const list = (text: string) => text.split(",").map((item) => item.trim()).filter((item) => item !== "");
    try {
      await onSave({
        task: task.trim() === "" ? null : task.trim(),
        intent: intent.trim() === "" ? null : intent.trim().toUpperCase(),
        risk: risk === "" ? null : (risk as MissionValues["risk"]),
        phase: phase.trim() === "" ? null : phase.trim(),
        domains: list(domains),
        concerns: list(concerns),
        activeSkills: list(skills),
        approvalScope: {
          phase: scopePhase.trim() === "" ? null : scopePhase.trim(),
          allowed: list(allowed),
          blocked: list(blocked),
        },
      });
      onOpenChange(false);
    } finally {
      setIsSaving(false);
    }
  }

  const fieldClass = "h-7 text-xs";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm">Set mission state</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="space-y-2">
          <label className="block space-y-1">
            <span className="text-[11px] text-muted-foreground">Task</span>
            <Input value={task} onChange={(event) => setTask(event.target.value)} className={fieldClass} placeholder="Fix Kafka ordering bug" />
          </label>
          <div className="grid grid-cols-3 gap-2">
            <label className="block space-y-1">
              <span className="text-[11px] text-muted-foreground">Intent</span>
              <Input value={intent} onChange={(event) => setIntent(event.target.value)} className={fieldClass} list="mc-intents" placeholder="FIX" />
              <datalist id="mc-intents">
                {INTENT_PRESETS.map((preset) => (
                  <option key={preset} value={preset} />
                ))}
              </datalist>
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] text-muted-foreground">Risk</span>
              <select value={risk} onChange={(event) => setRisk(event.target.value)} className={`flex w-full rounded-md border border-input bg-transparent px-2 ${fieldClass}`}>
                <option value="">—</option>
                <option value="low">low</option>
                <option value="normal">normal</option>
                <option value="high">high</option>
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] text-muted-foreground">Phase</span>
              <Input value={phase} onChange={(event) => setPhase(event.target.value)} className={fieldClass} placeholder="Investigation" />
            </label>
          </div>
          <label className="block space-y-1">
            <span className="text-[11px] text-muted-foreground">Domains (comma-separated)</span>
            <Input value={domains} onChange={(event) => setDomains(event.target.value)} className={fieldClass} placeholder="Kafka, Persistence" />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] text-muted-foreground">Concerns (comma-separated)</span>
            <Input value={concerns} onChange={(event) => setConcerns(event.target.value)} className={fieldClass} placeholder="ordering, idempotency" />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] text-muted-foreground">Active skills (comma-separated)</span>
            <Input value={skills} onChange={(event) => setSkills(event.target.value)} className={fieldClass} placeholder="systematic-debugging" />
          </label>
          <div className="rounded-md border border-border p-2 space-y-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Approval scope</p>
            <label className="block space-y-1">
              <span className="text-[11px] text-muted-foreground">Scope phase</span>
              <Input value={scopePhase} onChange={(event) => setScopePhase(event.target.value)} className={fieldClass} placeholder="Read-only investigation" />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] text-muted-foreground">Allowed (comma-separated)</span>
              <Input value={allowed} onChange={(event) => setAllowed(event.target.value)} className={fieldClass} placeholder="read files, search repository" />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] text-muted-foreground">Blocked (comma-separated)</span>
              <Input value={blocked} onChange={(event) => setBlocked(event.target.value)} className={fieldClass} placeholder="edit, execute tests, commit" />
            </label>
          </div>
          <p className="text-[11px] text-muted-foreground">Saves as user-confirmed. Cleared fields stay cleared.</p>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={isSaving}>
              {isSaving ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProbeTable({ probe }: { probe: Probe }) {
  if (probe.providers.length === 0) {
    return <EmptyState title="No providers to probe yet." />;
  }
  const rows = probe.providers;
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-muted-foreground">
          <th className="py-1 pr-2 font-medium">Provider</th>
          <th className="py-1 pr-2 text-center font-medium" title="client/turn/start events (model / reasoning / permission mode)">Model</th>
          <th className="py-1 pr-2 text-center font-medium" title="thread/tokenUsage/updated events">Tokens</th>
          <th className="py-1 pr-2 text-center font-medium" title="thread/contextWindowUsage/updated events">Context</th>
          <th className="py-1 pr-2 text-center font-medium" title="item/fileChange/outputDelta events">Files</th>
          <th className="py-1 text-center font-medium" title="Threads with a pending interaction">Pending</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.providerId} className="border-t border-border/60">
            <td
              className="py-1 pr-2 font-mono"
              title={Object.entries(row.eventTypes)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 12)
                .map(([type, count]) => `${type} ×${count}`)
                .join("\n")}
            >
              {row.providerId}
            </td>
            {([
              [row.modelEvents, row.threadsSampled],
              [row.tokenUsageEvents, row.threadsSampled],
              [row.contextUsageEvents, row.threadsSampled],
              [row.fileChangeEvents, row.threadsSampled],
              [row.pendingInteractions, row.threadsSampled],
            ] as const).map(([count, sampled], index) => (
              <td key={index} className="py-1 pr-2 text-center">
                {sampled === 0 ? (
                  <span className="text-muted-foreground/60">n/a</span>
                ) : count > 0 ? (
                  <span className="text-emerald-400">✓ {count}/{sampled}</span>
                ) : (
                  <span className="text-muted-foreground">✗ 0/{sampled}</span>
                )}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ArcSummaryCard() {
  const { status } = useArcStatus();
  const { agents } = useArcAgents();
  const { accounts } = useArcAccounts();
  const { data: usage } = useArcUsage();

  if (status !== null && status.arcAvailable === false) {
    return (
      <SectionCard title="Arc">
        <p className="text-xs text-muted-foreground">Arc services unavailable on this server.</p>
      </SectionCard>
    );
  }

  const agentTotal = agents?.length ?? 0;
  const readyCount = agents?.filter((agent) => agent.overallState === "ready").length ?? 0;
  const setupRequiredCount = agents?.filter((agent) => agent.overallState === "not-prepared").length ?? 0;
  const connectedAccounts = accounts?.filter((account) => account.authState === "connected" && account.enabled).length ?? 0;
  const staleSources = usage?.resources.filter((resource) => resource.stale).length ?? 0;
  const errorSources = usage?.resources.filter((resource) => resource.status === "error").length ?? 0;

  return (
    <SectionCard title="Arc">
      <ul className="space-y-1 text-xs">
        <li>
          Agents {agentTotal} · Ready {readyCount} · Setup required {setupRequiredCount}
        </li>
        <li>Accounts {connectedAccounts} connected</li>
        <li>
          Usage {staleSources} stale · {errorSources} error
        </li>
      </ul>
    </SectionCard>
  );
}

export function OverviewPage() {
  const { data } = useTree();
  const { state, setState } = useMission();
  const rpc = useRpc<typeof rpcContract>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [isProbing, setIsProbing] = useState(false);

  const shownProbe = probe ?? data?.probe ?? null;

  async function rerunProbe() {
    setIsProbing(true);
    try {
      const result = await rpc.call("probe_run", null);
      setProbe(result.probe);
    } finally {
      setIsProbing(false);
    }
  }

  const counters = data?.counters ?? null;
  const v = state?.values ?? null;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-3 p-4">
      {counters !== null ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(
            [
              ["Threads", counters.total],
              ["Active", counters.active],
              ["Idle", counters.idle],
              ["Pending approvals", counters.pendingInteractions],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="rounded-lg border border-border bg-card px-3 py-2">
              <div className="text-lg font-semibold tabular-nums">{value}</div>
              <div className="text-[11px] text-muted-foreground">{label}</div>
            </div>
          ))}
        </div>
      ) : null}

      <ArcSummaryCard />

      <SectionCard
        title="Mission"
        provenance={state !== null && state.updatedBy === "ui" ? "user-confirmed" : "agent-reported"}
        actions={
          <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setEditorOpen(true)}>
            <Icon name="EditFile" className="mr-1 size-3" />
            {state === null ? "Set state" : "Edit"}
          </Button>
        }
      >
        {v === null ? (
          <EmptyState title="No mission state yet.">
            The agent can report it with the report_mission_state tool or{" "}
            <code className="text-[11px]">bb mission-control set</code>, or set it here.
          </EmptyState>
        ) : (
          <div className="space-y-2">
            {v.task !== null ? (
              <FieldRow label="Task" field="task" state={state}>
                <span className="text-sm font-medium">{v.task}</span>
              </FieldRow>
            ) : null}
            <div className="grid gap-2 sm:grid-cols-2">
              <FieldRow label="Intent" field="intent" state={state}>
                <Chip className="font-mono font-semibold">{v.intent ?? "—"}</Chip>
              </FieldRow>
              <FieldRow label="Risk" field="risk" state={state}>
                {v.risk !== null ? <RiskBadge risk={v.risk} /> : <span className="text-xs text-muted-foreground">—</span>}
              </FieldRow>
            </div>
            <FieldRow label="Domains" field="domains" state={state}>
              <div className="flex flex-wrap gap-1">
                {v.domains.length === 0 ? <span className="text-xs text-muted-foreground">—</span> : v.domains.map((domain) => <Chip key={domain}>{domain}</Chip>)}
              </div>
            </FieldRow>
            <FieldRow label="Concerns" field="concerns" state={state}>
              <div className="flex flex-wrap gap-1">
                {v.concerns.length === 0 ? <span className="text-xs text-muted-foreground">—</span> : v.concerns.map((concern) => <Chip key={concern}>{concern}</Chip>)}
              </div>
            </FieldRow>
            <FieldRow label="Phase" field="phase" state={state}>
              <span className="text-xs">{v.phase ?? "—"}</span>
            </FieldRow>
            <FieldRow label="Skills" field="activeSkills" state={state}>
              <div className="flex flex-wrap gap-1">
                {v.activeSkills.length === 0 ? <span className="text-xs text-muted-foreground">—</span> : v.activeSkills.map((skill) => <Chip key={skill} className="font-mono">{skill}</Chip>)}
              </div>
            </FieldRow>
            <p className="pt-1 text-[10px] text-muted-foreground/70">
              Updated {state === null ? "—" : relativeTime(state.updatedAt)} via {state?.updatedBy ?? "—"}
            </p>
          </div>
        )}
      </SectionCard>

      {v?.approvalScope != null ? (
        <SectionCard title="Approval scope" provenance={state === null ? "agent-reported" : state.fieldProvenance.approvalScope ?? "agent-reported"}>
          <p className="mb-2 text-xs font-medium">{v.approvalScope.phase ?? "Current phase"}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-[11px] uppercase tracking-wide text-emerald-400/80">Allowed</p>
              <ul className="space-y-0.5 text-xs">
                {v.approvalScope.allowed.length === 0 ? <li className="text-muted-foreground">—</li> : v.approvalScope.allowed.map((item) => <li key={item}>✓ {item}</li>)}
              </ul>
            </div>
            <div>
              <p className="mb-1 text-[11px] uppercase tracking-wide text-red-400/80">Blocked</p>
              <ul className="space-y-0.5 text-xs">
                {v.approvalScope.blocked.length === 0 ? <li className="text-muted-foreground">—</li> : v.approvalScope.blocked.map((item) => <li key={item}>✗ {item}</li>)}
              </ul>
            </div>
          </div>
        </SectionCard>
      ) : null}

      {v !== null && v.verification.length > 0 ? (
        <SectionCard title="Verification expectations" provenance={state === null ? "agent-reported" : state.fieldProvenance.verification ?? "agent-reported"}>
          <ul className="space-y-1 text-xs">
            {v.verification.map((item) => (
              <li key={item.label} className="flex items-center gap-2">
                <span className="inline-block w-3 text-center">
                  {item.status === "passed" ? "✅" : item.status === "failed" ? "❌" : item.status === "not-required" ? "—" : "⬜"}
                </span>
                <span className={item.status === "not-required" ? "text-muted-foreground line-through" : ""}>{item.label}</span>
                <span className="text-[10px] uppercase text-muted-foreground/70">{item.status}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[10px] text-muted-foreground/70">Statuses are agent-reported expectations, not evidence. See the Verification tab to attach real evidence.</p>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Provider capabilities"
        provenance="bb-observed"
        actions={
          <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={() => void rerunProbe()} disabled={isProbing}>
            <Icon name="Repeat" className="mr-1 size-3" />
            {isProbing ? "Probing…" : "Re-run probe"}
          </Button>
        }
      >
        {shownProbe === null ? <EmptyState title="Probe has not run yet." /> : (
          <div className="space-y-1">
            <ProbeTable probe={shownProbe} />
            <p className="text-[10px] text-muted-foreground/70">
              Sampled up to 2 recent threads per provider. ✓ n/m = threads exposing the signal. Missing signals mean the provider does not emit them (not an error).
              {shownProbe.at !== null ? ` Probed ${relativeTime(shownProbe.at)}.` : ""}
            </p>
          </div>
        )}
      </SectionCard>

      <MissionEditor open={editorOpen} onOpenChange={setEditorOpen} initial={state} onSave={setState} />
    </div>
  );
}
