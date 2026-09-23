import { defineWorkspaceTestConfig } from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    name: "bb-arc-voice-host-integration",
    include: ["test/integration/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
