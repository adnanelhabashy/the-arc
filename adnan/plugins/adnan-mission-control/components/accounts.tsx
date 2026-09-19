// Accounts tab (Phase 10): the three account groups — ChatGPT (used by Codex),
// Claude (used by Claude Code), and OMP Providers (used by OMP). Pool accounts
// expose enable/remove/reorder; OMP accounts expose only Disconnect (the OMP
// 18.2.6 disconnect semantic). No "Account Pool" or auto-rotate language.
import { useState } from "react";
import { toast } from "sonner";
import type { ArcAccount, ArcAccountAuthState } from "@/lib/arc-types";
import { useArcAccounts, useArcOmpProviders } from "@/lib/data";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Chip, EmptyState } from "@/components/common";
import { AUTH_METHOD_LABEL, ChatGptConnectDialog, ClaudeConnectDialog, OmpProviderPickerDialog } from "@/components/connect-flows";
import { cn } from "@/lib/utils";

const AUTH_STATE: Record<ArcAccountAuthState, { label: string; className: string }> = {
  connected: { label: "Connected", className: "text-emerald-400 border-emerald-400/40" },
  expired: { label: "Expired", className: "text-amber-400 border-amber-400/40" },
  disabled: { label: "Disabled", className: "text-muted-foreground border-border" },
  error: { label: "Error", className: "text-red-400 border-red-400/40" },
  unknown: { label: "Unknown", className: "text-muted-foreground border-border" },
};

function AuthStateChip({ state }: { state: ArcAccountAuthState }) {
  const style = AUTH_STATE[state];
  return (
    <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium", style.className)}>{style.label}</span>
  );
}

function AccountMeta({ account }: { account: ArcAccount }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="text-[13px] font-medium">{account.providerLabel}</span>
        {account.planLabel !== null ? <Chip>{account.planLabel}</Chip> : null}
        <AuthStateChip state={account.authState} />
      </div>
      {account.email !== null ? <div className="truncate text-[11px] text-muted-foreground">{account.email}</div> : null}
    </div>
  );
}

function ConfirmRemoveDialog({
  account,
  title,
  confirmLabel,
  onConfirm,
  onOpenChange,
}: {
  account: ArcAccount | null;
  title: string;
  confirmLabel: string;
  onConfirm: (id: string) => Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={account !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {account !== null ? (
              <>
                {account.providerLabel}
                {account.email !== null ? ` · ${account.email}` : ""}
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={() => {
              if (account === null) return;
              setBusy(true);
              void onConfirm(account.id)
                .then(() => onOpenChange(false))
                .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Removing…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PoolAccountRow({
  account,
  index,
  total,
  onSetEnabled,
  onRemove,
  onMove,
}: {
  account: ArcAccount;
  index: number;
  total: number;
  onSetEnabled: (enabled: boolean) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  return (
    <li className="flex items-center gap-2 rounded-md border border-border bg-background/40 px-2 py-1.5">
      <AccountMeta account={account} />
      <div className="flex shrink-0 items-center gap-1.5">
        {total > 1 ? (
          <span className="flex">
            <button
              type="button"
              aria-label={`Move ${account.providerLabel} up`}
              disabled={index === 0}
              onClick={() => onMove(-1)}
              className="rounded p-0.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground disabled:opacity-30"
            >
              ↑
            </button>
            <button
              type="button"
              aria-label={`Move ${account.providerLabel} down`}
              disabled={index === total - 1}
              onClick={() => onMove(1)}
              className="rounded p-0.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground disabled:opacity-30"
            >
              ↓
            </button>
          </span>
        ) : null}
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Checkbox checked={account.enabled} onCheckedChange={(checked) => onSetEnabled(checked === true)} />
          Enabled
        </label>
        <Button variant="outline" size="sm" onClick={onRemove}>
          Remove
        </Button>
      </div>
    </li>
  );
}

function PoolGroup({
  title,
  connectLabel,
  family,
  accounts,
  setEnabled,
  remove,
  reorder,
  onConnect,
}: {
  title: string;
  connectLabel: string;
  family: string;
  accounts: ArcAccount[];
  setEnabled: (id: string, enabled: boolean) => Promise<ArcAccount>;
  remove: (id: string) => Promise<void>;
  reorder: (family: string, orderedIds: string[]) => Promise<void>;
  onConnect: () => void;
}) {
  const [pendingRemove, setPendingRemove] = useState<ArcAccount | null>(null);

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= accounts.length) return;
    const next = [...accounts];
    [next[index], next[target]] = [next[target], next[index]];
    void reorder(family, next.map((account) => account.sourceId));
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
        <Button variant="outline" size="sm" onClick={onConnect}>
          {connectLabel}
        </Button>
      </div>
      {accounts.length === 0 ? (
        <EmptyState title="No accounts connected." />
      ) : (
        <ul className="space-y-1">
          {accounts.map((account, index) => (
            <PoolAccountRow
              key={account.id}
              account={account}
              index={index}
              total={accounts.length}
              onSetEnabled={(enabled) => void setEnabled(account.id, enabled)}
              onRemove={() => setPendingRemove(account)}
              onMove={(direction) => move(index, direction)}
            />
          ))}
        </ul>
      )}
      <ConfirmRemoveDialog
        account={pendingRemove}
        title="Remove account"
        confirmLabel="Remove account"
        onConfirm={remove}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
      />
    </section>
  );
}

function OmpGroup({
  providers,
  accounts,
  remove,
  onConnect,
}: {
  providers: Array<{ id: string; displayName: string; authMethod: "oauth" | "api-key" | "unknown"; connectionState: string }>;
  accounts: ArcAccount[];
  remove: (id: string) => Promise<void>;
  onConnect: () => void;
}) {
  const [pendingDisconnect, setPendingDisconnect] = useState<ArcAccount | null>(null);
  const connected = providers.filter((provider) => provider.connectionState === "connected");

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">OMP Providers — Used by OMP</h3>
        <Button variant="outline" size="sm" onClick={onConnect}>
          Connect Provider
        </Button>
      </div>
      {connected.length === 0 ? (
        <EmptyState title="No OMP providers connected." />
      ) : (
        <div className="space-y-2">
          {connected.map((provider) => {
            const providerAccounts = accounts.filter(
              (account) => account.sourceKind === "omp" && account.providerFamily === provider.id,
            );
            return (
              <div key={provider.id} className="space-y-1">
                <div className="flex items-center gap-2 text-[13px] font-medium">
                  {provider.displayName}
                  <Chip>{AUTH_METHOD_LABEL[provider.authMethod as keyof typeof AUTH_METHOD_LABEL]}</Chip>
                </div>
                {providerAccounts.length === 0 ? (
                  <p className="pl-1 text-[11px] text-muted-foreground">No accounts yet.</p>
                ) : (
                  <ul className="space-y-1">
                    {providerAccounts.map((account) => (
                      <li key={account.id} className="flex items-center gap-2 rounded-md border border-border bg-background/40 px-2 py-1.5">
                        <AccountMeta account={account} />
                        <Button variant="outline" size="sm" onClick={() => setPendingDisconnect(account)}>
                          Disconnect
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
      <ConfirmRemoveDialog
        account={pendingDisconnect}
        title="Disconnect account"
        confirmLabel="Disconnect"
        onConfirm={remove}
        onOpenChange={(open) => {
          if (!open) setPendingDisconnect(null);
        }}
      />
    </section>
  );
}

export function AccountsPage() {
  const { accounts, isLoading, error, refresh, setEnabled, remove, reorder } = useArcAccounts();
  const { providers } = useArcOmpProviders();
  const [chatGptOpen, setChatGptOpen] = useState(false);
  const [claudeOpen, setClaudeOpen] = useState(false);
  const [ompOpen, setOmpOpen] = useState(false);

  const onConnected = () => {
    refresh();
  };

  if (error !== null && accounts === null) {
    return (
      <div className="p-4">
        <EmptyState title={`Failed to load accounts: ${error}`} />
      </div>
    );
  }
  if (accounts === null || isLoading) {
    return (
      <div className="p-4">
        <EmptyState title="Loading accounts…" />
      </div>
    );
  }

  const openaiAccounts = accounts.filter((account) => account.providerFamily === "openai" && account.sourceKind === "pool");
  const anthropicAccounts = accounts.filter((account) => account.providerFamily === "anthropic" && account.sourceKind === "pool");

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
      <PoolGroup
        title="ChatGPT — Used by Codex"
        connectLabel="Connect ChatGPT"
        family="openai"
        accounts={openaiAccounts}
        setEnabled={setEnabled}
        remove={remove}
        reorder={reorder}
        onConnect={() => setChatGptOpen(true)}
      />
      <PoolGroup
        title="Claude — Used by Claude Code"
        connectLabel="Connect Claude"
        family="anthropic"
        accounts={anthropicAccounts}
        setEnabled={setEnabled}
        remove={remove}
        reorder={reorder}
        onConnect={() => setClaudeOpen(true)}
      />
      <OmpGroup providers={providers ?? []} accounts={accounts} remove={remove} onConnect={() => setOmpOpen(true)} />

      <ChatGptConnectDialog open={chatGptOpen} onOpenChange={setChatGptOpen} onConnected={onConnected} />
      <ClaudeConnectDialog open={claudeOpen} onOpenChange={setClaudeOpen} onConnected={onConnected} />
      <OmpProviderPickerDialog open={ompOpen} onOpenChange={setOmpOpen} onConnected={onConnected} />
    </div>
  );
}
