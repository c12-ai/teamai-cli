# c12-ai fork of teamai-cli

This fork tracks `Tencent/teamai-cli` (remote `upstream`) and adds a few
safety changes for installing teamai at user scope next to tools that already
manage `~/.claude` and `~/.codex`, and for project-only installs whose project
pins one teamai release. Releases are tagged `c12-v<upstream>-<n>`; each
upstream minor gets its own working branch `c12/v<major.minor>`.

## Changes

1. **The team version replaces a same-named entry.** Upstream judges a copy
   the member edited, a link, or a file teamai cannot prove its own as the
   member's and keeps it (#822, #993). The fork keeps that judgement
   (`judgeCopy`) and overrides it where every writer asks before it writes:
   `keepsEditedCopy` never keeps. The team version replaces the copy (a link
   is removed first, so its target is never written through; a link or an
   entry of the other type inside a skill goes too), and pull warns once per
   path: `Overwrote local edits in <path> with the team version`, or
   `Replaced <path> (a symlink | tracked by git | not delivered by teamai)
   with the team version <team path>`. A copy of a resource the team removed
   (or no longer delivers there) is removed even when the member changed it,
   with one warning: `Removed <path>: no longer in the team repo (local edits
   discarded)` (`removesEditedCopy` at each sweep). A file the member added
   beside a team skill's files stays. Members' own entries must not share a
   name with a team one. (Drake's call, 2026-10-30: the team version always
   wins, so a team update reaches every member; upstream's stricter keep was
   the alternative.) (`keepsEditedCopy`, `removesEditedCopy` and `reportKept`
   in `src/resources/delivered-copies.ts`.)
2. **No git hook in user scope.** Upstream already installs its git hook only
   in project scope; a test pins that.
3. **Track a non-default team branch.** `teamai init <repo> --branch <name>`
   checks that branch out in the team clone, points the clone's `origin/HEAD`
   at it and saves it as `repo.branch` in the local config. Every place that
   asks for the team's default branch (pull, the base of PRs opened by `push`,
   knowledge PRs) reads `origin/HEAD`, so all of them follow the branch; pull
   puts the clone back on it if something moved it (unless a `--team-ref`
   pins the workspace), and `status`/`doctor` show it. Without `--branch`
   nothing changes; re-running init without it returns the clone to the
   remote's default branch. Git clones only (not `--http` or single-repo mode).
4. **Project-only mode.** With `TEAMAI_PROJECT_ONLY=1`, a project-scope
   install keeps everything it writes for the agents inside the project and
   untracked, for a checkout shared through a container whose HOME (and its
   `.claude`/`.codex`) belongs to the host user:
   - Hooks, built-in and team, go to `.claude/settings.local.json` instead of
     HOME; tools whose only project hook file is committed (Codex:
     `.codex/hooks.json`) get no hooks. No git hook is installed, and pull
     removes one an earlier run left.
   - MCP sync skips a project file git tracks (Codex: `.codex/config.toml`).
     Claude's servers stay in the project's `.mcp.json`: upstream moves them
     to `~/.claude.json` while `sharing.gitExclude` is on or the workspace has
     children (#915), a file the member's tools never read when HOME is
     teamai's own (`localScopeOf` in `src/locate.ts`).
   - With `sharing.gitExclude` on, the `delivered` block in
     `.git/info/exclude` lists the hook file and the project MCP file too
     (writers `hooks` and `mcp`), next to every skill, rule, agent and doc
     file upstream lists, so nothing teamai delivers shows as untracked.
   - The GitHub clone's token goes to git in the child's environment, never in
     its argv (upstream: a `-c http.extraHeader` argument). Neither stores it.
   - No self-update: the stop hook's `update` handler and `teamai update` do
     nothing (the project pins the release). Upstream reads the update policy
     only from a global config, which a project-only HOME does not have, so a
     team's `autoUpdate: false` never applied there (`doUpdate` in
     `src/update.ts`).
   - The hook index a pre-0.28 project-only install kept in the project
     (`.teamai/managed-hooks.json`) moves whole into the data home and the
     file is deleted; upstream moves only its Copilot records
     (`migrateLegacyManagedHooks` in `src/hooks.ts`).
   - doctor's Codex project-trust check reads the `config.toml` in
     `TEAMAI_MEMBER_CODEX_HOME` (read only), the Codex home the member's Codex
     reads, when a launcher points `CODEX_HOME` somewhere private to teamai.

   teamai's own state still lives under HOME (`~/.teamai`), so point HOME
   somewhere private to the container. (`isProjectOnly` and
   `projectOnlyRequested` in `src/types.ts`.)
5. **Team clone refresh without `git pull`.** Pull and init fetch only the
   checked-out branch's upstream (origin/<branch> without one) by explicit
   refspec and fast-forward to that ref by name. `git pull` merges whatever
   FETCH_HEAD lists, and two teamai processes fetching one clone at once left
   it listing the branch twice: "Cannot fast-forward to multiple branches". A
   fetch refused because a concurrent one moved the ref is retried once. A
   branch the remote no longer has (renamed or deleted) fails with
   `The team repo has no branch <name>: it was renamed or deleted` and the
   `init --branch <new name> --force` fix. A detached or unborn HEAD pulls as
   upstream does. (`fastForward` in `src/utils/git.ts`.)
6. **A deleted delivered copy is delivered again.** The "Already synced" fast
   path of pull is taken only while every file in the checkout's delivery
   record still exists, agent copies aside (the fast path delivers a missing
   agent itself, #830). If one was deleted meanwhile (say by the project's own
   `git pull`), pull logs `[<scope>] N delivered file(s) missing; syncing` and
   runs the full sync, which puts the team version back without `--force`. A
   complete full sync drops recorded files still absent afterwards (a
   destination teamai no longer writes), so they do not force a full sync on
   every pull. (`countMissingDelivered` in `src/pull.ts`.)
7. **CI runs on the fork's working branches.** `.github/workflows/ci.yml` adds
   `'c12/v*'` to its push and pull_request branch filters (upstream: main/master only).

### Dropped at 0.28.1

- *No removal of files teamai did not deliver*: upstream removes a copy only
  on proof that it is teamai's (its record, or the team history; #993).
- *Codex duplicate cleanup spares symlinks*: upstream never deletes a link as
  a duplicate (#993).
- *Reports are opt-in*: on 0.28 the `teamai-reports` branch also carries
  workflow handoff and session archives, which a blanket gate would break.
  Upstream's `usageReport` (default on) governs usage stats, workflow records
  and scorer labels; member registration ignores it. A team that wants none
  sets `usageReport: false`. BIC sets `usageReport: true`.
- *Token-free GitHub clone* (as a whole): upstream keeps no token in the clone
  either; only the argv part stays (item 4).

## Checks

- `npm run lint`, `npx tsc --noEmit`, `npx vitest run`, `npm run test:e2e`.
- `scripts/c12/sandbox-trial.sh` runs the built CLI in a throwaway HOME against
  a local team repo and checks the guarantees above end to end.

## Upstream merges

A new upstream minor gets a new branch: `git fetch upstream --tags`, branch
`c12/v<major.minor>` off the previous `c12/v*`, merge the upstream release
tag, resolve, and for each change above check whether upstream now covers it
(drop it then, under "Dropped") or port it. Re-run the checks above, then tag
`c12-v<upstream>-<n>`. A patch release of the same minor is merged into the
existing branch.
