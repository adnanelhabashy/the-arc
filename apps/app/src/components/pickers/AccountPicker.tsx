import { useMemo, useState } from "react";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
  OPTION_MENU_CONTENT_CLASS_NAME,
  OPTION_MUTED_CLASS_NAME,
} from "@bb/shared-ui/option-display";
import {
  useArcAccountsList,
  type ArcAccount,
  type ArcAccountAuthState,
  type ArcAgentId,
} from "@/hooks/queries/arc-queries";

export interface ExistingThreadAccountState {
  accountKey: string | null;
  accountResolved: boolean | null;
  hasHistory: boolean;
}

export interface AccountPickerProps {
  agentId: ArcAgentId | null;
  providerFamily?: string | null;
  value: string | null;
  onChange: (accountKey: string | null) => void;
  onManageAccounts?: () => void;
  existingThreadState?: ExistingThreadAccountState;
  disabled?: boolean;
  className?: string;
}

function accountIdentity(account: ArcAccount): string {
  return account.accountKey ?? account.id;
}

function accountLabel(account: ArcAccount): string {
  return account.planLabel !== null
    ? `${account.providerLabel} · ${account.planLabel}`
    : account.providerLabel;
}

function disabledReasonFor(authState: ArcAccountAuthState): string | undefined {
  switch (authState) {
    case "expired":
      return "Sign-in expired";
    case "disabled":
      return "Temporarily unavailable";
    case "error":
      return "Connection error";
    case "unknown":
      return "Status unknown";
    case "connected":
      return undefined;
  }
}

function filterAccounts(
  accounts: readonly ArcAccount[],
  agentId: ArcAgentId,
  providerFamily: string | null | undefined,
): ArcAccount[] {
  return accounts.filter((account) => {
    if (!account.availableThrough.includes(agentId)) return false;
    if (agentId === "omp" && providerFamily) {
      return account.providerFamily === providerFamily;
    }
    return true;
  });
}

export function useAccountRequiresResolution(
  agentId: ArcAgentId | null,
  providerFamily: string | null | undefined,
  existingThreadState: ExistingThreadAccountState | undefined,
): boolean {
  const { data } = useArcAccountsList({ enabled: agentId !== null });
  return useMemo(() => {
    if (agentId === null || existingThreadState === undefined) return false;
    const accounts = filterAccounts(
      data?.accounts ?? [],
      agentId,
      providerFamily,
    );
    // No Account Pooler accounts connected for this agent means there is no
    // real choice to make, so a legacy/unresolved thread should not be
    // blocked from sending — the account-selection feature is simply inactive.
    if (accounts.length === 0) return false;
    if (
      existingThreadState.accountKey === null &&
      existingThreadState.accountResolved !== true &&
      existingThreadState.hasHistory
    ) {
      return true;
    }
    if (
      existingThreadState.accountKey !== null &&
      existingThreadState.accountResolved === true
    ) {
      const stored = accounts.find(
        (account) => accountIdentity(account) === existingThreadState.accountKey,
      );
      return (
        stored === undefined ||
        stored.authState === "disabled" ||
        stored.authState === "error"
      );
    }
    return false;
  }, [agentId, data, existingThreadState, providerFamily]);
}

const TRIGGER_CLASS_NAME = cn(
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
  OPTION_MUTED_CLASS_NAME,
  LIST_HOVER_TRANSITION,
  "gap-1.5",
);
const TRIGGER_WARNING_CLASS_NAME =
  "text-warning-text hover:text-warning-text data-[state=open]:text-warning-text";

export function AccountPicker({
  agentId,
  providerFamily,
  value,
  onChange,
  onManageAccounts,
  existingThreadState,
  disabled,
  className,
}: AccountPickerProps) {
  const { data } = useArcAccountsList({ enabled: agentId !== null });
  const accounts = useMemo(
    () => (agentId === null ? [] : filterAccounts(data?.accounts ?? [], agentId, providerFamily)),
    [data, agentId, providerFamily],
  );

  const [pendingKey, setPendingKey] = useState<string | null>(null);

  if (agentId === null) return null;

  const isNewThread = existingThreadState === undefined;
  if (isNewThread && accounts.length === 0) return null;

  const isResolvedExisting = existingThreadState?.accountResolved === true;
  const storedKey = existingThreadState?.accountKey ?? null;
  const storedAccount =
    storedKey !== null
      ? accounts.find((account) => accountIdentity(account) === storedKey)
      : undefined;
  const isUnavailable =
    storedKey !== null &&
    isResolvedExisting &&
    (storedAccount === undefined ||
      storedAccount.authState === "disabled" ||
      storedAccount.authState === "error");
  const isLegacyUnknown =
    !isNewThread &&
    !isResolvedExisting &&
    existingThreadState.accountKey === null &&
    existingThreadState.hasHistory;
  const isWarning = isUnavailable || isLegacyUnknown;

  const selectedNewThreadAccount =
    value !== null
      ? accounts.find((account) => accountIdentity(account) === value)
      : undefined;
  const triggerLabel = isLegacyUnknown
    ? "Select account"
    : isUnavailable
      ? "Account unavailable"
      : isResolvedExisting
        ? storedAccount
          ? accountLabel(storedAccount)
          : "Select account"
        : value === null
          ? "Auto"
          : (selectedNewThreadAccount
              ? accountLabel(selectedNewThreadAccount)
              : "Select account");

  function commitSelection(accountKey: string) {
    if (isResolvedExisting) {
      setPendingKey(accountKey);
      return;
    }
    onChange(accountKey);
  }

  function confirmPending() {
    if (pendingKey === null) return;
    onChange(pendingKey);
    setPendingKey(null);
  }

  const manageAccountsItem = onManageAccounts ? (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={onManageAccounts}
        className={cn("text-muted-foreground", LIST_HOVER_TRANSITION)}
      >
        Manage accounts…
      </DropdownMenuItem>
    </>
  ) : null;

  const pendingAccount =
    pendingKey !== null
      ? accounts.find((account) => accountIdentity(account) === pendingKey)
      : undefined;

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) setPendingKey(null);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Account"
          disabled={disabled}
          className={cn(
            TRIGGER_CLASS_NAME,
            isWarning && TRIGGER_WARNING_CLASS_NAME,
            className,
          )}
        >
          {isWarning ? (
            <Icon name="AlertTriangle" className="size-3.5 shrink-0" />
          ) : null}
          <span className="min-w-0 truncate">{triggerLabel}</span>
          <Icon
            name="ChevronDown"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className={OPTION_MENU_CONTENT_CLASS_NAME}
        mobileTitle="Account"
      >
        {pendingKey !== null ? (
          <div className="space-y-2 p-2">
            <p className="text-xs leading-snug text-foreground">
              Switch account to{" "}
              <span className="font-medium">
                {pendingAccount ? accountLabel(pendingAccount) : pendingKey}
              </span>
              ?
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                className="h-7 flex-1 px-2 text-xs"
                onClick={confirmPending}
              >
                Confirm
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 flex-1 px-2 text-xs"
                onClick={() => setPendingKey(null)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <DropdownMenuLabel>Account</DropdownMenuLabel>
            {isLegacyUnknown ? (
              <p className="px-2 pb-2 text-xs leading-snug text-muted-foreground">
                This thread was created before account selection was
                available. Choose an account to continue.
              </p>
            ) : null}
            {isUnavailable ? (
              <p className="px-2 pb-2 text-xs leading-snug text-muted-foreground">
                This thread was using{" "}
                {storedAccount ? accountLabel(storedAccount) : "a removed account"}
                , but that account is no longer available. Choose another to
                continue.
              </p>
            ) : null}
            {isNewThread ? (
              <DropdownMenuItem
                onSelect={() => onChange(null)}
                className={cn(
                  "flex items-start justify-between gap-3",
                  LIST_HOVER_TRANSITION,
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">Auto</span>
                  <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                    Let Arc choose a connected account
                  </span>
                </span>
                <Icon
                  name="Check"
                  className={cn(
                    COARSE_POINTER_ICON_SIZE_CLASS,
                    "shrink-0",
                    value === null ? "opacity-100" : "opacity-0",
                  )}
                />
              </DropdownMenuItem>
            ) : null}
            {accounts.map((account) => {
              const identity = accountIdentity(account);
              const isSelected = isResolvedExisting
                ? storedKey === identity
                : value === identity;
              return (
                <DropdownMenuItem
                  key={identity}
                  disabled={account.authState !== "connected"}
                  onSelect={(event) => {
                    if (isResolvedExisting) event.preventDefault();
                    commitSelection(identity);
                  }}
                  className={cn(
                    "flex items-start justify-between gap-3",
                    LIST_HOVER_TRANSITION,
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">
                      {accountLabel(account)}
                    </span>
                    <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                      {account.authState !== "connected"
                        ? disabledReasonFor(account.authState)
                        : (account.email ?? undefined)}
                    </span>
                  </span>
                  <Icon
                    name="Check"
                    className={cn(
                      COARSE_POINTER_ICON_SIZE_CLASS,
                      "shrink-0",
                      isSelected ? "opacity-100" : "opacity-0",
                    )}
                  />
                </DropdownMenuItem>
              );
            })}
            {manageAccountsItem}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
