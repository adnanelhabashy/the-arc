# BB upstream sync (Phase 13)

How Arc consumes future changes from `get-bb/bb` without a merge silently
undoing Arc-specific architecture (product identity, release ownership,
independent versioning, managed runtimes, account routing, OMP isolation).

## Remotes

```
$ git remote -v
origin    https://github.com/adnanelhabashy/bb.git   (Adnan's own bb fork/staging)
the-arc   https://github.com/adnanelhabashy/the-arc.git (Arc's product/release repo — push target)
upstream  https://github.com/get-bb/bb.git             (fetch-only; push is disabled)
```

`self-contained` (and every other Arc product branch) tracks `the-arc`, never
`upstream`. `upstream`'s push URL is intentionally invalid
(`git remote set-url --push upstream https://do-not-push-to-bb-upstream.invalid/...`)
so a stray `git push upstream` fails immediately instead of writing to BB —
GitHub's token scoping would refuse it anyway in CI, but locally there is no
such backstop, hence the trip wire. To restore a working push URL (there
should be no reason to): `git remote set-url --push upstream https://github.com/get-bb/bb.git`.

`upstream/main` is never trusted Arc code and is never merged directly into
`self-contained`.

## Sync workflow

```
git fetch upstream
  → create upstream-sync/<short-sha> from the current Arc baseline
  → merge or rebase upstream/main into it
  → resolve conflicts
  → run the Arc invariant suite + typecheck + relevant tests
  → review the diff (see "Files that need special review" below)
  → human approval
  → only then merge into self-contained
```

Branch naming: `upstream-sync/<short-sha>`, where `<short-sha>` is the fetched
`upstream/main` commit (`git rev-parse --short upstream/main`). Tied to an
immutable commit rather than a date, so the branch name says exactly what it
contains and two people syncing the same day don't collide.

### Running a sync

```bash
git fetch upstream
SHA=$(git rev-parse --short upstream/main)
git switch -c "upstream-sync/$SHA" the-arc/self-contained
git merge upstream/main   # or: git rebase upstream/main
# resolve conflicts if any
pnpm exec turbo run test typecheck --filter=@bb/scripts   # invariant suite first, it's fast
pnpm exec turbo run build typecheck lint test              # full check once invariants pass
```

If conflicts are large or an Arc invariant fails, **stop** — do not resolve by
overwriting Arc-specific code to make the merge easier, and do not push. Report:
the upstream SHA, files changed, conflict count, which architectural areas
conflicted, which Arc invariants (if any) the merge would have broken, and a
recommended resolution strategy. Get human approval before merging the result
into `self-contained`.

### Aborting a sync

The sync branch is disposable and never pushed on its own:

```bash
git merge --abort      # mid-conflict, before completing the merge commit
# or, to throw the whole attempt away:
git switch the-arc/self-contained
git branch -D upstream-sync/<short-sha>
```

Nothing on `self-contained`, `~/.bb`, or Application Support state is touched
by any of this — the sync branch only ever holds source code.

## Arc invariant suite

`packages/scripts/test/arc-invariants.test.ts` — runs as part of the normal
`packages` test shard in `.github/workflows/ci.yml` (every push and PR), no
separate CI framework. It checks the specific config facts a merge conflict
resolution could silently flip back:

- stable bundle id `io.github.adnanelhabashy.arcagent` / product name `Arc Agent`
- nightly bundle id `io.github.adnanelhabashy.arcagent.nightly` / `Arc Agent Nightly`
- both desktop publish workflows refuse to run outside `adnanelhabashy/the-arc`
- the desktop update feed has no built-in fallback to a BB-controlled URL
- `apps/desktop/arc-version.json` still carries an independent `arcVersion`
  and a `bbUpstreamCommit` (40-hex-char) provenance field
- `apps/desktop/src/main.ts` reads the app version through `getArcAppVersion`,
  never `Electron`'s `app.getVersion()`
- none of the release-identity files above regain `dev.bb.desktop` or a
  literal `get-bb/bb/releases/download` URL
- OMP isolation env vars (`PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR`) are still
  wired in `packages/arc-domains/src/arc-runtime/environment.ts`

It deliberately does **not** re-test runtime management, account routing, or
OMP behavior in depth — those already have their own extensive suites
(`packages/arc-domains`, `plugins/account-pool`, `plugins/provider-acp`, …
— see `adnan/arc-productization/DECISIONS.md` ADR-061 through ADR-084) which
already run in CI and will already fail if a merge breaks that behavior.
Duplicating them here would be redundant, not safer.

It also does not do a tree-wide scan for every historical mention of
`get-bb/bb` or `dev.bb.desktop` — ADRs, docs, and provenance text legitimately
reference BB. The forbidden-regression checks above are scoped to a curated
list of the files that actually carry Arc's release identity, not the whole
repository, so a `git blame`-worthy historical mention in a doc never fails
the suite.

Run it on its own: `pnpm exec turbo run test --filter=@bb/scripts -- arc-invariants`.

## Files that need special review on a sync

No `.gitattributes` merge strategy (`ours`/`theirs`) is applied to any of
these — that would silently discard a real upstream security fix the next
time it touches the same file. They are listed here so a human reviewing a
sync PR's diff knows where to look closely instead:

- `apps/desktop/electron-builder.config.json`, `apps/desktop/scripts/desktop-release-channel.mjs`,
  `apps/desktop/scripts/build.mjs`, `apps/desktop/scripts/run-electron-builder.mjs` — Arc identity/build
- `apps/desktop/src/desktop-update-provider.ts`, `apps/desktop/arc-version.json` — update source, versioning
- `.github/workflows/publish-bb-app.yml`, `.github/workflows/build-desktop.yml` — release workflows
- `packages/arc-domains/src/arc-runtime/**` — managed runtime manifest/activation/rollback
- `plugins/account-pool/**` — Account Pooler, per-thread routing
- `plugins/provider-acp/src/native-roots/omp.ts` — OMP isolation
- `adnan/arc-productization/DECISIONS.md` — ADR log (append-only; a conflict
  here almost always means both sides added ADRs and just needs a renumber,
  not a content resolution)

## BB provenance

`apps/desktop/arc-version.json`'s `bbUpstreamCommit` is a hand-set fact:
"the BB commit this Arc build was forked from / last resynced to." It is set
by hand, once, **only when a sync is actually merged into `self-contained`** —
never merely because upstream was fetched, a sync branch was created, or a
merge was test-attempted. Fetching and testing upstream leaves it untouched.

## Security

- The sync branch never runs anything from upstream — merging source and
  running the Arc invariant suite / typecheck / tests is static analysis and
  local test execution, not code from upstream being deployed or given
  credentials.
- No sync script prints `GH_TOKEN`/`GH_REPO` secrets or writes them to a file.
- Sync operates on source code only; it has no code path that touches
  `~/.bb`, Application Support, threads, accounts, or runtime state.
- The invariant suite's release-workflow checks (above) mean an upstream
  workflow-file change that tried to remove the Arc repo guard or restore a
  BB release URL fails CI on the sync PR itself, before it can reach `self-contained`.
