import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverClaudeInstall,
  isExecutableFile,
} from "../src/arc-runtime/claude-discovery.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arc-claude-discovery-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface Fixture {
  home: string;
  arcRuntimeRoot: string;
}

async function makeFixture(): Promise<Fixture> {
  const root = await tempDir();
  const home = join(root, "home");
  const arcRuntimeRoot = join(root, "userData", "arc-runtimes");
  await mkdir(home, { recursive: true });
  return { home, arcRuntimeRoot };
}

function discoveryArgs(fixture: Fixture, env?: NodeJS.ProcessEnv) {
  return {
    arcRuntimeRoot: fixture.arcRuntimeRoot,
    env,
    homeDirectory: fixture.home,
    isRunnable: isExecutableFile,
    probeVersion: async (path: string) =>
      `2.1.276@${path.endsWith("claude") ? "ok" : "odd"}`,
  };
}

async function writeExecutable(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
}

const launcherPath = (home: string) => join(home, ".local", "bin", "claude");

describe("discoverClaudeInstall", () => {
  it("classifies a machine with no Claude as not-installed", async () => {
    const fixture = await makeFixture();
    const result = await discoverClaudeInstall(discoveryArgs(fixture));
    expect(result.kind).toBe("not-installed");
  });

  it("classifies the official native symlink launcher", async () => {
    const fixture = await makeFixture();
    const versioned = join(
      fixture.home,
      ".local",
      "share",
      "claude",
      "versions",
      "2.1.276",
    );
    await writeExecutable(versioned, "#!/bin/sh\n");
    await mkdir(dirname(launcherPath(fixture.home)), { recursive: true });
    await symlink(versioned, launcherPath(fixture.home));
    const expectedPath = await realpath(versioned);

    const result = await discoverClaudeInstall(discoveryArgs(fixture));
    expect(result).toMatchObject({
      kind: "official-native",
      executablePath: expectedPath,
      version: expect.stringContaining("2.1.276"),
    });
  });

  it("classifies a broken launcher whose target is missing", async () => {
    const fixture = await makeFixture();
    await mkdir(dirname(launcherPath(fixture.home)), { recursive: true });
    await symlink(
      join(fixture.home, ".local", "share", "claude", "versions", "9.9.9"),
      launcherPath(fixture.home),
    );

    const result = await discoverClaudeInstall(discoveryArgs(fixture));
    expect(result).toMatchObject({
      kind: "broken-launcher",
      launcherPath: launcherPath(fixture.home),
    });
  });

  it("classifies an npm legacy wrapper script", async () => {
    const fixture = await makeFixture();
    await writeExecutable(
      launcherPath(fixture.home),
      '#!/bin/sh\nexec node "$HOME/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js" "$@"\n',
    );

    const result = await discoverClaudeInstall(discoveryArgs(fixture));
    expect(result.kind).toBe("npm-legacy");
  });

  it("classifies an explicit BB_CLAUDE_CODE_EXECUTABLE outside Arc as explicit-override", async () => {
    const fixture = await makeFixture();
    const external = join(fixture.home, "custom", "claude");
    await writeExecutable(external, "#!/bin/sh\n");

    const result = await discoverClaudeInstall(
      discoveryArgs(fixture, { BB_CLAUDE_CODE_EXECUTABLE: external }),
    );
    expect(result).toMatchObject({
      kind: "explicit-override",
      executablePath: external,
    });
  });

  it("classifies BB_CLAUDE_CODE_EXECUTABLE inside the Arc runtime root as arc-managed", async () => {
    const fixture = await makeFixture();
    const managed = join(
      fixture.arcRuntimeRoot,
      "runtimes",
      "claude-code",
      "2.1.276",
      "claude",
    );
    await writeExecutable(managed, "#!/bin/sh\n");

    const result = await discoverClaudeInstall(
      discoveryArgs(fixture, { BB_CLAUDE_CODE_EXECUTABLE: managed }),
    );
    expect(result.kind).toBe("arc-managed");
  });

  it("prefers the explicit override over the native launcher", async () => {
    const fixture = await makeFixture();
    const external = join(fixture.home, "custom", "claude");
    await writeExecutable(external, "#!/bin/sh\n");
    const versioned = join(
      fixture.home,
      ".local",
      "share",
      "claude",
      "versions",
      "2.1.276",
    );
    await writeExecutable(versioned, "#!/bin/sh\n");
    await mkdir(dirname(launcherPath(fixture.home)), { recursive: true });
    await symlink(versioned, launcherPath(fixture.home));

    const result = await discoverClaudeInstall(
      discoveryArgs(fixture, { BB_CLAUDE_CODE_EXECUTABLE: external }),
    );
    expect(result.kind).toBe("explicit-override");
  });

  it("classifies a broken explicit override", async () => {
    const fixture = await makeFixture();
    const missing = join(fixture.home, "gone", "claude");
    const result = await discoverClaudeInstall(
      discoveryArgs(fixture, { BB_CLAUDE_CODE_EXECUTABLE: missing }),
    );
    expect(result).toMatchObject({
      kind: "broken-launcher",
      launcherPath: missing,
    });
  });
});
