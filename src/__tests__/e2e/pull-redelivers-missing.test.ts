/**
 * E2E (c12 fork): a plain pull of an unchanged team repo re-delivers a
 * delivered copy that was deleted meanwhile, and still takes the "Already
 * synced" fast path when nothing is missing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

interface RunResult {
  code: number | null;
  output: string;
}

function runCLI(args: string[], cwd: string, home: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: { ...process.env, ...GIT_ENV, HOME: home, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } });
}

const SKILL_MD = '---\nname: team-skill\ndescription: Team skill fixture\n---\n\n# Team skill\n';
const agentYaml = (instructions: string): string => [
  'name: team-helper',
  'description: Team helper fixture',
  'targets:',
  '  - claude',
  '  - cursor',
  'instructions: |',
  `  ${instructions}`,
  '',
].join('\n');

describe('pull re-delivers a deleted delivered copy', () => {
  let sandbox: string;
  let home: string;
  let projectRoot: string;

  const claudeSkill = () => path.join(projectRoot, '.claude', 'skills', 'team-skill');
  const claudeScript = () => path.join(claudeSkill(), 'scripts', 'run.sh');
  const claudeRule = () => path.join(projectRoot, '.claude', 'rules', 'team-rule.md');
  const claudeAgent = () => path.join(projectRoot, '.claude', 'agents', 'team-helper.md');
  const read = (file: string) => fs.readFileSync(file, 'utf8');

  beforeEach(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-redeliver-e2e-')));
    home = path.join(sandbox, 'home');
    projectRoot = path.join(sandbox, 'project');
    const seed = path.join(sandbox, 'seed');
    const remote = path.join(sandbox, 'team-remote.git');
    const teamRepo = path.join(projectRoot, '.teamai', 'team-repo');

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(seed, 'skills', 'team-skill', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(seed, 'rules'), { recursive: true });
    fs.mkdirSync(path.join(seed, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'team: redeliver-e2e\nrepo: https://example.com/team.git\nprovider: tgit\n');
    fs.writeFileSync(path.join(seed, 'skills', 'team-skill', 'SKILL.md'), SKILL_MD);
    fs.writeFileSync(path.join(seed, 'skills', 'team-skill', 'scripts', 'run.sh'), 'echo one\n');
    fs.writeFileSync(path.join(seed, 'rules', 'team-rule.md'), '# Team rule\n\nVersion one.\n');
    fs.writeFileSync(path.join(seed, 'agents', 'team-helper.yaml'), agentYaml('Version one.'));
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);

    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.claude', 'settings.json'), '{}\n');
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), '.teamai/\n.cursor/\n.claude/\n');
    git(['init', '-q', '-b', 'main'], projectRoot);
    git(['add', '-A'], projectRoot);
    git(['commit', '-q', '-m', 'project'], projectRoot);
    git(['clone', '-q', remote, teamRepo], sandbox);
    fs.writeFileSync(path.join(projectRoot, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${teamRepo}`,
      `  remote: ${remote}`,
      'username: ci-redeliver',
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${projectRoot}`,
      'enabledAgents: [claude, cursor]',
      '',
    ].join('\n'));
  });

  afterEach(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const pull = async (...flags: string[]): Promise<string> => {
    const r = await runCLI(['pull', ...flags], projectRoot, home);
    expect(r.code, r.output).toBe(0);
    return r.output;
  };

  it('re-delivers a deleted skill file and rule/agent file without --force', async () => {
    await pull();
    fs.rmSync(claudeScript());
    fs.rmSync(claudeRule());
    fs.rmSync(claudeAgent());

    const output = await pull();

    expect(output).toContain('delivered file(s) missing; syncing');
    expect(output).not.toContain('Already synced');
    expect(read(claudeScript())).toBe('echo one\n');
    expect(read(claudeRule())).toContain('Version one.');
    expect(read(claudeAgent())).toContain('Version one.');
  });

  it('takes the fast path when nothing is missing, even if a copy was edited', async () => {
    await pull();
    fs.writeFileSync(claudeScript(), 'echo mine\n');

    const output = await pull();

    expect(output).toContain('Already synced');
    expect(output).not.toContain('delivered file(s) missing');
    expect(read(claudeScript())).toBe('echo mine\n');
  });
});
