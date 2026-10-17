/**
 * E2E (C12 fork): `teamai init --branch <name>` makes a member track a team
 * repo branch other than the default one. The branch is saved in the local
 * config; pull follows it (and returns to it if something moved the clone);
 * PRs opened by `teamai push` target it. Without `--branch` nothing changes:
 * the default branch is tracked and PRs target it.
 *
 * The team remote is https://github.com/acme/team, rewritten by git's
 * `insteadOf` to a local bare repo. A fake `gh` on PATH is logged in, clones
 * through plain git and records the `pr create` arguments, so the PR base is
 * observed exactly as GitHub would receive it. No network.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const TEAM_URL = 'https://github.com/acme/team';
const BRANCH = 'bic-argo';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

let sandbox: string;
let remote: string;
let seed: string;
let binDir: string;
let home: string;
let ghLog: string;

function git(args: string[], cwd: string, extraEnv: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, ...extraEnv } }).trim();
}

function writeFile(root: string, relativePath: string, content: string): void {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function skill(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n# ${name}\n`;
}

function writeFakeGh(): void {
  fs.writeFileSync(path.join(binDir, 'gh'), [
    '#!/bin/sh',
    '# Fake gh for c12-init-branch.test.ts: logged in, records pr create.',
    'case "$1 $2" in',
    '  "auth status") exit 0 ;;',
    '  "auth token") exit 1 ;;',
    '  "api user") echo tester; exit 0 ;;',
    '  "pr create") printf \'%s\\n\' "$*" >> "$GH_LOG"; echo https://github.com/acme/team/pull/1; exit 0 ;;',
    '  "pr list") echo "[]"; exit 0 ;;',
    'esac',
    'echo "gh version 2.0.0 (fake)"; exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
}

function runCLI(args: string[]): Promise<{ code: number | null; output: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...GIT_ENV,
    HOME: home,
    USERPROFILE: home,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    FORCE_COLOR: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GH_LOG: ghLog,
  };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

const teamRepo = (): string => path.join(home, '.teamai', 'team-repo');
const configYaml = (): string => fs.readFileSync(path.join(home, '.teamai', 'config.yaml'), 'utf8');
const delivered = (name: string): boolean => fs.existsSync(path.join(home, '.claude', 'skills', name, 'SKILL.md'));

/** Commit a new skill to `branch` of the bare remote, as a teammate would. */
function landOnRemote(branch: string, name: string): void {
  git(['checkout', '-q', branch], seed);
  writeFile(seed, `skills/${name}/SKILL.md`, skill(name));
  git(['add', '-A'], seed);
  git(['commit', '-q', '-m', `add ${name}`], seed);
  git(['push', '-q', remote, branch], seed);
}

async function pushNewSkill(name: string): Promise<string> {
  fs.writeFileSync(ghLog, '');
  writeFile(home, `.claude/skills/${name}/SKILL.md`, skill(name));
  const result = await runCLI(['push', '--skill', path.join(home, '.claude', 'skills', name), '--role', 'dev', '--all']);
  expect(result.code, result.output).toBe(0);
  const log = fs.readFileSync(ghLog, 'utf8');
  expect(log, result.output).toMatch(/pr create/);
  return log;
}

describe.skipIf(process.platform === 'win32')('teamai init --branch (C12 fork)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-c12-branch-')));
    remote = path.join(sandbox, 'team.git');
    seed = path.join(sandbox, 'seed');
    binDir = path.join(sandbox, 'bin');
    ghLog = path.join(sandbox, 'gh.log');
    fs.mkdirSync(binDir, { recursive: true });
    writeFakeGh();

    writeFile(seed, 'teamai.yaml', `team: branch-e2e\nrepo: ${TEAM_URL}\nprovider: github\nreviewers: []\n`);
    writeFile(seed, 'skills/main-skill/SKILL.md', skill('main-skill'));
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['checkout', '-q', '-b', BRANCH], seed);
    writeFile(seed, 'skills/branch-skill/SKILL.md', skill('branch-skill'));
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'branch only'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);
    // The remote's default branch is main, as on GitHub.
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
  });

  beforeEach(() => {
    home = path.join(sandbox, `home-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    // teamai finds gh through a login shell, whose profile would put a real gh
    // first; the sandbox HOME's profile puts the fake one back in front.
    fs.writeFileSync(path.join(home, '.bash_profile'), `export PATH="${binDir}:$PATH"\n`);
    git(['config', '--global', `url.${remote}.insteadOf`, `${TEAM_URL}.git`], sandbox, { HOME: home, USERPROFILE: home });
    git(['config', '--global', '--add', `url.${remote}.insteadOf`, TEAM_URL], sandbox, { HOME: home, USERPROFILE: home });
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('init --branch checks the branch out, saves it, and delivers its resources', async () => {
    const result = await runCLI(['init', TEAM_URL, '--branch', BRANCH, '--scope', 'user', '--role', 'dev', '--agent', 'claude', '--force']);
    expect(result.code, result.output).toBe(0);
    expect(configYaml()).toMatch(new RegExp(`branch: ${BRANCH}`));
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], teamRepo())).toBe(BRANCH);
    expect(git(['rev-parse', '--abbrev-ref', 'origin/HEAD'], teamRepo())).toBe(`origin/${BRANCH}`);
    expect(delivered('branch-skill'), result.output).toBe(true);

    const status = await runCLI(['status']);
    expect(status.output).toMatch(new RegExp(`branch: ${BRANCH}`));
  }, 120_000);

  it('pull follows the tracked branch and returns to it when the clone was moved', async () => {
    const init = await runCLI(['init', TEAM_URL, '--branch', BRANCH, '--scope', 'user', '--role', 'dev', '--agent', 'claude', '--force']);
    expect(init.code, init.output).toBe(0);

    landOnRemote(BRANCH, 'later-branch-skill');
    landOnRemote('main', 'later-main-skill');
    git(['checkout', '-q', 'main'], teamRepo());

    const pull = await runCLI(['pull']);
    expect(pull.code, pull.output).toBe(0);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], teamRepo())).toBe(BRANCH);
    expect(delivered('later-branch-skill'), pull.output).toBe(true);
    expect(delivered('later-main-skill'), pull.output).toBe(false);
  }, 120_000);

  it('push opens its PR against the tracked branch', async () => {
    const init = await runCLI(['init', TEAM_URL, '--branch', BRANCH, '--scope', 'user', '--role', 'dev', '--agent', 'claude', '--force']);
    expect(init.code, init.output).toBe(0);
    const log = await pushNewSkill('my-branch-skill');
    expect(log).toMatch(new RegExp(`-B ${BRANCH}( |$)`, 'm'));
  }, 120_000);

  it('without --branch: default branch, no saved branch, PR against the default branch', async () => {
    const init = await runCLI(['init', TEAM_URL, '--scope', 'user', '--role', 'dev', '--agent', 'claude', '--force']);
    expect(init.code, init.output).toBe(0);
    expect(configYaml()).not.toMatch(/branch:/);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], teamRepo())).toBe('main');
    expect(delivered('main-skill'), init.output).toBe(true);
    expect(delivered('branch-skill'), init.output).toBe(false);
    const log = await pushNewSkill('my-main-skill');
    expect(log).toMatch(/-B main( |$)/m);
  }, 120_000);

  it('re-init without --branch returns an earlier --branch clone to the default branch', async () => {
    const first = await runCLI(['init', TEAM_URL, '--branch', BRANCH, '--scope', 'user', '--role', 'dev', '--agent', 'claude', '--force']);
    expect(first.code, first.output).toBe(0);
    const again = await runCLI(['init', TEAM_URL, '--scope', 'user', '--role', 'dev', '--agent', 'claude', '--force']);
    expect(again.code, again.output).toBe(0);
    expect(configYaml()).not.toMatch(/branch:/);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], teamRepo())).toBe('main');
    expect(git(['rev-parse', '--abbrev-ref', 'origin/HEAD'], teamRepo())).toBe('origin/main');
  }, 120_000);

  it('a renamed team branch: pull names the fix, init --branch <new name> follows it', async () => {
    // A remote of its own, since this test renames a branch on it.
    const renamed = path.join(sandbox, `renamed-${Math.random().toString(36).slice(2)}.git`);
    git(['clone', '-q', '--bare', remote, renamed], sandbox);
    git(['config', '--global', '--replace-all', `url.${renamed}.insteadOf`, `${TEAM_URL}.git`], sandbox, { HOME: home, USERPROFILE: home });
    git(['config', '--global', '--add', `url.${renamed}.insteadOf`, TEAM_URL], sandbox, { HOME: home, USERPROFILE: home });
    git(['config', '--global', '--unset-all', `url.${remote}.insteadOf`], sandbox, { HOME: home, USERPROFILE: home });
    const init = await runCLI(['init', TEAM_URL, '--branch', BRANCH, '--scope', 'user', '--role', 'dev', '--agent', 'claude', '--force']);
    expect(init.code, init.output).toBe(0);

    git(['push', '-q', renamed, `refs/heads/${BRANCH}:refs/heads/${BRANCH}-renamed`, `:refs/heads/${BRANCH}`], seed);
    git(['checkout', '-q', BRANCH], seed);
    writeFile(seed, 'skills/after-rename/SKILL.md', skill('after-rename'));
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'after rename'], seed);
    git(['push', '-q', renamed, `HEAD:refs/heads/${BRANCH}-renamed`], seed);

    const pull = await runCLI(['pull']);
    expect(pull.output).toMatch(new RegExp(`no branch ${BRANCH}: it was renamed or deleted`));
    expect(delivered('after-rename'), pull.output).toBe(false);

    const follow = await runCLI(['init', TEAM_URL, '--branch', `${BRANCH}-renamed`, '--scope', 'user', '--role', 'dev', '--agent', 'claude', '--force']);
    expect(follow.code, follow.output).toBe(0);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], teamRepo())).toBe(`${BRANCH}-renamed`);
    expect(delivered('after-rename'), follow.output).toBe(true);
    const after = await runCLI(['pull']);
    expect(after.code, after.output).toBe(0);
  }, 120_000);

  it('init --branch fails loudly when the branch does not exist', async () => {
    const result = await runCLI(['init', TEAM_URL, '--branch', 'no-such-branch', '--scope', 'user', '--role', 'dev', '--agent', 'claude', '--force']);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toMatch(/no-such-branch/);
  }, 120_000);
});
