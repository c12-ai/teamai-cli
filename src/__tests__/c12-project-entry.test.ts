/**
 * C12 fork: pull never replaces a symlink, even a dangling one, or a path git
 * tracks, at a delivery destination. Such an entry is the project's own (a
 * repo that links `.claude/skills/<name>` to its committed `.agents/skills`),
 * and replacing it shows up as a tracked deletion in the project. It holds
 * whatever bytes it holds: a link to a copy identical to the team version is
 * kept all the same, and so is one teamai has a record of.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentHash, judgeCopy } from '../resources/delivered-copies.js';
import type { ResourceItem } from '../types.js';

const RULE = '# Team rule\n';

let root: string;
let project: string;
let rule: ResourceItem;

function git(args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: project, stdio: 'ignore' });
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-c12-entry-')));
  project = path.join(root, 'project');
  write(path.join(root, 'team', 'rules', 'team-rule.md'), RULE);
  rule = { name: 'team-rule', type: 'rules', sourcePath: path.join(root, 'team', 'rules', 'team-rule.md'), relativePath: 'rules/team-rule.md' };
  fs.mkdirSync(path.join(project, '.claude', 'rules'), { recursive: true });
  git(['init', '-q']);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const dest = (): string => path.join(project, '.claude', 'rules', 'team-rule.md');
const judge = (previous?: Record<string, string>) => judgeCopy(previous, rule, { tool: 'claude', dest: dest(), content: RULE });

describe('judgeCopy keeps the project\'s own entries (C12 fork)', () => {
  it('keeps a symlink to a copy identical to the team version', async () => {
    write(path.join(project, '.agents', 'team-rule.md'), RULE);
    fs.symlinkSync('../../.agents/team-rule.md', dest());
    expect(await judge()).toEqual({ kind: 'keep', teamChanged: false, foreign: true, project: true });
  });

  it('keeps a dangling symlink, even one teamai has a record of', async () => {
    fs.symlinkSync('../../no-such-file.md', dest());
    expect(await judge({ [dest()]: contentHash(RULE) })).toMatchObject({ kind: 'keep', project: true });
  });

  it('keeps a file git tracks, even one holding the team version', async () => {
    write(dest(), RULE);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'project']);
    expect(await judge()).toMatchObject({ kind: 'keep', project: true });
  });

  it('keeps a skill directory git tracks a file under', async () => {
    write(path.join(project, '.claude', 'skills', 'team-skill', 'SKILL.md'), '# project skill\n');
    git(['add', '-A']);
    const skill: ResourceItem = { name: 'team-skill', type: 'skills', sourcePath: path.join(root, 'team', 'rules'), relativePath: 'skills/team-skill' };
    const verdict = await judgeCopy(undefined, skill, { tool: 'claude', dest: path.join(project, '.claude', 'skills', 'team-skill') });
    expect(verdict).toMatchObject({ kind: 'keep', project: true });
  });

  it('writes an untracked regular copy, or none, as before', async () => {
    expect(await judge()).toEqual({ kind: 'write' });
    write(dest(), RULE);
    expect(await judge()).toEqual({ kind: 'write' });
  });

  it('writes outside a git work tree', async () => {
    fs.rmSync(path.join(project, '.git'), { recursive: true });
    write(dest(), RULE);
    expect(await judge({ [dest()]: contentHash(RULE) })).toEqual({ kind: 'write' });
  });
});
