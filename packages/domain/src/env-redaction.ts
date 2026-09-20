const REDACTION_WORDS = new Set([
  "TOKEN",
  "TOKENS",
  "SECRET",
  "SECRETS",
  "PASSWORD",
  "PASSWD",
  "CREDENTIAL",
  "CREDENTIALS",
  "APIKEY",
  "APIKEYS",
  "KEY",
]);

const REDACTED_ENV_NAMES = new Set([
  "AUTHORIZATION",
  "PROXY_AUTHORIZATION",
  "COOKIE",
  "SET_COOKIE",
]);

const REDACTED_ENV_NAME_SUFFIXES = ["_AUTH", "_COOKIE"];

export const ENV_REDACTION_REASON = "value withheld: credential-shaped name";

export function isSensitiveEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (REDACTED_ENV_NAMES.has(upper)) return true;
  if (
    REDACTED_ENV_NAME_SUFFIXES.some((suffix) => upper.endsWith(suffix))
  ) {
    return true;
  }
  return upper
    .split(/[^A-Z0-9]+/u)
    .filter((word) => word.length > 0)
    .some((word) => REDACTION_WORDS.has(word));
}

export function redactEnvValue(
  name: string,
  value: string,
): string | { masked: true } {
  return isSensitiveEnvName(name) ? { masked: true } : value;
}
