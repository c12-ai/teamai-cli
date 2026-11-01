/**
 * C12 fork: in project-only mode teamai writes no Codex hook file, because the
 * only project one (`.codex/hooks.json`) is committed (`projectOnlyToolPaths`).
 * The project commits its own SessionStart entry there instead, so the
 * instruction-channel check must read that file rather than report a missing
 * hooks file whose only suggested fix (`teamai hooks inject`) cannot work in
 * this mode, and must never write it.
 */
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channelReadiness } from '../instruction-targets.js';
import { TeamaiConfigSchema, type LocalConfig } from '../types.js';

let tmp: string;
let home: string;
let project: string;
let config: LocalConfig;
const teamConfig = () => TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.invalid/x/team.git' });

/** A Claude-shaped Codex hooks file with one SessionStart command. */
function hooksFile(command: string): object {
  return {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'python3 .codex/hooks/other.py' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command, timeout: 15 }] }],
    },
  };
}

beforeEach(async () => {
  tmp = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-c12-codex-readiness-')));
  home = path.join(tmp, 'home');
  project = path.join(tmp, 'project');
  await fse.ensureDir(home);
  await fse.ensureDir(project);
  vi.stubEnv('HOME', home);
  config = {
    repo: { localPath: path.join(tmp, 'team'), remote: 'https://example.invalid/x/team.git' },
    username: 'm',
    additionalRoles: [],
    scope: 'project',
    projectRoot: project,
  } as unknown as LocalConfig;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fse.remove(tmp);
});

describe('channelReadiness codex-hooks in project-only mode (C12 fork)', () => {
  it.each([
    ['meta repo launcher', 'codex', './.tools/bin/teamai hook-dispatch session-start --tool codex'],
    ['nested repo launcher', 'codex', '[ -x ../.tools/bin/teamai ] && ../.tools/bin/teamai hook-dispatch session-start --tool codex || true'],
    ['another codex-family id', 'codex-internal', './.tools/bin/teamai hook-dispatch session-start --tool codex-internal'],
  ])('ready with a committed SessionStart entry (%s), and leaves the file as it was', async (_name, tool, command) => {
    vi.stubEnv('TEAMAI_PROJECT_ONLY', '1');
    const dir = tool === 'codex' ? '.codex' : `.${tool}`;
    const file = path.join(project, dir, 'hooks.json');
    await fse.outputJson(file, hooksFile(command), { spaces: 2 });
    const before = await fse.readFile(file, 'utf8');

    const channel = await channelReadiness(tool, 'codex-hooks', { teamConfig: teamConfig(), localConfig: config });

    expect(channel.ready).toBe(true);
    expect(await fse.readFile(file, 'utf8')).toBe(before);
  });

  it.each([
    ['no hooks file', undefined],
    ['no teamai SessionStart entry', 'python3 .codex/hooks/session.py'],
    ['an entry for another tool', './.tools/bin/teamai hook-dispatch session-start --tool codex-internal'],
  ])('not ready with %s, and the fix names the committed file instead of `teamai hooks inject`', async (_name, command) => {
    vi.stubEnv('TEAMAI_PROJECT_ONLY', '1');
    const file = path.join(project, '.codex', 'hooks.json');
    if (command !== undefined) await fse.outputJson(file, hooksFile(command));

    const channel = await channelReadiness('codex', 'codex-hooks', { teamConfig: teamConfig(), localConfig: config });

    expect(channel.ready).toBe(false);
    expect(channel.fix).toContain(file);
    expect(channel.fix).toContain('teamai hook-dispatch session-start --tool codex');
    expect(channel.fix).not.toContain('teamai hooks inject');
    if (command === undefined) expect(await fse.pathExists(file)).toBe(false);
  });

  it('outside project-only mode, checks the HOME hooks file teamai writes, as upstream does', async () => {
    await fse.outputJson(path.join(project, '.codex', 'hooks.json'),
      hooksFile('./.tools/bin/teamai hook-dispatch session-start --tool codex'));

    const channel = await channelReadiness('codex', 'codex-hooks', { teamConfig: teamConfig(), localConfig: config });

    expect(channel.ready).toBe(false);
    expect(channel.fix).toContain(path.join(home, '.codex', 'hooks.json'));
    expect(channel.fix).toContain('teamai hooks inject');
  });
});
