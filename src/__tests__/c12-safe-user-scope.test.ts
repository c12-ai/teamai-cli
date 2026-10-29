import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn(), persist: vi.fn() },
}));

import { SkillsHandler } from '../resources/skills.js';
import { RulesHandler } from '../resources/rules.js';
import { judgeCopy, openLedger, recordDelivered, reportKept, type DeliveredHashes } from '../resources/delivered-copies.js';
import { log } from '../utils/logger.js';
import type { LocalConfig, ResourceItem, TeamaiConfig } from '../types.js';

// c12 fork: a same-named skill, rule or agent takes the team version, while a
// member's own file with a name the team does not deliver is never teamai's to
// delete.

let tmp: string;
let home: string;
let repo: string;

const teamConfig = {
  team: 'test',
  description: '',
  repo: 'https://example.com/team.git',
  provider: 'git',
  reviewers: [],
  sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: false } },
  toolPaths: { claude: { skills: '.claude/skills', rules: '.claude/rules' } },
} as unknown as TeamaiConfig;

const localConfig = (): LocalConfig => ({
  repo: { localPath: repo, remote: 'https://example.com/team.git' },
  username: 'member',
  additionalRoles: [],
  scope: 'user',
} as unknown as LocalConfig);

const skillItem = (name: string): ResourceItem => ({
  name, type: 'skills', sourcePath: path.join(repo, 'skills', name), relativePath: `skills/${name}`, status: 'new',
});

beforeEach(async () => {
  tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-c12-'));
  home = path.join(tmp, 'home');
  repo = path.join(tmp, 'team-repo');
  await fse.ensureDir(path.join(home, '.claude', 'skills'));
  await fse.ensureDir(path.join(home, '.claude', 'rules'));
  vi.stubEnv('HOME', home);
  vi.mocked(log.warn).mockClear();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fse.remove(tmp);
});

describe('a same-named skill teamai did not deliver (the team version replaces it)', () => {
  beforeEach(async () => {
    await fse.outputFile(path.join(repo, 'skills', 'tdd', 'SKILL.md'), '---\nname: tdd\ndescription: Team TDD\n---\nTeam version.\n');
    await fse.outputFile(path.join(home, '.claude', 'skills', 'tdd', 'SKILL.md'), '---\nname: tdd\ndescription: Mine\n---\nMy own skill.\n');
  });

  it('is judged the member\'s by upstream with no record at all, as on the first pull after init', async () => {
    const dest = path.join(home, '.claude', 'skills', 'tdd');
    const origin = { repoPath: repo, pathspec: 'skills/tdd' };
    // Upstream's judgement (#993); keepsEditedCopy turns it into a replacement (c12-project-entry.test.ts).
    expect(await judgeCopy(undefined, skillItem('tdd'), { tool: 'claude', dest, origin })).toEqual({ kind: 'member' });
  });

  it('is replaced by the team version, recorded, and named in a warning', async () => {
    const ledger = openLedger(undefined);
    await new SkillsHandler().pullItem(skillItem('tdd'), teamConfig, localConfig(), ledger);
    reportKept(ledger, 'user');

    const dest = path.join(home, '.claude', 'skills', 'tdd');
    const text = await fse.readFile(path.join(dest, 'SKILL.md'), 'utf8');
    expect(text).toContain('Team version.');
    expect(text).not.toContain('My own skill.');
    expect(Object.keys(ledger.hashes).some((file) => file.startsWith(dest))).toBe(true);
    expect(vi.mocked(log.warn).mock.calls.map(String).join('\n')).toMatch(/Replaced .*tdd .*not delivered by teamai/);
  });

  it('is still replaced once teamai delivered it, so team updates arrive', async () => {
    const dest = path.join(home, '.claude', 'skills', 'tdd');
    const previous: DeliveredHashes = {};
    await recordDelivered(previous, dest, path.join(home, '.claude', 'skills', 'tdd'));
    await new SkillsHandler().pullItem(skillItem('tdd'), teamConfig, localConfig(), openLedger(previous));
    expect(await fse.readFile(path.join(dest, 'SKILL.md'), 'utf8')).toContain('Team version.');
  });
});

describe('the rules sweep in a directory the member shares with teamai', () => {
  it('keeps a rule file teamai has no record of writing, and still removes a stale one it delivered', async () => {
    await fse.outputFile(path.join(repo, 'rules', 'team-rule.md'), '# Team rule\n');
    const rules = path.join(home, '.claude', 'rules');
    const mine = path.join(rules, 'rule-8-match-codebase-conventions.md');
    const stale = path.join(rules, 'retired-team-rule.md');
    await fse.writeFile(mine, '# Project rule committed by the member\n');
    await fse.writeFile(stale, '# A rule teamai delivered earlier\n');
    const previous: DeliveredHashes = {};
    await recordDelivered(previous, stale);

    await new RulesHandler().pullAllRules(teamConfig, localConfig(), undefined, [], openLedger(previous));

    expect(await fse.readFile(mine, 'utf8')).toBe('# Project rule committed by the member\n');
    expect(await fse.pathExists(stale)).toBe(false);
    expect(await fse.readFile(path.join(rules, 'team-rule.md'), 'utf8')).toBe('# Team rule\n');
  });
});

describe('an unrecorded copy holding bytes the team repo once had', () => {
  it('is the team\'s (an older pull or the member\'s push wrote it), so pull updates it', async () => {
    const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' });
    await fse.outputFile(path.join(repo, 'rules', 'team-rule.md'), '# Team rule v1\n');
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'v1');
    await fse.outputFile(path.join(repo, 'rules', 'team-rule.md'), '# Team rule v2\n');
    git('commit', '-q', '-am', 'v2');
    const copy = path.join(home, '.claude', 'rules', 'team-rule.md');
    await fse.writeFile(copy, '# Team rule v1\n');

    await new RulesHandler().pullAllRules(teamConfig, localConfig(), undefined, [], openLedger(undefined));

    expect(await fse.readFile(copy, 'utf8')).toBe('# Team rule v2\n');
  });
});
