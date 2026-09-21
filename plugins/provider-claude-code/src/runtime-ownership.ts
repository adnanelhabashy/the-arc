// Installation maintenance for a provider whose runtime the host application
// supplies.
//
// A host application can hand this provider the exact Claude Code executable to
// run (`BB_CLAUDE_CODE_EXECUTABLE`) instead of letting the provider resolve one
// from the machine's PATH. When it does, the application owns that runtime: it
// installed it, it decides when it updates, and it can roll it back.
// Provider-level installation maintenance would then be wrong twice over — it
// would offer to install or update a *different* binary than the one that
// actually runs (the machine's npm-global CLI, measured against npm's latest
// tag), and it would compete with the application's own runtime manager.
//
// The declaration is therefore left alone for a standalone bb server (no such
// variable), where the provider is the only thing that knows about the CLI.
export function claudeCodeOffersInstallationMaintenance(
  env: NodeJS.ProcessEnv,
): boolean {
  const executable = env.BB_CLAUDE_CODE_EXECUTABLE?.trim();
  return executable === undefined || executable.length === 0;
}
