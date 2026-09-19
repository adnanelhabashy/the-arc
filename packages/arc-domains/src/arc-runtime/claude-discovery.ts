import { constants } from "node:fs";
import {
  access,
  lstat,
  readFile,
  readlink,
  realpath,
  stat,
} from "node:fs/promises";
import { join } from "node:path";

export type ClaudeInstallClassification =
  | { kind: "not-installed" }
  | { kind: "arc-managed"; executablePath: string; version: string | null }
  | { kind: "official-native"; executablePath: string; version: string | null }
  | { kind: "homebrew"; executablePath: string; version: string | null }
  | { kind: "npm-legacy"; executablePath: string; version: string | null }
  | { kind: "explicit-override"; executablePath: string; version: string | null }
  | { kind: "broken-launcher"; launcherPath: string };

export interface DiscoverClaudeInstallArgs {
  arcRuntimeRoot: string;
  env?: NodeJS.ProcessEnv;
  homeDirectory: string;
  isRunnable: (path: string) => Promise<boolean>;
  probeVersion: (path: string) => Promise<string | null>;
}

const NATIVE_LAUNCHER_PATH_SEGMENTS = [".local", "bin", "claude"] as const;
const NATIVE_VERSIONS_DIR_SEGMENTS = [".local", "share", "claude", "versions"] as const;

async function pathKind(
  path: string,
  isRunnable: (path: string) => Promise<boolean>,
): Promise<"missing" | "broken" | "runnable"> {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) {
      return "broken";
    }
  } catch {
    return "missing";
  }
  if (!(await isRunnable(path))) {
    return "broken";
  }
  return "runnable";
}

async function resolveLauncherTarget(launcherPath: string): Promise<string | null> {
  try {
    const target = await readlink(launcherPath);
    if (target.startsWith("/")) {
      return target;
    }
    return join(launcherPath, "..", target);
  } catch {
    return null;
  }
}

async function launcherIsNpmWrapper(launcherPath: string): Promise<boolean> {
  try {
    const head = await readFile(launcherPath, "utf8");
    return (
      head.includes("@anthropic-ai/claude-code") ||
      head.includes("node_modules")
    );
  } catch {
    return false;
  }
}

function pathIsWithin(child: string, parent: string): boolean {
  const normalizedChild = child.replace(/\/+$/, "");
  const normalizedParent = parent.replace(/\/+$/, "");
  return (
    normalizedChild === normalizedParent ||
    normalizedChild.startsWith(`${normalizedParent}/`)
  );
}

async function classifyRunnable(
  executablePath: string,
  args: DiscoverClaudeInstallArgs,
  kind:
    | "official-native"
    | "homebrew"
    | "npm-legacy"
    | "explicit-override"
    | "arc-managed",
): Promise<ClaudeInstallClassification> {
  return {
    kind,
    executablePath,
    version: await args.probeVersion(executablePath),
  };
}

export async function discoverClaudeInstall(
  args: DiscoverClaudeInstallArgs,
): Promise<ClaudeInstallClassification> {
  const env = args.env ?? process.env;
  const versionsRoot = join(
    args.homeDirectory,
    ...NATIVE_VERSIONS_DIR_SEGMENTS,
  );

  const explicitOverride = env.BB_CLAUDE_CODE_EXECUTABLE?.trim();
  if (explicitOverride !== undefined && explicitOverride.length > 0) {
    const overrideState = await pathKind(explicitOverride, args.isRunnable);
    if (overrideState === "runnable") {
      if (pathIsWithin(explicitOverride, args.arcRuntimeRoot)) {
        return classifyRunnable(explicitOverride, args, "arc-managed");
      }
      return classifyRunnable(explicitOverride, args, "explicit-override");
    }
    return { kind: "broken-launcher", launcherPath: explicitOverride };
  }

  const launcherPath = join(args.homeDirectory, ...NATIVE_LAUNCHER_PATH_SEGMENTS);
  const launcherState = await pathKind(launcherPath, args.isRunnable);
  if (launcherState === "broken") {
    return { kind: "broken-launcher", launcherPath };
  }
  if (launcherState === "missing") {
    // A dangling launcher symlink is a broken install, not "not installed":
    // something placed the launcher and its target vanished (§34).
    const launcherLinkExists = await lstat(launcherPath)
      .then((stats) => stats.isSymbolicLink())
      .catch(() => false);
    if (launcherLinkExists) {
      return { kind: "broken-launcher", launcherPath };
    }
  }
  if (launcherState === "runnable") {
    const linkTarget = await resolveLauncherTarget(launcherPath);
    if (linkTarget === null) {
      // Regular file at the launcher path: a custom launcher script (official
      // custom-launcher pattern) or a legacy npm global wrapper.
      if (await launcherIsNpmWrapper(launcherPath)) {
        return classifyRunnable(launcherPath, args, "npm-legacy");
      }
      return classifyRunnable(launcherPath, args, "official-native");
    }
    const resolved = await realpath(linkTarget).catch(() => linkTarget);
    if (pathIsWithin(resolved, versionsRoot)) {
      return classifyRunnable(resolved, args, "official-native");
    }
    if (
      pathIsWithin(resolved, "/opt/homebrew") ||
      pathIsWithin(resolved, "/usr/local")
    ) {
      return classifyRunnable(resolved, args, "homebrew");
    }
    if (pathIsWithin(resolved, args.homeDirectory)) {
      return classifyRunnable(resolved, args, "official-native");
    }
    return classifyRunnable(resolved, args, "official-native");
  }

  for (const prefix of ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"]) {
    if ((await pathKind(prefix, args.isRunnable)) === "runnable") {
      return classifyRunnable(prefix, args, "homebrew");
    }
  }

  return { kind: "not-installed" };
}

export interface ClaudeDiscoverySummary {
  classification: ClaudeInstallClassification;
  nativeVersionsPresent: string[];
}

export async function summarizeClaudeDiscovery(
  args: DiscoverClaudeInstallArgs & {
    listDirectoryNames: (path: string) => Promise<string[]>;
  },
): Promise<ClaudeDiscoverySummary> {
  const classification = await discoverClaudeInstall(args);
  const versionsRoot = join(
    args.homeDirectory,
    ...NATIVE_VERSIONS_DIR_SEGMENTS,
  );
  const nativeVersionsPresent = await args
    .listDirectoryNames(versionsRoot)
    .catch(() => [] as string[]);
  return { classification, nativeVersionsPresent };
}

export async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) {
      return false;
    }
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
