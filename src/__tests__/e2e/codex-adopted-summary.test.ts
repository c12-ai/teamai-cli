import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = path.join(root, 'dist/index.js');
let sandbox: string | undefined;

afterEach(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  sandbox = undefined;
});

describe('built CLI adopted-knowledge notice', () => {
  it('shows Codex the Claude summary text without context, continuation or next-prompt replay', () => {
    if (!fs.existsSync(cli)) throw new Error('Run npm run build before this test.');
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-codex-summary-')));
    const home = path.join(sandbox, 'home');
    const data = path.join(home, '.teamai');
    const repo = path.join(data, 'team-repo');
    const origin = path.join(sandbox, 'origin.git');
    fs.mkdirSync(repo, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      SYSTEMROOT: process.env.SYSTEMROOT,
      WINDIR: process.env.WINDIR,
      TMPDIR: process.env.TMPDIR,
      TMP: process.env.TMP,
      TEMP: process.env.TEMP,
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      TEAMAI_PROJECT_ONLY: '1',
      TEAMAI_UPVOTE_JUDGE: '0',
      TEAMAI_CONTRIBUTE_HINT_DISABLED: '1',
      NO_COLOR: '1',
    };
    fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\nname = Tester\nemail = tester@example.invalid\n[gc]\nauto = 0\n[maintenance]\nauto = false\n[protocol "file"]\nallow = always\n');
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, env, stdio: 'pipe' });
    fs.writeFileSync(path.join(repo, 'teamai.yaml'), YAML.stringify({ team: 'fixture', provider: 'git', usageReport: false, sharing: { contributeHint: { enabled: false } } }));
    git(['init', '-q', '-b', 'main']);
    git(['add', '.']);
    git(['commit', '-qm', 'fixture']);
    git(['clone', '-q', '--bare', repo, origin]);
    git(['remote', 'add', 'origin', origin]);
    fs.writeFileSync(path.join(data, 'config.yaml'), YAML.stringify({
      repo: { localPath: repo, remote: origin, kind: 'git' },
      username: 'tester', scope: 'user', additionalRoles: [], enabledAgents: ['codex', 'claude'], updatePolicy: 'skip',
    }));
    const log = path.join(data, 'dashboard', 'recall.jsonl');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const doc = path.join(repo, 'learnings', 'doc-a.md');
    fs.mkdirSync(path.dirname(doc));
    fs.writeFileSync(doc, '# Fixture knowledge\n');
    const seedEvidence = (session: string) => {
      const ts = new Date().toISOString();
      const records = [
        { kind: 'run', ts, run: session, session, agent: 'codex', via: 'env', unambiguous: true, docs: [{ key: 'doc-a', scope: 'user', path: doc, score: 1, eligible: true }] },
        { kind: 'evidence', ts, id: `read-${session}`, session, path: doc, status: 'success', simple: true },
      ];
      fs.appendFileSync(log, records.map((line) => JSON.stringify(line)).join('\n') + '\n');
    };
    const dispatch = (event: string, tool: string, session: string) => {
      const result = spawnSync(process.execPath, [cli, 'hook-dispatch', event, '--tool', tool], {
        cwd: sandbox, env, encoding: 'utf8', timeout: 30_000,
        input: JSON.stringify({ session_id: session, cwd: sandbox, hook_event_name: event === 'stop' ? 'Stop' : event === 'subagent-stop' ? 'SubagentStop' : 'UserPromptSubmit', prompt: 'Continue.' }),
      });
      if (result.error) throw result.error;
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };

    seedEvidence('codex-summary');
    expect(dispatch('subagent-stop', 'codex', 'codex-summary')).toBe('');
    const pendingBeforeStop = YAML.parse(fs.readFileSync(path.join(data, 'user-votes', 'tester.yaml'), 'utf8'));
    expect(pendingBeforeStop.upvotedSessions['codex-summary'].pendingSummaryDocIds).toEqual(['doc-a']);
    expect(pendingBeforeStop.votes['doc-a'].upvoted_count).toBe(1);
    const codex = JSON.parse(dispatch('stop', 'codex', 'codex-summary'));
    expect(codex).toEqual({ systemMessage: '[teamai] Adopted team knowledge this session: doc-a' });
    expect(dispatch('stop', 'codex', 'codex-summary')).toBe('');
    expect(dispatch('prompt-submit', 'codex', 'codex-summary')).toBe('');

    seedEvidence('claude-summary');
    expect(dispatch('subagent-stop', 'claude', 'claude-summary')).toBe('');
    const claude = JSON.parse(dispatch('stop', 'claude', 'claude-summary'));
    expect(claude.hookSpecificOutput).toEqual({ hookEventName: 'Stop', additionalContext: codex.systemMessage });
    const votes = YAML.parse(fs.readFileSync(path.join(data, 'user-votes', 'tester.yaml'), 'utf8'));
    expect(votes.votes['doc-a'].upvoted_count).toBe(2);
    expect(votes.upvotedSessions['codex-summary'].pendingSummaryDocIds).toEqual([]);
    expect(votes.upvotedSessions['claude-summary'].pendingSummaryDocIds).toEqual([]);
    expect(dispatch('stop', 'claude', 'claude-summary')).toBe('');
    expect(dispatch('prompt-submit', 'claude', 'claude-summary')).toBe('');
  }, 60_000);
});
