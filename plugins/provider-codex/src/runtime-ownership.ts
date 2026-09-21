// Installation maintenance for a provider whose runtime the host application
// supplies.
//
// A host application can hand this provider the exact Codex executable to run
// (`BB_CODEX_BRIDGE_APP_SERVER_COMMAND`) instead of letting the provider
// resolve one from the machine's PATH. When it does, the application owns that
// runtime: it installed it, it decides when it updates, and it can roll it
// back. Provider-level installation maintenance would then be wrong twice
// over — it would offer to install or update a *different* binary than the one
// that actually runs, and it would compete with the application's own runtime
// manager.
//
// The declaration is therefore left alone for a standalone bb server (no such
// variable), where the provider is the only thing that knows about the CLI.
export function codexOffersInstallationMaintenance(
  env: NodeJS.ProcessEnv,
): boolean {
  const command = env.BB_CODEX_BRIDGE_APP_SERVER_COMMAND?.trim();
  return command === undefined || command.length === 0;
}
