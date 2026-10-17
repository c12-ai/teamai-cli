/**
 * C12 fork: refreshing the team clone survives a second teamai process
 * fetching the same clone at the same time (a session-start pull beside
 * `init`). `git pull` merges whatever FETCH_HEAD lists, and two concurrent
 * fetches leave it listing the branch twice: "Cannot fast-forward to multiple
 * branches". The refresh fetches its branch by explicit refspec and merges
 * origin/<branch> by name. Real git, no network.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pullRepoFastForward } from '../utils/git.js';

let root: string;
let seed: string;
let clone: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-c12-refresh-')));
  seed = path.join(root, 'seed');
  clone = path.join(root, 'clone');
  fs.mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'commit', '-q', '--allow-empty', '-m', 'seed');
  git(root, 'clone', '-q', '--bare', seed, 'team.git');
  git(root, 'clone', '-q', path.join(root, 'team.git'), 'clone');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('team clone refresh under a concurrent fetch (C12 fork)', () => {
  it('two refreshes of one clone at once both fast-forward it', async () => {
    for (let round = 0; round < 10; round++) {
      git(seed, 'commit', '-q', '--allow-empty', '-m', `round ${round}`);
      git(seed, 'push', '-q', path.join(root, 'team.git'), 'main');
      const results = await Promise.allSettled([pullRepoFastForward(clone), pullRepoFastForward(clone)]);
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(failed.map((r) => String(r.reason))).toEqual([]);
      expect(git(clone, 'rev-parse', 'HEAD')).toBe(git(seed, 'rev-parse', 'HEAD'));
    }
  });
});
