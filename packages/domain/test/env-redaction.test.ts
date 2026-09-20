import { describe, expect, it } from "vitest";
import { isSensitiveEnvName, redactEnvValue } from "../src/env-redaction.js";

describe("env redaction policy", () => {
  it.each([
    "CODEX_POOL_AUTH_TOKEN",
    "BB_ACCOUNT_POOL_PARENT_TOKEN",
    "ANTHROPIC_AUTH_TOKEN",
    "OMP_AUTH_BROKER_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GITHUB_TOKEN",
    "SSH_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "DATABASE_PASSWORD",
    "MY_CREDENTIALS",
    "AUTHORIZATION",
    "HTTP_COOKIE",
    "SERVICE_AUTH",
  ])("treats %s as credential-shaped", (name) => {
    expect(isSensitiveEnvName(name)).toBe(true);
    expect(redactEnvValue(name, "super-secret-value")).toEqual({
      masked: true,
    });
  });

  it.each([
    "PATH",
    "HOME",
    "ANTHROPIC_BASE_URL",
    "CODEX_OPENAI_BASE_URL",
    "OMP_AUTH_BROKER_URL",
    "OMP_AUTH_BROKER_ACCOUNT_POOL_FILE",
    "CODEX_ACCOUNT_POOL_PIN",
    "CODEX_ACCOUNT_POOL_THREAD_ID",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ENABLE_TOOL_SEARCH",
    "BB_THREAD_STORAGE",
    "MONKEY_PATCH_FLAG",
  ])("leaves the harmless name %s alone", (name) => {
    expect(isSensitiveEnvName(name)).toBe(false);
    expect(redactEnvValue(name, "harmless-value")).toBe("harmless-value");
  });
});
