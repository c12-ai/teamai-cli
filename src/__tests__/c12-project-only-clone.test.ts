/**
 * C12 fork: in project-only mode (`TEAMAI_PROJECT_ONLY=1`) the GitHub clone
 * keeps no credential. Upstream writes the token into the clone's remote URL,
 * i.e. into `.git/config` on disk; a container that receives the token only
 * for setup must not end up storing it. The token then authenticates the clone
 * through a header in the child's environment (not its argv), and the remote
 * URL stays plain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockedSpawnSync } = vi.hoisted(() => ({
  mockedSpawnSync: vi.fn((..._args: unknown[]) => ({ status: 0, stdout: '', stderr: '' })),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: mockedSpawnSync,
  exec: vi.fn(),
  execSync: vi.fn(),
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  fork: vi.fn(),
}));

import { ghRepoClone } from '../providers/github/gh-cli.js';

const ORIGINAL_ENV = { ...process.env };
const TOKEN = 'ghs_projectonlyfixture';

function cloneCall(): { args: string[]; env: NodeJS.ProcessEnv } {
  const call = mockedSpawnSync.mock.calls.find((c) => c[0] === 'git');
  if (!call) throw new Error('git clone was not launched');
  return { args: call[1] as string[], env: (call[2] as { env: NodeJS.ProcessEnv }).env };
}

beforeEach(() => {
  mockedSpawnSync.mockClear();
  process.env.GITHUB_TOKEN = TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GIT_CONFIG_COUNT;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('ghRepoClone in project-only mode (C12 fork)', () => {
  it('clones a plain URL and passes the token only in the child environment', () => {
    process.env.TEAMAI_PROJECT_ONLY = '1';
    ghRepoClone('owner/repo', '/tmp/clone');
    const { args, env } = cloneCall();
    expect(args).toEqual(['clone', 'https://github.com/owner/repo.git', '/tmp/clone']);
    expect(args.join(' ')).not.toContain(TOKEN);
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraHeader');
    const header = env.GIT_CONFIG_VALUE_0 ?? '';
    const decoded = Buffer.from(header.replace('Authorization: Basic ', ''), 'base64').toString();
    expect(decoded).toBe(`x-access-token:${TOKEN}`);
  });

  it('keeps the git config entries the caller already passes', () => {
    process.env.TEAMAI_PROJECT_ONLY = '1';
    process.env.GIT_CONFIG_COUNT = '2';
    process.env.GIT_CONFIG_KEY_0 = 'credential.https://github.com.helper';
    process.env.GIT_CONFIG_VALUE_0 = '';
    ghRepoClone('owner/repo', '/tmp/clone');
    const { env } = cloneCall();
    expect(env.GIT_CONFIG_COUNT).toBe('3');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_KEY_2).toBe('http.https://github.com/.extraHeader');
  });

  it('without the variable: upstream behaviour, token in the remote URL', () => {
    delete process.env.TEAMAI_PROJECT_ONLY;
    ghRepoClone('owner/repo', '/tmp/clone');
    const { args } = cloneCall();
    expect(args[1]).toBe(`https://x-access-token:${TOKEN}@github.com/owner/repo.git`);
  });
});
