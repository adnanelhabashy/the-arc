# Arc Agent — Third-Party Notices

## OpenAI Codex

Arc Agent bundles the OpenAI Codex command-line runtime so users can run the
Codex coding agent without installing anything globally.

- Component: OpenAI Codex CLI (rust build)
- Bundled version: 0.155.1
- Release tag: rust-v0.155.1
- Source: https://github.com/openai/codex
- Downloaded from: https://github.com/openai/codex/releases/download/rust-v0.155.1/codex-aarch64-apple-darwin.tar.gz
- License: Apache License 2.0 (see below)
- Upstream copyright: Copyright 2025 OpenAI

Arc also bundles the Codex Code Mode host, a first-party companion binary
published in the same release and version-locked to it:

- Component: codex-code-mode-host (rust build, `codex-rs/code-mode-host`)
- Bundled version: 0.155.1 (identical to the Codex CLI above; never released
  independently)
- Release tag: rust-v0.155.1
- Downloaded from: https://github.com/openai/codex/releases/download/rust-v0.155.1/codex-code-mode-host-aarch64-apple-darwin.tar.gz
- License: Apache License 2.0 (see below)
- Upstream copyright: Copyright 2025 OpenAI

Arc stages it beside the managed `codex` executable, in the same version
directory, which is where Codex looks for it; Arc never installs it on PATH.

Arc copies the verified executable to a per-user managed location on first
launch and executes that copy. The signed application bundle seed is treated
as read-only.

### Apache License 2.0

The bundled Codex executable is licensed under the Apache License, Version 2.0
(January 2004). The full license text is available at
https://www.apache.org/licenses/LICENSE-2.0 and in the upstream repository at
https://github.com/openai/codex/blob/rust-v0.155.1/LICENSE.

### Upstream NOTICE (preserved verbatim)

OpenAI Codex
Copyright 2025 OpenAI

This project includes code derived from Ratatui (https://github.com/ratatui/ratatui), licensed under the MIT license.
Copyright (c) 2016-2022 Florian Dehau
Copyright (c) 2023-2025 The Ratatui Developers
