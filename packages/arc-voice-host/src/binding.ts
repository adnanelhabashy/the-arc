export const ARC_VOICE_LOOPBACK_HOST = "127.0.0.1";
export const ARC_VOICE_LOOPBACK_PORT = 47873;

const LOOPBACK_HOSTS: Readonly<Record<string, true>> = {
  "127.0.0.1": true,
  "::1": true,
  "[::1]": true,
};

export class ArcVoiceLoopbackViolationError extends Error {
  readonly host: string;

  constructor(host: string) {
    super(
      `Arc voice runtime must bind to loopback only; refused host ${JSON.stringify(host)}`,
    );
    this.name = "ArcVoiceLoopbackViolationError";
    this.host = host;
  }
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS[host.trim().toLowerCase()] === true;
}

export function assertLoopbackHost(host: string): string {
  if (!isLoopbackHost(host)) {
    throw new ArcVoiceLoopbackViolationError(host);
  }
  return host;
}

export function assertArcVoicePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`Arc voice port must be 1-65535, received ${port}`);
  }
  return port;
}

function hostForUrl(host: string): string {
  const bare = host.replace(/^\[/, "").replace(/\]$/, "");
  return bare.includes(":") ? `[${bare}]` : bare;
}

export function buildArcVoiceBaseUrl(args: {
  host: string;
  port: number;
}): string {
  const host = assertLoopbackHost(args.host);
  return `http://${hostForUrl(host)}:${assertArcVoicePort(args.port)}`;
}

export function assertLoopbackUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ArcVoiceLoopbackViolationError(url);
  }
  assertLoopbackHost(parsed.hostname);
  return url;
}
