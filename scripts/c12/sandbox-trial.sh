#!/usr/bin/env bash
# Sandbox trial for the c12 fork guarantees (docs/c12-fork.md), run against the
# built CLI (npm run build) in a throwaway HOME with a local team repo:
#   1. same-named skills, rules and agents teamai did not deliver stay untouched
#   2. uninstall leaves them as they were, and removes what teamai delivered
#   3. nothing reaches the teamai-reports branch without `usageReport: true`
#   4. a user-scope install puts no git hook in the project repo
# Usage: scripts/c12/sandbox-trial.sh [empty-sandbox-dir]
# Nothing outside the sandbox is written; no network remote is used.
set -euo pipefail

FORK_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="$FORK_ROOT/dist/index.js"
[ -f "$CLI" ] || { echo "Build first: (cd $FORK_ROOT && npm run build)" >&2; exit 2; }

SANDBOX="${1:-$(mktemp -d "${TMPDIR:-/tmp}/teamai-c12-trial.XXXXXX")}"
mkdir -p "$SANDBOX"
SANDBOX="$(cd "$SANDBOX" && pwd)"
[ -z "$(ls -A "$SANDBOX")" ] || { echo "Sandbox $SANDBOX is not empty" >&2; exit 2; }
echo "Sandbox: $SANDBOX"

export HOME="$SANDBOX/home"
export CLAUDE_CONFIG_DIR="$HOME/.claude" CODEX_HOME="$HOME/.codex"
export ZDOTDIR="$HOME" XDG_CONFIG_HOME="$HOME/.config" GIT_CONFIG_NOSYSTEM=1
export npm_config_prefix="$SANDBOX/prefix" TEAMAI_NPM_REGISTRY="http://127.0.0.1:9"
export PATH="$SANDBOX/prefix/bin:$PATH"
mkdir -p "$HOME/.claude/skills" "$HOME/.claude/rules" "$HOME/.claude/agents" "$HOME/.codex/skills" "$SANDBOX/prefix/bin" "$SANDBOX/logs"

# Hooks call `teamai` from PATH: point it at the fork build.
printf '#!/bin/sh\nexec node %q "$@"\n' "$CLI" > "$SANDBOX/prefix/bin/teamai"
chmod +x "$SANDBOX/prefix/bin/teamai"

TEAM_URL="https://git.trial.invalid/trial/team.git"
BARE="$SANDBOX/team.git"
cat > "$HOME/.gitconfig" <<EOF
[user]
	name = trial
	email = trial@example.invalid
[init]
	defaultBranch = main
[url "file://$BARE"]
	insteadOf = $TEAM_URL
EOF

FAILS=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILS=$((FAILS + 1)); }
check() { local what="$1"; shift; if "$@"; then pass "$what"; else fail "$what"; fi; }
hashes() { (cd "$1" && find . -type f ! -path './.git/*' -print0 | sort -z | xargs -0 shasum -a 256); }
run() {
  local log="$SANDBOX/logs/$1.log"; shift
  echo "\$ teamai $*" > "$log"
  teamai "$@" < /dev/null >> "$log" 2>&1 || { echo "teamai $* failed:"; tail -20 "$log"; return 1; }
}
reports_branch() { git --git-dir="$BARE" for-each-ref --format='%(refname)' refs/heads/teamai-reports; }
no_reports_branch() { [ -z "$(reports_branch)" ]; }
no_hook_config() { [ -z "$(git -C "$1" config --get-regexp '^hook\.' || true)" ]; }

# --- Team repo -------------------------------------------------------------
TEAM_SRC="$SANDBOX/team-src"
mkdir -p "$TEAM_SRC"
cat > "$TEAM_SRC/teamai.yaml" <<EOF
team: trial
repo: $TEAM_URL
provider: git
autoUpdate: false
EOF
for skill in tdd grill-me team-only; do
  mkdir -p "$TEAM_SRC/skills/$skill"
  printf -- '---\nname: %s\ndescription: Team %s skill\n---\nTeam version of %s.\n' "$skill" "$skill" "$skill" > "$TEAM_SRC/skills/$skill/SKILL.md"
done
mkdir -p "$TEAM_SRC/rules" "$TEAM_SRC/agents"
printf '# Team rule\n' > "$TEAM_SRC/rules/team-rule.md"
printf '# Same name as a member rule (team copy)\n' > "$TEAM_SRC/rules/my-rule.md"
printf -- '---\nname: reviewer\ndescription: Team reviewer\n---\nTeam reviewer.\n' > "$TEAM_SRC/agents/reviewer.md"
git -C "$TEAM_SRC" init -q
git -C "$TEAM_SRC" add -A
git -C "$TEAM_SRC" commit -q -m "team content"
git clone -q --bare "$TEAM_SRC" "$BARE"

# --- Member's own files, named like team ones ------------------------------
mkdir -p "$HOME/.claude/skills/tdd" "$HOME/.codex/skills/grill-me"
printf -- '---\nname: tdd\ndescription: Member skill\n---\nFOREIGN tdd skill.\n' > "$HOME/.claude/skills/tdd/SKILL.md"
printf -- '---\nname: grill-me\ndescription: Member skill\n---\nFOREIGN grill-me skill.\n' > "$HOME/.codex/skills/grill-me/SKILL.md"
printf '# FOREIGN member rule with a team name\n' > "$HOME/.claude/rules/my-rule.md"
printf '# FOREIGN rule only the member has\n' > "$HOME/.claude/rules/rule-8-match-codebase-conventions.md"
printf -- '---\nname: reviewer\ndescription: Member agent\n---\nFOREIGN reviewer.\n' > "$HOME/.claude/agents/reviewer.md"
cat > "$HOME/.claude/settings.json" <<'EOF'
{"hooks":{"UserPromptSubmit":[{"matcher":"*","hooks":[{"type":"command","command":"codegraph prompt-hook"}]}]}}
EOF
FOREIGN=(
  "$HOME/.claude/skills/tdd/SKILL.md"
  "$HOME/.codex/skills/grill-me/SKILL.md"
  "$HOME/.claude/rules/my-rule.md"
  "$HOME/.claude/rules/rule-8-match-codebase-conventions.md"
  "$HOME/.claude/agents/reviewer.md"
)
shasum -a 256 "${FOREIGN[@]}" > "$SANDBOX/foreign.sha"
foreign_untouched() { shasum -a 256 -c --quiet "$SANDBOX/foreign.sha" > /dev/null 2>&1; }
foreign_hook_kept() { grep -q 'codegraph prompt-hook' "$HOME/.claude/settings.json"; }

# --- A project repo with committed rules -----------------------------------
make_project() {
  mkdir -p "$1/.claude/rules"
  for n in 1 2 3; do printf '# Project rule %s\n' "$n" > "$1/.claude/rules/rule-$n-project.md"; done
  printf 'app\n' > "$1/README.md"
  git -C "$1" init -q
  git -C "$1" add -A
  git -C "$1" commit -q -m "project"
}
PROJECT="$SANDBOX/project"
make_project "$PROJECT"
hashes "$PROJECT" > "$SANDBOX/project.sha"
ls -A "$PROJECT/.git/hooks" > "$SANDBOX/project-githooks.txt"

# --- 1. User scope install + pull ------------------------------------------
cd "$PROJECT"
run user-init init "$TEAM_URL" --provider git --scope user --agent claude,codex
run user-pull pull --force
echo "== user scope: init + pull =="
check "team-only skill delivered (positive control)" test -f "$HOME/.claude/skills/team-only/SKILL.md"
check "team rule delivered (positive control)" test -f "$HOME/.claude/rules/team-rule.md"
check "same-named foreign skills, rules and agent untouched" foreign_untouched
check "pull names a skipped foreign copy" grep -q "teamai did not deliver it" "$SANDBOX/logs/user-init.log" "$SANDBOX/logs/user-pull.log"
check "foreign user hook kept in settings.json" foreign_hook_kept
check "project tree unchanged" diff -q <(hashes "$PROJECT") "$SANDBOX/project.sha"
check "project has no untracked or ignored files" test -z "$(git -C "$PROJECT" status --porcelain --ignored)"
check "no git hook config in the project" no_hook_config "$PROJECT"
check "no git hook files added in the project" diff -q <(ls -A "$PROJECT/.git/hooks") "$SANDBOX/project-githooks.txt"
check "no teamai-reports branch on the team remote" no_reports_branch

# --- 2. Uninstall -----------------------------------------------------------
run user-uninstall uninstall --force
echo "== user scope: uninstall =="
check "foreign skills, rules and agent still untouched" foreign_untouched
check "delivered team-only skill removed" test ! -e "$HOME/.claude/skills/team-only"
check "delivered team rule removed" test ! -e "$HOME/.claude/rules/team-rule.md"
check "foreign user hook kept in settings.json" foreign_hook_kept
check "no teamai-reports branch on the team remote" no_reports_branch

# --- 3. Reports after opt-in ------------------------------------------------
git -C "$TEAM_SRC" remote add origin "$BARE" 2>/dev/null || true
printf 'usageReport: true\n' >> "$TEAM_SRC/teamai.yaml"
git -C "$TEAM_SRC" commit -q -am "opt in to reports"
git -C "$TEAM_SRC" push -q origin HEAD:main
run optin-init init "$TEAM_URL" --provider git --scope user --agent claude
echo "== user scope: usageReport: true =="
check "member registration pushed to teamai-reports once opted in" test -n "$(reports_branch)"
run optin-uninstall uninstall --force
check "foreign files still untouched after a second install/uninstall" foreign_untouched

# --- 4. Workspace scope keeps committed project rules ------------------------
PROJECT_B="$SANDBOX/project-b"
make_project "$PROJECT_B"
cd "$PROJECT_B"
run ws-init init "$TEAM_URL" --provider git --agent claude
echo "== workspace scope =="
check "committed project rules not deleted" test -z "$(git -C "$PROJECT_B" status --porcelain --untracked-files=no)"
run ws-uninstall uninstall --force
check "committed project rules intact after uninstall" test -z "$(git -C "$PROJECT_B" status --porcelain --untracked-files=no)"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED (logs: $SANDBOX/logs)"; else echo "$FAILS CHECK(S) FAILED (logs: $SANDBOX/logs)"; exit 1; fi
