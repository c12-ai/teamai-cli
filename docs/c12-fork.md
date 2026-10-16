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

## Checks

- `npm run lint`, `npx tsc --noEmit`, `npx vitest run`, `npm run test:e2e`.
- `scripts/c12/sandbox-trial.sh` runs the built CLI in a throwaway HOME against
  a local team repo and checks the four guarantees above end to end.

## Upstream merges

`git fetch upstream --tags`, merge the upstream release tag, re-run the
checks above, then tag `c12-v<upstream>-<n>`.
