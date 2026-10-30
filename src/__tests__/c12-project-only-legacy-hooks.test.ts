/**
 * C12 fork: before 0.28, project-only mode kept its hook index in the
 * project's own `.teamai/managed-hooks.json`. 0.28 keeps the index in the data
 * home, and upstream moves only the Copilot records out of the old file, which
 * would then stay in the project for good, an untracked teamai file no exclude
 * block lists. In project-only mode every record moves and the file goes.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateLegacyManagedHooks } from '../hooks.js';
import { getManagedHooksPath, legacyManagedHooksPath, type LocalConfig } from '../types.js';

let tmp: string;
let project: string;
let config: LocalConfig;
const record = { key: 'team-prompt-hook', event: 'UserPromptSubmit', command: 'team-prompt-hook' };

beforeEach(async () => {
  tmp = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-c12-legacy-hooks-')));
  project = path.join(tmp, 'project');
  await fse.ensureDir(project);
  execFileSync('git', ['init', '-q'], { cwd: project });
  config = {
    repo: { localPath: path.join(tmp, 'team'), remote: 'https://example.invalid/team.git' },
    username: 'm',
    scope: 'project',
    projectRoot: project,
    dataHome: path.join(tmp, 'home', '.teamai', 'projects', 'project-0123456789abcdef'),
  } as unknown as LocalConfig;
  await fse.outputJson(legacyManagedHooksPath(project), { claude: [record] });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fse.remove(tmp);
});

describe('migrateLegacyManagedHooks in project-only mode (C12 fork)', () => {
  it('moves every record into the data home and deletes the project file', async () => {
    vi.stubEnv('TEAMAI_PROJECT_ONLY', '1');
    await migrateLegacyManagedHooks(config);
    expect(await fse.pathExists(legacyManagedHooksPath(project))).toBe(false);
    expect((await fse.readJson(getManagedHooksPath(config))).claude).toEqual([record]);
  });

  it('outside it, leaves the non-Copilot records where they are, as upstream does', async () => {
    await migrateLegacyManagedHooks(config);
    expect((await fse.readJson(legacyManagedHooksPath(project))).claude).toEqual([record]);
  });
});
