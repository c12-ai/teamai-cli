/**
 * E2E (C12 fork): project-only mode (`TEAMAI_PROJECT_ONLY=1`, project scope).
 * A checkout shared through a container, whose HOME belongs to the host user,
 * gets every teamai file inside the project and untracked: hooks (built-in and
 * team) in `.claude/settings.local.json`, nothing in HOME's `.claude`/`.codex`,
 * no git hook, and no write to a file the project commits (Codex's
 * `.codex/config.toml` and `.codex/hooks.json`). Without the variable the
 * upstream behaviour stays: hooks in HOME, a git hook in the project.
 *
 * The team remote is https://github.com/acme/team, rewritten by git's
 * `insteadOf` to a local bare repo (`--provider git`). No network.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const TEAM_URL = 'https://github.com/acme/team';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

const TEAM_SKILL = '---\nname: team-skill\ndescription: team skill fixture\n---\n\n# team-skill\n';

// What the project commits in its agent dirs, as a Trellis checkout does.
const COMMITTED = {
  '.claude/settings.json': '{\n  "hooks": {\n    "SessionStart": [{ "hooks": [{ "type": "command", "command": "python3 .claude/hooks/session-start.py" }] }]\n  }\n}\n',
  '.claude/rules/project-rule.md': '# Project rule\n',
  '.codex/config.toml': '[agents]\nmax_depth = 1\n',
  '.codex/hooks.json': '{\n  "hooks": {}\n}\n',
  // The team's skill, committed under .agents and linked from .claude below.
  '.agents/skills/team-skill/SKILL.md': TEAM_SKILL,
};

let sandbox: string;
let remote: string;
let binDir: string;
let home: string;
let project: string;

function git(args: string[], cwd: string, extraEnv: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, ...extraEnv } }).trim();
}

function writeFile(root: string, relativePath: string, content: string): void {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function read(root: string, relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

/** sha256 of every file under `dir`, by relative path. */
function hashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  return out;
}

function runCLI(args: string[], projectOnly: boolean): Promise<{ code: number | null; output: string }> {
  const env: Record<string, string | undefined> = {
    ...GIT_ENV,
    HOME: home,
    USERPROFILE: home,
    // No codex on PATH: the upstream path would otherwise start it to trust hooks.
    PATH: [binDir, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    FORCE_COLOR: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    TEAMAI_NPM_REGISTRY: 'http://127.0.0.1:9',
    ...(projectOnly ? { TEAMAI_PROJECT_ONLY: '1' } : {}),
  };
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

const INIT = ['init', TEAM_URL, '--provider', 'git', '--scope', 'project', '--role', 'dev', '--agent', 'claude,codex', '--force'];

function gitHookInstalled(): boolean {
  const scripts = ['post-checkout', 'post-merge', 'post-rewrite']
    .some((event) => fs.existsSync(path.join(project, '.git', 'hooks', event))
      && read(project, `.git/hooks/${event}`).includes('teamai'));
  let config = '';
  try {
    config = git(['config', '--local', '--get-regexp', '^hook\\.teamai'], project);
  } catch {
    // exit 1: no such section
  }
  return scripts || config !== '';
}

describe.skipIf(process.platform === 'win32')('project-only mode (C12 fork)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-c12-project-only-')));
    remote = path.join(sandbox, 'team.git');
    binDir = path.join(sandbox, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'teamai'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
    // A team MCP server needs its command on PATH.
    fs.writeFileSync(path.join(binDir, 'team-mcp'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const seed = path.join(sandbox, 'seed');
    writeFile(seed, 'teamai.yaml', [
      'team: project-only-e2e',
      `repo: ${TEAM_URL}`,
      'provider: git',
      'autoUpdate: false',
      'sharing:',
      '  hooks:',
      '    autoApply: true',
      '  mcp:',
      '    autoApply: true',
      '    allowedCommands: [team-mcp]',
      '',
    ].join('\n'));
    writeFile(seed, 'skills/team-skill/SKILL.md', TEAM_SKILL);
    writeFile(seed, 'rules/team-rule.md', '# Team rule\n');
    writeFile(seed, 'agents/team-agent.md', '---\nname: team-agent\ndescription: team agent fixture\n---\nTeam agent.\n');
    writeFile(seed, 'hooks/hooks.yaml', [
      'hooks:',
      '  - id: team-prompt-hook',
      '    description: Team prompt hook',
      '    event: UserPromptSubmit',
      '    command: team-prompt-hook',
      '    tools: [claude, codex]',
      '',
    ].join('\n'));
    writeFile(seed, 'mcp/mcp.yaml', [
      'servers:',
      '  - name: team-mcp',
      '    transport: stdio',
      '    command: team-mcp',
      '    requires: [team-mcp]',
      '    tools: [claude, codex]',
      '',
    ].join('\n'));
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);
  });

  beforeEach(() => {
    const run = Math.random().toString(36).slice(2);
    home = path.join(sandbox, `home-${run}`);
    project = path.join(sandbox, `project-${run}`);
    // The host user's own agent config, which must stay as it is.
    writeFile(home, '.claude/settings.json', '{\n  "hooks": {}\n}\n');
    writeFile(home, '.codex/config.toml', 'model = "fixture"\n');
    git(['config', '--global', `url.${remote}.insteadOf`, `${TEAM_URL}.git`], sandbox, { HOME: home, USERPROFILE: home });
    git(['config', '--global', '--add', `url.${remote}.insteadOf`, TEAM_URL], sandbox, { HOME: home, USERPROFILE: home });
    for (const [file, content] of Object.entries(COMMITTED)) writeFile(project, file, content);
    fs.mkdirSync(path.join(project, '.claude/skills'), { recursive: true });
    fs.symlinkSync('../../.agents/skills/team-skill', path.join(project, '.claude/skills/team-skill'));
    // A committed dangling link where the team agent would land.
    fs.mkdirSync(path.join(project, '.claude/agents'), { recursive: true });
    fs.symlinkSync('../../no-such-agent.md', path.join(project, '.claude/agents/team-agent.md'));
    git(['init', '-q', '-b', 'main'], project);
    git(['add', '-A'], project);
    git(['commit', '-q', '-m', 'project'], project);
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('keeps every write in the project, untracked, and HOME agent config untouched', async () => {
    const homeAgents = { ...hashes(path.join(home, '.claude')), ...hashes(path.join(home, '.codex')) };

    const init = await runCLI(INIT, true);
    expect(init.code, init.output).toBe(0);
    const pull = await runCLI(['pull'], true);
    expect(pull.code, pull.output).toBe(0);

    // HOME: the host's agent dirs are byte-for-byte unchanged, nothing added.
    expect({ ...hashes(path.join(home, '.claude')), ...hashes(path.join(home, '.codex')) }).toEqual(homeAgents);
    // Project: the team version replaces the same-named committed symlinks
    // (even the dangling one), each named in a warning; nothing else changes.
    expect(git(['status', '--porcelain', '--untracked-files=no'], project), pull.output).not.toMatch(/project-rule|settings\.json|config\.toml|hooks\.json/);
    expect(fs.lstatSync(path.join(project, '.claude/skills/team-skill')).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(project, '.claude/agents/team-agent.md')).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(project, 'no-such-agent.md'))).toBe(false);
    expect(read(project, '.agents/skills/team-skill/SKILL.md')).toBe(TEAM_SKILL);
    expect(init.output + pull.output).toMatch(/Replaced \S*\.claude\/agents\/team-agent\.md \(a symlink\)/);
    expect(init.output + pull.output).toMatch(/Replaced \S*\.claude\/skills\/team-skill \(a symlink\)/);
    for (const [file, content] of Object.entries(COMMITTED)) expect(read(project, file)).toBe(content);

    // Built-in and team hooks: in Claude's untracked project settings file.
    const local = read(project, '.claude/settings.local.json');
    expect(local).toMatch(/teamai hook-dispatch session-start --tool claude/);
    expect(local).toMatch(/team-prompt-hook/);
    // MCP: Claude's untracked .mcp.json; Codex's committed config.toml skipped.
    expect(JSON.parse(read(project, '.mcp.json')).mcpServers['team-mcp']).toBeDefined();
    // Delivered resources.
    expect(fs.existsSync(path.join(project, '.claude/skills/team-skill/SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(project, '.claude/rules/team-rule.md'))).toBe(true);
    expect(fs.existsSync(path.join(project, '.claude/agents/team-agent.md'))).toBe(true);
    // No git hook.
    expect(gitHookInstalled()).toBe(false);

    const doctor = await runCLI(['doctor'], true);
    expect(doctor.output).not.toMatch(/Git hook syncs/);
  }, 180_000);

  it('removes the git hook an earlier run without the variable installed', async () => {
    const init = await runCLI(INIT, false);
    expect(init.code, init.output).toBe(0);
    expect(gitHookInstalled()).toBe(true);

    const pull = await runCLI(['pull', '--force'], true);
    expect(pull.code, pull.output).toBe(0);
    expect(gitHookInstalled()).toBe(false);
  }, 180_000);

  it('lists every delivered file in the delivered block by default, .mcp.json included, as deliveries come and go', async () => {
    // A team repo of its own (this test changes it), reached through the same
    // URL, that says nothing about sharing.gitExclude: on by default here.
    const seed = path.join(sandbox, `seed-exclude-${path.basename(project)}`);
    const excludeRemote = path.join(sandbox, `team-exclude-${path.basename(project)}.git`);
    git(['clone', '-q', remote, seed], sandbox);
    git(['clone', '-q', '--bare', seed, excludeRemote], sandbox);
    for (const url of [`${TEAM_URL}.git`, TEAM_URL]) git(['config', '--global', '--unset-all', `url.${remote}.insteadOf`, url], sandbox, { HOME: home, USERPROFILE: home });
    git(['config', '--global', `url.${excludeRemote}.insteadOf`, `${TEAM_URL}.git`], sandbox, { HOME: home, USERPROFILE: home });
    git(['config', '--global', '--add', `url.${excludeRemote}.insteadOf`, TEAM_URL], sandbox, { HOME: home, USERPROFILE: home });
    const pushTeam = (message: string): void => {
      git(['add', '-A'], seed);
      git(['commit', '-q', '-m', message], seed);
      git(['push', '-q', excludeRemote, 'HEAD:main'], seed);
    };
    const block = (): string[] => {
      const text = read(project, '.git/info/exclude');
      const start = text.indexOf('# [teamai:delivered:start]');
      const end = text.indexOf('# [teamai:delivered:end]');
      if (start === -1 || end === -1) return [];
      return text.slice(start, end).split('\n').slice(1).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
    };
    const untracked = (): string[] => git(['status', '--porcelain', '--untracked-files=all'], project).split('\n').filter((line) => line.startsWith('??'));

    const init = await runCLI(INIT, true);
    expect(init.code, init.output).toBe(0);
    const first = await runCLI(['pull'], true);
    expect(first.code, first.output).toBe(0);

    // Claude's servers stay in the project's .mcp.json (upstream moves them to
    // ~/.claude.json, which a project-only HOME hides from the member's tools).
    expect(JSON.parse(read(project, '.mcp.json')).mcpServers['team-mcp']).toBeDefined();
    expect(fs.existsSync(path.join(home, '.claude.json')) && read(home, '.claude.json').includes('team-mcp')).toBe(false);
    expect(block()).toEqual(expect.arrayContaining(['/.mcp.json', '/.claude/settings.local.json', '/.claude/rules/team-rule.md']));
    // A file the project tracks is never listed: an exclude line would not apply to it.
    expect(block().some((line) => line.includes('project-rule') || line.startsWith('/.agents/'))).toBe(false);
    expect(untracked(), first.output).toEqual([]);

    // A skill with extra files the team adds later, delivered by an ordinary pull (the session-start one).
    writeFile(seed, 'skills/late/SKILL.md', '---\nname: late\ndescription: late fixture\n---\nLate.\n');
    writeFile(seed, 'skills/late/SOURCE.md', 'Where it came from.\n');
    writeFile(seed, 'skills/late/agents/openai.yaml', 'name: late\n');
    pushTeam('late skill');
    const second = await runCLI(['pull'], true);
    expect(second.code, second.output).toBe(0);
    expect(fs.existsSync(path.join(project, '.claude/skills/late/agents/openai.yaml'))).toBe(true);
    expect(block()).toEqual(expect.arrayContaining([
      '/.claude/skills/late/SKILL.md', '/.claude/skills/late/SOURCE.md', '/.claude/skills/late/agents/openai.yaml',
    ]));
    expect(untracked(), second.output).toEqual([]);

    // The team removes it as `teamai remove` does (a tombstone): its copies go, and so do their lines.
    fs.rmSync(path.join(seed, 'skills/late'), { recursive: true });
    writeFile(seed, 'skills/.removed', 'late\n');
    pushTeam('drop late skill');
    const third = await runCLI(['pull'], true);
    expect(third.code, third.output).toBe(0);
    expect(fs.existsSync(path.join(project, '.claude/skills/late')), third.output).toBe(false);
    expect(block().some((line) => line.includes('/skills/late/'))).toBe(false);
    expect(untracked(), third.output).toEqual([]);
  }, 240_000);

  it('without the variable: upstream behaviour (hooks in HOME, git hook in the project)', async () => {
    const init = await runCLI(INIT, false);
    expect(init.code, init.output).toBe(0);
    expect(read(home, '.claude/settings.json')).toMatch(/teamai hook-dispatch session-start --tool claude/);
    expect(fs.existsSync(path.join(project, '.claude/settings.local.json'))
      && read(project, '.claude/settings.local.json').includes('hook-dispatch')).toBe(false);
    expect(gitHookInstalled()).toBe(true);
  }, 180_000);
});
