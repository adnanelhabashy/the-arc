import { defineWorkspaceTestConfig } from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    name: "bb-arc-voice-host",
    include: ["test/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**", "test/integration/**"],
  },
});
