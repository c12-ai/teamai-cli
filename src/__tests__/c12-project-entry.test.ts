/**
 * C12 fork: the team version replaces a same-named entry in every mode: a copy
 * the member edited, a symlink (dangling too), a git-tracked file, or one
 * teamai did not deliver. Upstream (#993) keeps all of these as the member's;
 * the fork keeps that judgement (`judgeCopy`) and overrides it in
 * `keepsEditedCopy`, which every writer asks before it writes. The project's
 * link target is never written through, and each replaced name is warned
 * about once.
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
  // A team repo with history: upstream proves a copy with no record teamai's against it.
  execFileSync('git', ['init', '-q'], { cwd: path.join(root, 'team') });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: path.join(root, 'team') });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'team'], { cwd: path.join(root, 'team') });
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
const ruleOrigin = () => ({ repoPath: path.join(root, 'team'), pathspec: 'rules/team-rule.md' });
const skillOrigin = () => ({ repoPath: path.join(root, 'team'), pathspec: 'skills/team-skill' });
const ruleTarget = () => ({ tool: 'claude' as const, dest: dest(), content: RULE, origin: ruleOrigin() });
const skillTarget = () => ({ tool: 'claude' as const, dest: skillDest(), origin: skillOrigin() });
const warnings = (): string => vi.mocked(log.warn).mock.calls.map(String).join('\n');

/** Ask as a writer does, then name the replacements as pull does. */
async function deliver(previous: Record<string, string> | undefined, item: ResourceItem, target: ReturnType<typeof ruleTarget> | ReturnType<typeof skillTarget>) {
  const ledger = openLedger(previous);
  const kept = await keepsEditedCopy(ledger, item, target);
  const replaced = ledger.replaced.map((entry) => entry.replaces);
  reportKept(ledger, 'project');
  return { kept, replaced };
}

describe('keepsEditedCopy never keeps a copy: the team version wins (C12 fork)', () => {
  it('overwrites a copy the member edited since teamai delivered it, where upstream keeps it', async () => {
    write(dest(), '# Edited by the member\n');
    // Upstream's judgement is still "keep": only the fork's override writes.
    expect((await judgeCopy({ [dest()]: contentHash(RULE) }, rule, ruleTarget())).kind).toBe('keep');
    expect(await deliver({ [dest()]: contentHash(RULE) }, rule, ruleTarget())).toEqual({ kept: false, replaced: ['edited'] });
    expect(warnings()).toMatch(/Overwrote local edits in .*team-rule\.md with the team version/);
  });

  it('replaces a file teamai did not deliver, where upstream keeps it as the member\'s', async () => {
    write(dest(), '# Project rule\n');
    expect((await judgeCopy(undefined, rule, ruleTarget())).kind).toBe('member');
    expect(await deliver(undefined, rule, ruleTarget())).toEqual({ kept: false, replaced: ['foreign'] });
    expect(warnings()).toMatch(/Replaced .*team-rule\.md \(not delivered by teamai\)/);
  });

  it('replaces a git-tracked file that differs from the team version', async () => {
    write(dest(), '# Project rule\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'project']);
    expect(await deliver(undefined, rule, ruleTarget())).toEqual({ kept: false, replaced: ['tracked'] });
    expect(warnings()).toMatch(/Replaced .*team-rule\.md \(tracked by git\)/);
  });

  it('removes a symlink, so the write never reaches its target', async () => {
    const outside = path.join(project, '.agents', 'team-rule.md');
    write(outside, '# Project rule\n');
    fs.symlinkSync('../../.agents/team-rule.md', dest());
    expect(await deliver(undefined, rule, ruleTarget())).toEqual({ kept: false, replaced: ['symlink'] });
    expect(fs.lstatSync(dest(), { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.readFileSync(outside, 'utf8')).toBe('# Project rule\n');
    expect(warnings()).toMatch(/Replaced .*team-rule\.md \(a symlink\)/);
  });

  it('removes a link inside a skill directory, and the member\'s entry blocking a team file', async () => {
    write(path.join(skillDest(), 'SKILL.md'), '# Member skill\n');
    fs.symlinkSync('/etc/hostname', path.join(skillDest(), 'link'));
    expect(await deliver(undefined, skill, skillTarget())).toEqual({ kept: false, replaced: ['symlink'] });
    expect(fs.lstatSync(path.join(skillDest(), 'link'), { throwIfNoEntry: false })).toBeUndefined();
  });

  it('names a replaced path once, however many writers ask', async () => {
    write(dest(), '# Project rule\n');
    const ledger = openLedger(undefined);
    await keepsEditedCopy(ledger, rule, ruleTarget());
    await keepsEditedCopy(ledger, rule, ruleTarget());
    reportKept(ledger, 'project');
    expect(warnings().match(/Replaced /g)).toHaveLength(1);
  });

  it('says nothing for a copy that is already the team version, or missing', async () => {
    expect(await deliver(undefined, rule, ruleTarget())).toEqual({ kept: false, replaced: [] });
    write(dest(), RULE);
    expect(await deliver({ [dest()]: contentHash(RULE) }, rule, ruleTarget())).toEqual({ kept: false, replaced: [] });
    expect(warnings()).toBe('');
  });
});
