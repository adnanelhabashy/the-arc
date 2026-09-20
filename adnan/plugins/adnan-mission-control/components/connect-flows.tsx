// Connect flows (Phase 10, stabilized in Phase 10.1): ChatGPT device login,
// Claude manual authentication-code entry (the real Claude Code 2.1.x
// protocol: Anthropic's page shows a one-time code, never a callback URL),
// and the OMP provider picker with dynamic login modes (browser OAuth,
// device code, API key). Authentication always happens on the vendor's
// page — Arc never asks for a password. API keys take the single submit
// path and are cleared from the input immediately, never persisted.
//
// Login-session state is owned locally and started exactly once per dialog
// open (or one explicit click for OMP); account-list refreshes and usage
// refreshes in the background never recreate, restart, or unmount these
// flows. Effects depend only on useCallback-stable hook actions and
// session-shaped state, never on per-render callback identities.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { ArcOmpLoginChallenge, ArcOmpProvider, ArcOpenAiLoginChallenge, ArcClaudeLoginChallenge } from "@/lib/arc-types";
import { useArcLogin, useArcOmpProviders } from "@/lib/data";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/common";
import { cn } from "@/lib/utils";

function openExternal(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

// Overall bound for a login attempt the provider does not timestamp itself
// (Claude sessions, OMP sessions). Mirrors the pool's documented 10-minute
// login session TTL.
const UNTIMED_LOGIN_TTL_MS = 10 * 60 * 1_000;

/** Latest-ref: lets long-lived effects call the current props without
 *  listing them as deps (their identities change every parent render; the
 *  effect must not restart for that). */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
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
  const callbacksRef = useLatest({ onConnected, onOpenChange, openaiCancel });

  const start = useCallback(async () => {
    setPhase("starting");
    setMessage(null);
    try {
      const next = await openaiStart();
      setChallenge(next);
      setPhase("waiting");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setPhase("failed");
    }
  }, [openaiStart]);

  // Start exactly once per open transition. `start` is useCallback-stable,
  // and the ref guard additionally collapses any residual identity churn
  // (or StrictMode double effects) into a single provider login attempt.
  const startedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      startedRef.current = false;
      setChallenge(null);
      setPhase("starting");
      setMessage(null);
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
  }, [open, start]);

  useEffect(() => {
    if (!open || phase !== "waiting" || challenge === null) return;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;

    if (challenge.expiresAt > Date.now()) {
      expiryTimer = setTimeout(() => {
        if (!cancelled) setPhase("expired");
      }, challenge.expiresAt - Date.now());
    }

    const tick = async () => {
      if (cancelled) return;
      try {
        const result = await openaiPoll(challenge.sessionId);
        if (cancelled) return;
        if (result.poll.state === "connected") {
          toast.success("ChatGPT account connected.");
          callbacksRef.current.onConnected();
          callbacksRef.current.onOpenChange(false);
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
        pollTimer = setTimeout(tick, challenge.intervalMs);
      } catch (error) {
        if (cancelled) return;
        setMessage(error instanceof Error ? error.message : String(error));
        setPhase("failed");
      }
    };
    pollTimer = setTimeout(tick, challenge.intervalMs);
    return () => {
      cancelled = true;
      clearTimeout(pollTimer);
      clearTimeout(expiryTimer);
    };
  }, [open, phase, challenge, openaiPoll, callbacksRef]);

  function cancel() {
    if (challenge !== null) void callbacksRef.current.openaiCancel(challenge.sessionId).catch(() => {});
    callbacksRef.current.onOpenChange(false);
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

// ─── Claude manual authentication code ─────────────────────────────────────

type ClaudePhase = "starting" | "waiting" | "completing" | "expired" | "failed";

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
  const [challenge, setChallenge] = useState<ArcClaudeLoginChallenge | null>(null);
  const [phase, setPhase] = useState<ClaudePhase>("starting");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const callbacksRef = useLatest({ onConnected, onOpenChange });

  const start = useCallback(async () => {
    setPhase("starting");
    setMessage(null);
    setCode("");
    try {
      const next = await claudeStart();
      setChallenge(next);
      setPhase("waiting");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
      setPhase("failed");
    }
  }, [claudeStart]);

  const startedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      startedRef.current = false;
      setChallenge(null);
      setPhase("starting");
      setCode("");
      setMessage(null);
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
  }, [open, start]);

  // The pool does not expose its Claude session TTL; bound the attempt with
  // the same documented 10-minute login session limit.
  useEffect(() => {
    if (!open || phase !== "waiting" || challenge === null) return;
    const timer = setTimeout(() => setPhase("expired"), UNTIMED_LOGIN_TTL_MS);
    return () => clearTimeout(timer);
  }, [open, phase, challenge]);

  async function complete() {
    const entered = code.trim();
    if (challenge === null || entered === "") return;
    // The one-time code lives only in this call: never stored, never logged.
    setCode("");
    setPhase("completing");
    try {
      await claudeComplete(challenge.sessionId, entered);
      toast.success("Claude account connected.");
      callbacksRef.current.onConnected();
      callbacksRef.current.onOpenChange(false);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
      setPhase("failed");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Connect Claude</DialogTitle>
          <DialogDescription>Authentication happens on Anthropic&apos;s page — Arc never asks for a password.</DialogDescription>
        </DialogHeader>

        {phase === "starting" ? (
          <p className="text-sm text-muted-foreground">Starting…</p>
        ) : phase === "expired" ? (
          <div className="space-y-3">
            <p className="text-sm text-amber-400">Authorization expired</p>
            <Button size="sm" onClick={() => void start()}>
              Try Again
            </Button>
          </div>
        ) : phase === "failed" ? (
          <div className="space-y-3">
            <p className="text-sm text-red-400">Sign-in failed</p>
            {message !== null ? <p className="text-xs text-muted-foreground">{message}</p> : null}
            <Button size="sm" onClick={() => void start()}>
              Try Again
            </Button>
          </div>
        ) : (
          challenge !== null && (
            <div className="space-y-3">
              <ol className="list-decimal space-y-2 pl-4 text-sm text-muted-foreground">
                <li>
                  Open Anthropic sign-in.
                  <div className="mt-1.5">
                    <Button size="sm" onClick={() => openExternal(challenge.authorizeUrl)}>
                      Open Anthropic Sign-In
                    </Button>
                  </div>
                </li>
                <li>After signing in, Anthropic will show an authentication code.</li>
              </ol>
              <label className="block space-y-1">
                <span className="text-[11px] text-muted-foreground">Authentication code</span>
                <Input
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void complete();
                  }}
                  placeholder="Paste the code shown on Anthropic's page"
                  autoComplete="off"
                />
              </label>
              <div className="flex gap-2">
                <Button size="sm" disabled={phase === "completing" || code.trim() === ""} onClick={() => void complete()}>
                  {phase === "completing" ? "Completing sign-in…" : "Complete Sign-In"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => callbacksRef.current.onOpenChange(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── OMP provider picker ───────────────────────────────────────────────────

type OmpLoginPhase = "picking" | "starting" | "oauth" | "device" | "api-key" | "failed" | "expired";

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

// Dynamic login-mode classification. The broker decides the flow per
// provider at login time (browser OAuth redirect, OAuth device code, or
// API key prompt); Arc reacts to what the session actually is. `flow` is
// the backend classification; the fallbacks keep older brokers readable.
function loginMode(challenge: ArcOmpLoginChallenge): "api-key" | "device" | "oauth" {
  if (challenge.kind === "api-key") return "api-key";
  if (challenge.flow === "device") return "device";
  if (challenge.userCode !== null) return "device";
  if (challenge.authorizeUrl !== null && /[?&]user_code=/.test(challenge.authorizeUrl)) return "device";
  if (challenge.instructions !== null && /enter code/i.test(challenge.instructions)) return "device";
  return "oauth";
}

function OmpDeviceFlow({ challenge, onCancel }: { challenge: ArcOmpLoginChallenge; onCancel: () => void }) {
  const url = challenge.authorizeUrl;
  const code = challenge.userCode;
  const instructions = challenge.instructions;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        A browser page opens the provider&apos;s sign-in. Sign in to your account there — the page then shows
        this code with a confirm button. Press confirm to finish; nothing needs to be typed into Arc.
      </p>
      {code !== null ? (
        <p className="text-sm">
          Code: <span className="font-mono text-base font-semibold tracking-widest">{code}</span>
        </p>
      ) : null}
      {url !== null ? (
        <Button size="sm" onClick={() => openExternal(url)}>
          Open Authorization Page
        </Button>
      ) : null}
      {code === null && instructions !== null ? (
        <p className="whitespace-pre-line text-xs text-muted-foreground">{instructions}</p>
      ) : null}
      <p className="text-xs text-muted-foreground">Waiting for authorization…</p>
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function OmpBrowserFlow({ challenge, onCancel }: { challenge: ArcOmpLoginChallenge; onCancel: () => void }) {
  const url = challenge.authorizeUrl;
  const instructions = challenge.instructions;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Continue in your browser…</p>
      {url !== null ? (
        <Button size="sm" onClick={() => openExternal(url)}>
          Open Authorization Page
        </Button>
      ) : null}
      {instructions !== null ? <p className="text-xs text-muted-foreground">{instructions}</p> : null}
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

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
  const callbacksRef = useLatest({ onConnected, onOpenChange, ompCancel });

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

  // Close/reset is keyed only on `open`: account and provider refreshes
  // re-render this dialog but must never touch an active login session.
  useEffect(() => {
    if (open) return;
    setQuery("");
    setPhase("picking");
    setChallenge(null);
    setKey("");
    setError(null);
    setBusy(false);
  }, [open]);

  async function startLogin(provider: ArcOmpProvider) {
    setPhase("starting");
    setError(null);
    try {
      const started = await ompStart(provider.id);
      setChallenge(started);
      const mode = loginMode(started);
      setPhase(mode === "oauth" ? "oauth" : mode);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("failed");
    }
  }

  useEffect(() => {
    if ((phase !== "oauth" && phase !== "device") || challenge === null) return;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const expiryTimer = setTimeout(() => {
      if (!cancelled) setPhase("expired");
    }, UNTIMED_LOGIN_TTL_MS);

    const tick = async () => {
      if (cancelled) return;
      try {
        const poll = await ompPoll(challenge.sessionId);
        if (cancelled) return;
        if (poll.state === "connected") {
          toast.success("Provider connected.");
          callbacksRef.current.onConnected();
          callbacksRef.current.onOpenChange(false);
          return;
        }
        if (poll.state === "failed") {
          setError(poll.message ?? "Authorization failed.");
          setPhase("failed");
          return;
        }
        pollTimer = setTimeout(tick, 2_000);
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setPhase("failed");
      }
    };
    pollTimer = setTimeout(tick, 2_000);
    return () => {
      cancelled = true;
      clearTimeout(pollTimer);
      clearTimeout(expiryTimer);
    };
  }, [phase, challenge, ompPoll, callbacksRef]);

  async function submitKey() {
    if (challenge === null || key === "") return;
    setBusy(true);
    setError(null);
    const submitted = key;
    try {
      await ompSubmitKey(challenge.sessionId, submitted);
      setKey("");
      toast.success("Provider connected.");
      callbacksRef.current.onConnected();
      callbacksRef.current.onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function backToPicking() {
    if (challenge !== null) {
      void callbacksRef.current.ompCancel(challenge.sessionId).catch(() => {});
    }
    setPhase("picking");
    setChallenge(null);
    setKey("");
    setError(null);
  }

  const visible = filtered.slice(0, 50);
  const hiddenCount = filtered.length - visible.length;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing mid-login cancels the broker login child where supported;
        // it never starts a new attempt.
        if (!next && challenge !== null && (phase === "oauth" || phase === "device" || phase === "api-key")) {
          void callbacksRef.current.ompCancel(challenge.sessionId).catch(() => {});
          setPhase("picking");
          setChallenge(null);
          setKey("");
        }
        onOpenChange(next);
      }}
    >
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
        ) : phase === "expired" ? (
          <div className="space-y-3">
            <p className="text-sm text-amber-400">Authorization expired</p>
            <p className="text-xs text-muted-foreground">The login attempt timed out before authorization completed.</p>
            <Button size="sm" onClick={backToPicking}>
              Try Again
            </Button>
          </div>
        ) : (phase === "oauth" || phase === "device") && challenge !== null ? (
          phase === "device" ? (
            <OmpDeviceFlow challenge={challenge} onCancel={backToPicking} />
          ) : (
            <OmpBrowserFlow challenge={challenge} onCancel={backToPicking} />
          )
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
              <Button variant="ghost" size="sm" onClick={backToPicking}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-red-400">Sign-in failed</p>
            {error !== null ? <p className="text-xs text-muted-foreground">{error}</p> : null}
            <Button size="sm" onClick={backToPicking}>
              Back
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
