// Phase 20 lean onboarding: Welcome → agent readiness → connect accounts →
// ready. Guides the user through existing Arc functionality (agent
// prepare/repair, account connect flows) rather than duplicating it. Never
// blocks Arc entirely on an optional provider login — one ready agent is
// enough to finish.
import { useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { appToast } from "@/components/ui/app-toast";
import { useOnboardingController } from "@/hooks/useOnboarding";
import { APP_ROOT_ROUTE_PATH } from "@/lib/route-paths";
import {
  useArcAccountsList,
  useArcAgentPrepare,
  useArcAgentRepair,
  useArcAgentsList,
  type ArcAgentStatus,
} from "@/hooks/queries/arc-queries";
import {
  ChatGptConnectDialog,
  ClaudeConnectDialog,
  OmpProviderPickerDialog,
} from "./arc-connect-dialogs";

type OnboardingStep = "welcome" | "agents" | "accounts" | "ready";

const STEP_ORDER: OnboardingStep[] = ["welcome", "agents", "accounts", "ready"];

function agentStateLabel(agent: ArcAgentStatus): { label: string; ready: boolean } {
  switch (agent.runtime.state) {
    case "ready":
    case "ready-with-warning":
      return { label: "Ready", ready: true };
    case "preparing":
      return { label: "Installing…", ready: false };
    case "not-prepared":
      return { label: "Setup required", ready: false };
    case "broken":
      return { label: "Couldn't be prepared", ready: false };
    case "unsupported":
      return { label: "Unsupported version", ready: false };
    case "unavailable":
      return { label: "Unavailable", ready: false };
  }
}

function AgentRow({ agent }: { agent: ArcAgentStatus }) {
  const prepare = useArcAgentPrepare();
  const repair = useArcAgentRepair();
  const { label, ready } = agentStateLabel(agent);
  const busy = prepare.isPending || repair.isPending;
  const canPrepare = agent.actions.some((action) => action.id === "prepare" && action.available);
  const canRepair = agent.actions.some((action) => action.id === "repair" && action.available);

  const run = (mutation: typeof prepare | typeof repair) => {
    mutation.mutate(agent.id, {
      onError: (error) => {
        appToast.error(
          `${agent.displayName} could not be prepared.`,
          {
            description: error instanceof Error ? error.message : String(error),
          },
        );
      },
    });
  };

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <Icon
          name={ready ? "CircleCheck" : agent.runtime.state === "preparing" ? "Spinner" : "Circle"}
          className={cn(
            "size-4 shrink-0",
            ready
              ? "text-emerald-500"
              : agent.runtime.state === "preparing"
                ? "animate-spin text-muted-foreground"
                : agent.runtime.state === "broken" || agent.runtime.state === "unsupported"
                  ? "text-destructive-text"
                  : "text-muted-foreground",
          )}
        />
        <div>
          <p className="text-sm font-medium">{agent.displayName}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </div>
      {canPrepare ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => run(prepare)}>
          {busy ? "Setting up…" : "Set up"}
        </Button>
      ) : canRepair ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => run(repair)}>
          {busy ? "Repairing…" : "Retry setup"}
        </Button>
      ) : null}
    </div>
  );
}

function WelcomeStepView({ onNext }: { onNext: () => void }) {
  return (
    <div className="space-y-5 text-center">
      <h2 className="text-lg font-semibold">Welcome to Arc Agent</h2>
      <p className="text-sm text-muted-foreground">
        Your coding workspace, powered by Codex, Claude Code, and OMP.
      </p>
      <Button className="w-full" onClick={onNext}>
        Get Started
      </Button>
    </div>
  );
}

function AgentsStepView({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const agentsQuery = useArcAgentsList();
  const agents = agentsQuery.data?.agents ?? [];

  return (
    <div className="space-y-4">
      <div className="space-y-1 text-center">
        <h2 className="text-lg font-semibold">Preparing your coding agents</h2>
        <p className="text-sm text-muted-foreground">
          Arc downloads and verifies each agent&apos;s official runtime.
        </p>
      </div>
      {agentsQuery.isPending ? (
        <p className="text-center text-sm text-muted-foreground">Checking agent status…</p>
      ) : (
        <div className="space-y-2">
          {agents.map((agent) => (
            <AgentRow key={agent.id} agent={agent} />
          ))}
        </div>
      )}
      <div className="flex justify-between gap-2 pt-1">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onNext}>Continue</Button>
      </div>
    </div>
  );
}

type ConnectDialog = "chatgpt" | "claude" | "omp" | null;

function AccountRow({
  label,
  connected,
  onConnect,
}: {
  label: string;
  connected: boolean;
  onConnect: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
      <p className="text-sm font-medium">{label}</p>
      {connected ? (
        <span className="flex items-center gap-1.5 text-xs text-emerald-500">
          <Icon name="CircleCheck" className="size-3.5" />
          Connected
        </span>
      ) : (
        <Button size="sm" variant="outline" onClick={onConnect}>
          Connect
        </Button>
      )}
    </div>
  );
}

// Which provider families count as "connected" for onboarding's three rows
// — presentation logic, not a wire-shaped hook other surfaces would reuse.
function useConnectedAgentAccounts() {
  const accountsQuery = useArcAccountsList();
  const accounts = accountsQuery.data?.accounts ?? [];
  return {
    hasChatGpt: accounts.some(
      (account) => account.providerFamily === "openai" && account.authState === "connected",
    ),
    hasClaude: accounts.some(
      (account) => account.providerFamily === "anthropic" && account.authState === "connected",
    ),
    hasOmp: accounts.some(
      (account) => account.sourceKind === "omp" && account.authState === "connected",
    ),
    refresh: () => void accountsQuery.refetch(),
  };
}

function AccountsStepView({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const accountsQuery = useConnectedAgentAccounts();
  const [dialog, setDialog] = useState<ConnectDialog>(null);

  return (
    <div className="space-y-4">
      <div className="space-y-1 text-center">
        <h2 className="text-lg font-semibold">Connect accounts</h2>
        <p className="text-sm text-muted-foreground">
          Optional — skip any of these and connect later from Settings.
        </p>
      </div>
      <div className="space-y-2">
        <AccountRow
          label="ChatGPT / Codex"
          connected={accountsQuery.hasChatGpt}
          onConnect={() => setDialog("chatgpt")}
        />
        <AccountRow
          label="Claude"
          connected={accountsQuery.hasClaude}
          onConnect={() => setDialog("claude")}
        />
        <AccountRow
          label="OMP providers"
          connected={accountsQuery.hasOmp}
          onConnect={() => setDialog("omp")}
        />
      </div>
      <div className="flex justify-between gap-2 pt-1">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onNext}>Continue</Button>
      </div>

      <ChatGptConnectDialog
        open={dialog === "chatgpt"}
        onOpenChange={(open) => setDialog(open ? "chatgpt" : null)}
        onConnected={() => accountsQuery.refresh()}
      />
      <ClaudeConnectDialog
        open={dialog === "claude"}
        onOpenChange={(open) => setDialog(open ? "claude" : null)}
        onConnected={() => accountsQuery.refresh()}
      />
      <OmpProviderPickerDialog
        open={dialog === "omp"}
        onOpenChange={(open) => setDialog(open ? "omp" : null)}
        onConnected={() => accountsQuery.refresh()}
      />
    </div>
  );
}

function ReadyStepView({ onBack, onFinish }: { onBack: () => void; onFinish: () => void }) {
  const agentsQuery = useArcAgentsList();
  const agents = agentsQuery.data?.agents ?? [];
  const navigate = useNavigate();

  return (
    <div className="space-y-5">
      <div className="space-y-1 text-center">
        <h2 className="text-lg font-semibold">You&apos;re ready</h2>
        <p className="text-sm text-muted-foreground">
          One ready agent is enough to start — connect the rest anytime from Settings.
        </p>
      </div>
      <div className="space-y-2">
        {agents.map((agent) => {
          const { label } = agentStateLabel(agent);
          return (
            <div key={agent.id} className="flex items-center justify-between text-sm">
              <span className="font-medium">{agent.displayName}</span>
              <span className="text-muted-foreground">{label}</span>
            </div>
          );
        })}
      </div>
      <div className="flex justify-between gap-2 pt-1">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button
          onClick={() => {
            onFinish();
            navigate(APP_ROOT_ROUTE_PATH);
          }}
        >
          Create first thread
        </Button>
      </div>
    </div>
  );
}

export function OnboardingOverlay() {
  const { open, dataReady, complete } = useOnboardingController();
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const titleId = useId();

  if (!open || !dataReady) return null;

  const stepIndex = STEP_ORDER.indexOf(step);
  const goTo = (next: OnboardingStep) => setStep(next);
  const back = () => {
    const index = STEP_ORDER.indexOf(step);
    if (index > 0) setStep(STEP_ORDER[index - 1]);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-onboarding-overlay
      className="fixed inset-0 z-70 flex items-center justify-center overflow-y-auto bg-surface-scrim p-4"
    >
      <div
        id={titleId}
        className="w-full max-w-md space-y-4 rounded-lg border border-border bg-background p-6 shadow-lg"
      >
        {step === "welcome" ? (
          <WelcomeStepView onNext={() => goTo("agents")} />
        ) : step === "agents" ? (
          <AgentsStepView onNext={() => goTo("accounts")} onBack={back} />
        ) : step === "accounts" ? (
          <AccountsStepView onNext={() => goTo("ready")} onBack={back} />
        ) : (
          <ReadyStepView onBack={back} onFinish={complete} />
        )}
        {step !== "welcome" ? (
          <p className="text-center text-[11px] text-muted-foreground">
            Step {stepIndex + 1} of {STEP_ORDER.length}
          </p>
        ) : null}
      </div>
    </div>
  );
}
