/**
 * C12 fork: the team version replaces a same-named entry in every mode, even
 * one that is a symlink (dangling too) or that git tracks. The project's link
 * target is never written through, and each replaced name is warned about once.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn(), persist: vi.fn() },
}));

import { contentHash, judgeCopy, keepsEditedCopy, openLedger, reportKept } from '../resources/delivered-copies.js';
import { log } from '../utils/logger.js';
import type { ResourceItem } from '../types.js';

const RULE = '# Team rule\n';
const SKILL = '---\nname: team-skill\ndescription: Team\n---\nTeam version.\n';

let root: string;
let project: string;
let rule: ResourceItem;
let skill: ResourceItem;

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
  write(path.join(root, 'team', 'skills', 'team-skill', 'SKILL.md'), SKILL);
  rule = { name: 'team-rule', type: 'rules', sourcePath: path.join(root, 'team', 'rules', 'team-rule.md'), relativePath: 'rules/team-rule.md' };
  skill = { name: 'team-skill', type: 'skills', sourcePath: path.join(root, 'team', 'skills', 'team-skill'), relativePath: 'skills/team-skill' };
  fs.mkdirSync(path.join(project, '.claude', 'rules'), { recursive: true });
  git(['init', '-q']);
  vi.mocked(log.warn).mockClear();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const dest = (): string => path.join(project, '.claude', 'rules', 'team-rule.md');
const skillDest = (): string => path.join(project, '.claude', 'skills', 'team-skill');
const judge = (previous?: Record<string, string>) => judgeCopy(previous, rule, { tool: 'claude', dest: dest(), content: RULE });
const warnings = (): string => vi.mocked(log.warn).mock.calls.map(String).join('\n');

describe('judgeCopy replaces the project\'s same-named entries (C12 fork)', () => {
  it('replaces a symlink to a copy identical to the team version', async () => {
    write(path.join(project, '.agents', 'team-rule.md'), RULE);
    fs.symlinkSync('../../.agents/team-rule.md', dest());
    expect(await judge()).toEqual({ kind: 'write', replaces: 'symlink' });
  });

  it('replaces a dangling symlink, even one teamai has a record of', async () => {
    fs.symlinkSync('../../no-such-file.md', dest());
    expect(await judge({ [dest()]: contentHash(RULE) })).toEqual({ kind: 'write', replaces: 'symlink' });
  });

  it('replaces a tracked file that differs from the team version', async () => {
    write(dest(), '# Project rule\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'project']);
    expect(await judge()).toEqual({ kind: 'write', replaces: 'foreign' });
  });

  it('leaves a tracked file already holding the team version unflagged', async () => {
    write(dest(), RULE);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'project']);
    expect(await judge({ [dest()]: contentHash(RULE) })).toEqual({ kind: 'write' });
  });

  it('replaces a skill directory git tracks a file under', async () => {
    write(path.join(skillDest(), 'SKILL.md'), '# project skill\n');
    git(['add', '-A']);
    expect(await judgeCopy(undefined, skill, { tool: 'claude', dest: skillDest() })).toMatchObject({ kind: 'write' });
  });

  it('writes an untracked regular copy, or none, with no replacement', async () => {
    expect(await judge()).toEqual({ kind: 'write' });
    write(dest(), RULE);
    expect(await judge()).toEqual({ kind: 'write' });
  });
});

describe('keepsEditedCopy carries out the replacement and warns once per name', () => {
  it('removes a symlink so the write cannot reach its target, and warns', async () => {
    const outside = path.join(project, '.agents', 'team-rule.md');
    write(outside, '# Project rule\n');
    fs.symlinkSync('../../.agents/team-rule.md', dest());
    const ledger = openLedger(undefined);
    const target = { tool: 'claude' as const, dest: dest(), content: RULE };

    expect(await keepsEditedCopy(ledger, rule, target)).toBe(false);
    expect(fs.lstatSync(dest(), { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.readFileSync(outside, 'utf8')).toBe('# Project rule\n');

    await keepsEditedCopy(ledger, rule, target);
    reportKept(ledger, 'project');
    expect(warnings().match(/Replaced /g)).toHaveLength(1);
    expect(warnings()).toMatch(/Replaced .*team-rule\.md \(a symlink\)/);
  });

  it('warns for a replaced tracked file and leaves its bytes to the write', async () => {
    write(dest(), '# Project rule\n');
    git(['add', '-A']);
    const ledger = openLedger(undefined);
    expect(await keepsEditedCopy(ledger, rule, { tool: 'claude', dest: dest(), content: RULE })).toBe(false);
    reportKept(ledger, 'project');
    expect(warnings()).toMatch(/Replaced .*team-rule\.md/);
  });
});
