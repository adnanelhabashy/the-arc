export type ArcVoiceHealthResult =
  | { kind: "healthy"; detail: string }
  | { kind: "unhealthy"; detail: string };

export type ArcVoiceReadinessResult =
  | { kind: "ready"; detail: string }
  | { kind: "timeout"; detail: string };

export interface WaitForArcVoiceReadyArgs {
  check: () => Promise<ArcVoiceHealthResult>;
  timeoutMs: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_READINESS_INTERVAL_MS = 250;

export function defaultArcVoiceSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function waitForArcVoiceReady(
  args: WaitForArcVoiceReadyArgs,
): Promise<ArcVoiceReadinessResult> {
  const now = args.now ?? Date.now;
  const sleep = args.sleep ?? defaultArcVoiceSleep;
  const intervalMs = args.intervalMs ?? DEFAULT_READINESS_INTERVAL_MS;
  const deadline = now() + args.timeoutMs;
  let lastDetail = "no health check completed";

  for (;;) {
    try {
      const result = await args.check();
      if (result.kind === "healthy") {
        return { kind: "ready", detail: result.detail };
      }
      lastDetail = result.detail;
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
    }

    if (now() >= deadline) {
      return { kind: "timeout", detail: lastDetail };
    }

    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
}
