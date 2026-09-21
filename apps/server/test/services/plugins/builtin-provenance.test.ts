import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createConnection,
  getInstalledPlugin,
  migrate,
  upsertInstalledPlugin,
  type DbConnection,
} from "@bb/db";
import type { Logger } from "@bb/logger";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import {
  bundledPluginSourcePresent,
  listBundledPluginRegistrations,
  resolveBuiltinPluginRootPath,
} from "../../../src/services/plugins/builtin-registry.js";
import { testLogger } from "../../helpers/test-app.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";

const logger = testLogger as unknown as Logger;

declare global {
  var __staleBuiltinMarker: number | undefined;
  var __customPathPluginMarker: number | undefined;
}

function bundledSourcePresentInThisCheckout(name: string): boolean {
  return listBundledPluginRegistrations().some(
    (registration) =>
      registration.name === name && bundledPluginSourcePresent(registration),
  );
}

const STALE_MARKER_SOURCE = `export default function plugin() {
  globalThis.__staleBuiltinMarker = (globalThis.__staleBuiltinMarker ?? 0) + 1;
}
`;

async function writeStalePlugin(rootDir: string): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: "stale-external-plugin",
      version: "0.1.0",
      bb: {
        name: "stale-external-plugin",
        description: "Plugin living in another app's bundle.",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), STALE_MARKER_SOURCE);
}

function seedBuiltinRow(
  db: DbConnection,
  args: { id: string; name: string; rootDir: string; enabled: boolean },
) {
  upsertInstalledPlugin(db, {
    id: args.id,
    source: `builtin:${args.name}`,
    provenance: { kind: "builtin" },
    sourceIntent: { kind: "builtin", name: args.name },
    exactResolution: { kind: "builtin" },
    updateState: {
      lastCheckAt: null,
      availableCompatibleVersion: null,
      newestIncompatibleVersion: null,
      statusDetail: null,
    },
    activeArtifactId: null,
    rootDir: args.rootDir,
    version: "0.1.0",
    enabled: args.enabled,
  });
}

describe("builtin plugin runtime provenance", () => {
  let db: DbConnection;
  let workDir: string;
  let service: PluginService;

  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "bb-builtin-provenance-"));
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(workDir, "data"),
      appVersion: "0.9.0",
      loadTimeoutMs: 2000,
    });
  });

  afterEach(async () => {
    await service.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  it(
    "loads a builtin plugin registered at this installation's trusted root",
    async () => {
      const trustedRoot = resolveBuiltinPluginRootPath("keep-awake");
      seedBuiltinRow(db, {
        id: "keep-awake",
        name: "keep-awake",
        rootDir: trustedRoot,
        enabled: true,
      });

      await service.start();

      expect(
        service.list().find((entry) => entry.id === "keep-awake")?.status,
      ).toBe("running");
      expect(getInstalledPlugin(db, "keep-awake")?.rootDir).toBe(trustedRoot);
    },
    30_000,
  );

  it(
    "refuses a stale external builtin location and never executes it",
    async () => {
      const staleRoot = join(workDir, "bb-original.app", "builtin-plugins");
      await writeStalePlugin(staleRoot);
      seedBuiltinRow(db, {
        id: "keep-awake",
        name: "keep-awake",
        rootDir: resolveBuiltinPluginRootPath("keep-awake"),
        enabled: true,
      });

      await service.start();
      expect(
        service.list().find((entry) => entry.id === "keep-awake")?.status,
      ).toBe("running");

      seedBuiltinRow(db, {
        id: "keep-awake",
        name: "keep-awake",
        rootDir: staleRoot,
        enabled: true,
      });
      globalThis.__staleBuiltinMarker = 0;

      await service.reload("keep-awake");

      expect(globalThis.__staleBuiltinMarker).toBe(0);
      expect(
        service.list().find((entry) => entry.id === "keep-awake")?.status,
      ).toBe("running");
      expect(
        getInstalledPlugin(db, "keep-awake")?.rootDir,
      ).not.toBe(staleRoot);
    },
    30_000,
  );

  it(
    "fails closed when the builtin source is absent from this installation",
    async () => {
      expect(bundledSourcePresentInThisCheckout("pdf-preview")).toBe(false);
      const staleRoot = join(workDir, "bb-original.app", "builtin-plugins");
      await writeStalePlugin(staleRoot);
      seedBuiltinRow(db, {
        id: "pdf-preview",
        name: "pdf-preview",
        rootDir: staleRoot,
        enabled: true,
      });
      globalThis.__staleBuiltinMarker = 0;

      await service.start();

      expect(globalThis.__staleBuiltinMarker).toBe(0);
      expect(getInstalledPlugin(db, "pdf-preview")?.enabled).toBe(false);
      expect(
        service.list().find((entry) => entry.id === "pdf-preview")?.status,
      ).toBe("disabled");

      await service.setEnabled("pdf-preview", true);

      expect(globalThis.__staleBuiltinMarker).toBe(0);
      expect(getInstalledPlugin(db, "pdf-preview")?.enabled).toBe(false);
      expect(
        service.list().find((entry) => entry.id === "pdf-preview")?.status,
      ).not.toBe("running");
    },
    30_000,
  );

  it(
    "keeps a stale connect row from another app inert",
    async () => {
      expect(bundledSourcePresentInThisCheckout("connect")).toBe(false);
      const staleRoot = join(
        workDir,
        "bb-original.app",
        "builtin-plugins",
        "connect",
      );
      await writeStalePlugin(staleRoot);
      seedBuiltinRow(db, {
        id: "connect",
        name: "connect",
        rootDir: staleRoot,
        enabled: true,
      });
      globalThis.__staleBuiltinMarker = 0;

      await service.start();

      expect(globalThis.__staleBuiltinMarker).toBe(0);
      expect(getInstalledPlugin(db, "connect")?.enabled).toBe(false);
      expect(
        service.list().find((entry) => entry.id === "connect")?.status,
      ).toBe("disabled");

      await service.setEnabled("connect", true);

      expect(globalThis.__staleBuiltinMarker).toBe(0);
      expect(getInstalledPlugin(db, "connect")?.enabled).toBe(false);
      expect(
        service.list().find((entry) => entry.id === "connect")?.status,
      ).not.toBe("running");
    },
    30_000,
  );

  it(
    "leaves legitimate external path plugins untouched",
    async () => {
      const rootDir = join(workDir, "custom-plugin");
      await mkdir(rootDir, { recursive: true });
      await writeFile(
        join(rootDir, "package.json"),
        JSON.stringify({
          name: "custom-plugin",
          version: "0.1.0",
          bb: {
            name: "custom-plugin",
            description: "User-installed plugin outside any app bundle.",
            branding: { icon: "Zap" },
            server: "./server.ts",
          },
        }),
      );
      await writeFile(
        join(rootDir, "server.ts"),
        `export default function plugin() {
          globalThis.__customPathPluginMarker =
            (globalThis.__customPathPluginMarker ?? 0) + 1;
        }
        `,
      );
      upsertInstalledPlugin(db, {
        id: "custom-plugin",
        source: `path:${rootDir}`,
        provenance: { kind: "direct" },
        sourceIntent: { kind: "path", canonicalPath: rootDir },
        exactResolution: { kind: "path" },
        updateState: {
          lastCheckAt: null,
          availableCompatibleVersion: null,
          newestIncompatibleVersion: null,
          statusDetail: null,
        },
        activeArtifactId: null,
        rootDir,
        version: "0.1.0",
        enabled: true,
      });
      globalThis.__customPathPluginMarker = 0;

      await service.start();

      const entry = service
        .list()
        .find((candidate) => candidate.id === "custom-plugin");
      expect(entry?.status, entry?.statusDetail ?? undefined).toBe("running");
      expect(globalThis.__customPathPluginMarker).toBe(1);
    },
    30_000,
  );
});
