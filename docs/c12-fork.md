# c12-ai fork of teamai-cli

This fork tracks `Tencent/teamai-cli` (remote `upstream`) and adds a few
safety changes for installing teamai at user scope next to tools that already
manage `~/.claude` and `~/.codex`. Releases are tagged `c12-v<upstream>-<n>`.

## Changes

1. **Files teamai did not deliver are never overwritten.** A skill, rule or
   agent at a destination with no delivery record, whose bytes are neither the
   current team version nor any version in the team repo's history, is left as
   is; pull warns `Skipped <path>: teamai did not deliver it`. A copy an older
   pull wrote, or one the member pushed, matches the history and is updated as
   before. (`judgeCopy` in `src/resources/delivered-copies.ts`.)
2. **No removal of files teamai did not deliver.** The stale-rule sweep, the
   tombstone cleanup and `uninstall` remove a team-named copy only when the
   delivery record shows teamai wrote it. Since pull never replaces such a
   file, there is nothing to restore on uninstall.
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
7. **A project's symlinks and tracked files are never replaced.** In every
   scope, pull leaves a delivery destination that is a symlink (even a
   dangling one) or that git tracks (the path or any file under it) as it is,
   whatever it holds, and warns `Skipped <path>: it is a symlink or git tracks
   it`. A repo that commits `.claude/skills/<name>` as a link to its own
   `.agents/skills/<name>` keeps it. The Codex duplicate cleanup never removes
   such an entry either. (`isProjectEntry` in `src/resources/delivered-copies.ts`.)
8. **Team clone refresh without `git pull`.** Pull and init fetch only the
   checked-out branch's upstream (origin/<branch> without one) by explicit
   refspec and fast-forward to that ref by name. `git pull` merges whatever
   FETCH_HEAD lists, and two teamai processes fetching one clone at once left
   it listing the branch twice: "Cannot fast-forward to multiple branches". A
   fetch refused because a concurrent one moved the ref is retried once. A
   branch the remote no longer has (renamed or deleted) fails with
   `The team repo has no branch <name>: it was renamed or deleted` and the
   `init --branch <new name> --force` fix. (`fastForward` in `src/utils/git.ts`.)

## Checks

- `npm run lint`, `npx tsc --noEmit`, `npx vitest run`, `npm run test:e2e`.
- `scripts/c12/sandbox-trial.sh` runs the built CLI in a throwaway HOME against
  a local team repo and checks the guarantees above end to end.

## Upstream merges

`git fetch upstream --tags`, merge the upstream release tag, re-run the
checks above, then tag `c12-v<upstream>-<n>`.
