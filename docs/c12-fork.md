# c12-ai fork of teamai-cli

This fork tracks `Tencent/teamai-cli` (remote `upstream`) and adds a few
safety changes for installing teamai at user scope next to tools that already
manage `~/.claude` and `~/.codex`. Releases are tagged `c12-v<upstream>-<n>`.

## Changes

1. **The team version replaces a same-named entry.** A skill, rule or agent
   at a destination that is a regular file or directory teamai did not
   deliver, a symlink (even a dangling one) or a git-tracked path is replaced
   by the team version in every scope, and pull warns once per name:
   `Replaced <path> (a symlink | tracked by git | not delivered by teamai)
   with the team version <team path>`. A symlink is removed first, so its
   target is never written through. A copy teamai did deliver and the member
   then edited is overwritten the same way, with one warning per path:
   `Overwrote local edits in <path> with the team version`. The team version
   always wins, so a team update reaches every member. A copy of a resource
   the team removed is removed too, even when the member changed it, with one
   warning: `Removed <path>: no longer in the team repo (local edits
   discarded)`. Members' own
   entries must not share a name with a team one. (`judgeCopy`,
   `replaceCopy` and `reportKept` in `src/resources/delivered-copies.ts`.)
2. **No removal of files teamai did not deliver.** The stale-rule sweep, the
   tombstone cleanup and `uninstall` remove a team-named copy only when the
   delivery record shows teamai wrote it. A copy the team version replaced is
   recorded, so uninstall removes it like any delivered copy.
3. **Reports are opt-in.** Nothing (member registration, sessions, usage
   stats, votes) is committed to or pushed on `teamai-reports` unless the team
   `teamai.yaml` sets `usageReport: true` (`src/utils/reports-branch.ts`).
4. **No git hook in user scope.** Upstream already installs its git hook only
   in project scope; a test pins that.
5. **Track a non-default team branch.** `teamai init <repo> --branch <name>`
   checks that branch out in the team clone, points the clone's `origin/HEAD`
   at it and saves it as `repo.branch` in the local config. Every place that
   asks for the team's default branch (pull, the base of PRs opened by `push`,
   knowledge PRs) reads `origin/HEAD`, so all of them follow the branch; pull
   puts the clone back on it if something moved it, and `status`/`doctor` show
   it. Without `--branch` nothing changes; re-running init without it returns
   the clone to the remote's default branch. The `teamai-reports` branch is
   unaffected. Git clones only (not `--http` or single-repo mode).
6. **Project-only mode.** With `TEAMAI_PROJECT_ONLY=1`, a project-scope
   install keeps everything it writes for the agents inside the project and
   untracked, for a checkout shared through a container whose HOME (and its
   `.claude`/`.codex`) belongs to the host user. Hooks, built-in and team, go
   to `.claude/settings.local.json` instead of HOME; tools whose only project
   hook file is committed (Codex: `.codex/hooks.json`) get no hooks. No git
   hook is installed, and pull removes one an earlier run left. MCP sync skips
   a project file git tracks (Codex: `.codex/config.toml`). The GitHub clone
   keeps no token: upstream writes it into the clone's remote URL; here it
   authenticates the clone only (a header in the child's environment) and later
   fetches use git's own credentials. teamai's own state
   still lives under HOME (`~/.teamai`), so point HOME somewhere private to the
   container. (`isProjectOnly` in `src/types.ts`.)
7. **Codex duplicate cleanup spares symlinks.** The cleanup of an identical
   duplicate in the configured Codex skills path never removes a symlink or a
   git-tracked entry. (`isProjectEntry` in `src/resources/delivered-copies.ts`.)
8. **Team clone refresh without `git pull`.** Pull and init fetch only the
   checked-out branch's upstream (origin/<branch> without one) by explicit
   refspec and fast-forward to that ref by name. `git pull` merges whatever
   FETCH_HEAD lists, and two teamai processes fetching one clone at once left
   it listing the branch twice: "Cannot fast-forward to multiple branches". A
   fetch refused because a concurrent one moved the ref is retried once. A
   branch the remote no longer has (renamed or deleted) fails with
   `The team repo has no branch <name>: it was renamed or deleted` and the
   `init --branch <new name> --force` fix. (`fastForward` in `src/utils/git.ts`.)
9. **A deleted delivered copy is delivered again.** The "Already synced"
   fast path of pull is taken only while every file in the checkout's delivery
   record still exists. If a delivered copy was deleted meanwhile (say by the
   project's own `git pull`), pull logs `[<scope>] N delivered file(s)
   missing; syncing` and runs the full sync, which puts the team version back
   without `--force`. An edited copy is not missing. A complete full sync drops recorded files
   still absent afterwards (a destination teamai no longer writes), so they
   do not force a full sync on every pull. (`countMissingDelivered`
   in `src/pull.ts`.)

## Checks

- `npm run lint`, `npx tsc --noEmit`, `npx vitest run`, `npm run test:e2e`.
- `scripts/c12/sandbox-trial.sh` runs the built CLI in a throwaway HOME against
  a local team repo and checks the guarantees above end to end.

## Upstream merges

`git fetch upstream --tags`, merge the upstream release tag, re-run the
checks above, then tag `c12-v<upstream>-<n>`.
