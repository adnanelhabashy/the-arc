import path from "path";
import { defineWorkspaceTestConfig } from "../../../vitest.shared.js";

// The plugin-sdk's "source" export condition (enabled by vitest.shared.js)
// points at src/*.ts which the installed npm build does not ship. Route the
// sdk entrypoints to their dist builds so component imports resolve in tests.
export default defineWorkspaceTestConfig({
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(__dirname, ".") },
      { find: "@get-bb/plugin-sdk/app", replacement: path.resolve(__dirname, "node_modules/@get-bb/plugin-sdk/dist/app.js") },
      { find: "@get-bb/plugin-sdk", replacement: path.resolve(__dirname, "node_modules/@get-bb/plugin-sdk/dist/index.js") },
    ],
  },
  test: {
    name: "bb-plugin-adnan-mission-control",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
