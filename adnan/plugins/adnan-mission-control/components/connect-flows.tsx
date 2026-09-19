// Connect flows (Phase 10): ChatGPT device login, Claude OAuth paste, and the
// OMP provider picker. Authentication always happens on the vendor's page —
// Arc never asks for a password. API keys take the single submit path and are
// cleared from the input immediately, never persisted.
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { ArcOmpLoginChallenge, ArcOmpProvider, ArcOpenAiLoginChallenge } from "@/lib/arc-types";
import { useArcLogin, useArcOmpProviders } from "@/lib/data";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/common";
import { cn } from "@/lib/utils";

function openExternal(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

// ─── ChatGPT device login ──────────────────────────────────────────────────

type ChatGptPhase = "starting" | "waiting" | "expired" | "failed" | "cancelled";

export function ChatGptConnectDialog({
  open,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}) {
  const { openaiStart, openaiPoll, openaiCancel } = useArcLogin();
  const [challenge, setChallenge] = useState<ArcOpenAiLoginChallenge | null>(null);
  const [phase, setPhase] = useState<ChatGptPhase>("starting");
  const [message, setMessage] = useState<string | null>(null);

  const start = useCallback(async () => {
    setPhase("starting");
    setMessage(null);
    try {
      setChallenge(await openaiStart());
      setPhase("waiting");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setPhase("failed");
    }
  }, [openaiStart]);

  useEffect(() => {
    if (open) void start();
  }, [open, start]);

  useEffect(() => {
    if (!open || phase !== "waiting" || challenge === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      try {
        const result = await openaiPoll(challenge.sessionId);
        if (cancelled) return;
        if (result.poll.state === "connected") {
          toast.success("ChatGPT account connected.");
          onConnected();
          onOpenChange(false);
          return;
        }
        if (result.poll.state === "failed") {
          setMessage(result.poll.message ?? "Authorization failed.");
          setPhase("failed");
          return;
        }
        if (result.state === "expired") {
          setPhase("expired");
          return;
        }
        if (result.state === "cancelled") {
          setPhase("cancelled");
          return;
        }
        timer = setTimeout(tick, challenge.intervalMs);
      } catch (error) {
        if (cancelled) return;
        setMessage(error instanceof Error ? error.message : String(error));
        setPhase("failed");
      }
    };
    timer = setTimeout(tick, challenge.intervalMs);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [open, phase, challenge, openaiPoll, onConnected, onOpenChange]);

  function cancel() {
    if (challenge !== null) void openaiCancel(challenge.sessionId).catch(() => {});
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Connect ChatGPT</DialogTitle>
          <DialogDescription>Sign in on OpenAI&apos;s page; Arc only receives the resulting account.</DialogDescription>
        </DialogHeader>

        {phase === "starting" ? (
          <p className="text-sm text-muted-foreground">Starting…</p>
        ) : phase === "waiting" && challenge !== null ? (
          <div className="space-y-3">
            <p className="text-sm">
              Open the OpenAI sign-in page and enter:{" "}
              <span className="font-mono text-base font-semibold tracking-widest">{challenge.userCode}</span>
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => openExternal(challenge.verificationUri)}>
                Open Sign-In Page
              </Button>
              <Button variant="ghost" size="sm" onClick={cancel}>
                Cancel
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Waiting for authorization…</p>
          </div>
        ) : phase === "expired" ? (
          <div className="space-y-3">
            <p className="text-sm text-amber-400">Code expired</p>
            <Button size="sm" onClick={() => void start()}>
              Try Again
            </Button>
          </div>
        ) : phase === "cancelled" ? (
          <p className="text-sm text-muted-foreground">Cancelled.</p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-red-400">Authorization failed</p>
            {message !== null ? <p className="text-xs text-muted-foreground">{message}</p> : null}
            <Button size="sm" onClick={() => void start()}>
              Try Again
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Claude OAuth paste ────────────────────────────────────────────────────

export function ClaudeConnectDialog({
  open,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}) {
  const { claudeStart, claudeComplete } = useArcLogin();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    setError(null);
    try {
      const challenge = await claudeStart();
      setSessionId(challenge.sessionId);
      setAuthorizeUrl(challenge.authorizeUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [claudeStart]);

  useEffect(() => {
    if (open) {
      setSessionId(null);
      setAuthorizeUrl(null);
      setPasted("");
      void start();
    }
  }, [open, start]);

  async function complete() {
    if (sessionId === null || pasted.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      await claudeComplete(sessionId, pasted.trim());
      toast.success("Claude account connected.");
      onConnected();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Connect Claude</DialogTitle>
          <DialogDescription>Authentication happens on Anthropic&apos;s page — Arc never asks for a password.</DialogDescription>
        </DialogHeader>

        {error !== null ? (
          <div className="space-y-3">
            <p className="text-sm text-red-400">Sign-in failed</p>
            <p className="text-xs text-muted-foreground">{error}</p>
            <Button size="sm" onClick={() => void start()}>
              Try Again
            </Button>
          </div>
        ) : authorizeUrl === null ? (
          <p className="text-sm text-muted-foreground">Starting…</p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Continue in your browser…</p>
            <Button size="sm" onClick={() => openExternal(authorizeUrl)}>
              Open Anthropic Sign-In
            </Button>
            <label className="block space-y-1">
              <span className="text-[11px] text-muted-foreground">Paste the callback URL from your browser</span>
              <Input value={pasted} onChange={(event) => setPasted(event.target.value)} placeholder="https://console.anthropic.com/…" />
            </label>
            <Button size="sm" disabled={busy || pasted.trim() === ""} onClick={() => void complete()}>
              {busy ? "Completing…" : "Complete Sign-In"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── OMP provider picker ───────────────────────────────────────────────────

type OmpLoginPhase = "picking" | "starting" | "oauth" | "api-key" | "failed";

export const AUTH_METHOD_LABEL: Record<ArcOmpProvider["authMethod"], string> = {
  oauth: "OAuth",
  "api-key": "API key",
  unknown: "Auth",
};

const CONNECTION_LABEL: Record<ArcOmpProvider["connectionState"], string> = {
  connected: "Connected",
  "not-connected": "Not connected",
  unknown: "Unknown",
};

export function OmpProviderPickerDialog({
  open,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}) {
  const { providers } = useArcOmpProviders();
  const { ompStart, ompPoll, ompCancel, ompSubmitKey } = useArcLogin();
  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState<OmpLoginPhase>("picking");
  const [challenge, setChallenge] = useState<ArcOmpLoginChallenge | null>(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const list = providers ?? [];
    const needle = query.trim().toLowerCase();
    if (needle === "") return list;
    return list.filter(
      (provider) =>
        provider.displayName.toLowerCase().includes(needle) ||
        provider.id.toLowerCase().includes(needle),
    );
  }, [providers, query]);

  function reset() {
    setQuery("");
    setPhase("picking");
    setChallenge(null);
    setKey("");
    setError(null);
    setBusy(false);
  }

  useEffect(() => {
    if (!open) reset();
  }, [open]);

  async function startLogin(provider: ArcOmpProvider) {
    setPhase("starting");
    setError(null);
    try {
      const started = await ompStart(provider.id);
      setChallenge(started);
      setPhase(started.kind === "oauth" ? "oauth" : "api-key");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("failed");
    }
  }

  useEffect(() => {
    if (phase !== "oauth" || challenge === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      try {
        const poll = await ompPoll(challenge.sessionId);
        if (cancelled) return;
        if (poll.state === "connected") {
          toast.success("Provider connected.");
          onConnected();
          onOpenChange(false);
          return;
        }
        if (poll.state === "failed") {
          setError(poll.message ?? "Authorization failed.");
          setPhase("failed");
          return;
        }
        timer = setTimeout(tick, 2_000);
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setPhase("failed");
      }
    };
    timer = setTimeout(tick, 2_000);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [phase, challenge, ompPoll, onConnected, onOpenChange]);

  async function submitKey() {
    if (challenge === null || key === "") return;
    setBusy(true);
    setError(null);
    const submitted = key;
    try {
      await ompSubmitKey(challenge.sessionId, submitted);
      setKey("");
      toast.success("Provider connected.");
      onConnected();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    if (challenge !== null) void ompCancel(challenge.sessionId).catch(() => {});
    setPhase("picking");
    setChallenge(null);
  }

  const visible = filtered.slice(0, 50);
  const hiddenCount = filtered.length - visible.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Connect a provider</DialogTitle>
          <DialogDescription>Choose an OMP provider to authenticate.</DialogDescription>
        </DialogHeader>

        {phase === "picking" ? (
          <div className="space-y-2">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search providers…"
              autoFocus
            />
            <ul className="max-h-72 space-y-0.5 overflow-y-auto">
              {visible.map((provider) => (
                <li key={provider.id}>
                  <button
                    type="button"
                    onClick={() => void startLogin(provider)}
                    disabled={provider.connectionState === "connected"}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/60 disabled:opacity-50"
                  >
                    <span className="flex-1 truncate">{provider.displayName}</span>
                    <Chip>{AUTH_METHOD_LABEL[provider.authMethod]}</Chip>
                    <span className={cn("w-24 text-right text-[11px]", provider.connectionState === "connected" ? "text-emerald-400" : "text-muted-foreground")}>
                      {CONNECTION_LABEL[provider.connectionState]}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {hiddenCount > 0 ? (
              <p className="text-[11px] text-muted-foreground">{hiddenCount} more — keep typing</p>
            ) : null}
          </div>
        ) : phase === "starting" ? (
          <p className="text-sm text-muted-foreground">Starting…</p>
        ) : phase === "oauth" && challenge !== null ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Continue in your browser…</p>
            {challenge.authorizeUrl !== null ? (
              <Button size="sm" onClick={() => openExternal(challenge.authorizeUrl as string)}>
                Open Authorization Page
              </Button>
            ) : null}
            {challenge.instructions !== null ? <p className="text-xs text-muted-foreground">{challenge.instructions}</p> : null}
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={cancel}>
                Cancel
              </Button>
            </div>
          </div>
        ) : phase === "api-key" && challenge !== null ? (
          <div className="space-y-3">
            {challenge.instructions !== null ? <p className="text-xs text-muted-foreground">{challenge.instructions}</p> : null}
            <label className="block space-y-1">
              <span className="text-[11px] text-muted-foreground">API key</span>
              <Input
                type="password"
                autoComplete="off"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder="Paste your API key"
              />
            </label>
            <div className="flex gap-2">
              <Button size="sm" disabled={busy || key === ""} onClick={() => void submitKey()}>
                {busy ? "Connecting…" : "Connect"}
              </Button>
              <Button variant="ghost" size="sm" onClick={cancel}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-red-400">Sign-in failed</p>
            {error !== null ? <p className="text-xs text-muted-foreground">{error}</p> : null}
            <Button size="sm" onClick={reset}>
              Back
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
