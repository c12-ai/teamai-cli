import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import type { LocalConfig } from '../types.js';
import { getVotesDir } from '../types.js';
import { appendRecallLines } from '../recall-log.js';
import { pendingAdoptedSummary } from '../recall-adoption.js';
import {
  acknowledgeSummary, confirmVotesSynced, incrementUpvoted, pendingSummaryForSession,
  readUserVotes, stageVotesMerge, syncVotesToTeam,
} from '../votes.js';

let root: string;
let file: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-pending-summary-'));
  file = path.join(root, 'local', 'member.yaml');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('local pending summary ledger', () => {
  it('queues concurrent newly credited documents exactly once with their counters', async () => {
    await Promise.all([
      incrementUpvoted(file, ['a', 'b'], 'session'),
      incrementUpvoted(file, ['a'], 'session'),
      incrementUpvoted(file, ['b'], 'session'),
    ]);
    expect((await pendingSummaryForSession(file, 'session'))?.docIds.sort()).toEqual(['a', 'b']);
    const votes = await readUserVotes(file);
    expect(votes.votes.a.upvoted_count).toBe(1);
    expect(votes.votes.b.upvoted_count).toBe(1);
  });

  it('acknowledges only the emitted snapshot, retaining later credits and other sessions', async () => {
    await incrementUpvoted(file, ['a'], 'session');
    const snapshot = (await pendingSummaryForSession(file, 'session'))!;
    await incrementUpvoted(file, ['b'], 'session');
    await incrementUpvoted(file, ['a'], 'other');
    await acknowledgeSummary(file, 'session', snapshot);
    await acknowledgeSummary(file, 'session', snapshot);
    expect((await pendingSummaryForSession(file, 'session'))?.docIds).toEqual(['b']);
    expect((await pendingSummaryForSession(file, 'other'))?.docIds).toEqual(['a']);
    await incrementUpvoted(file, ['a'], 'session');
    expect((await pendingSummaryForSession(file, 'session'))?.docIds).toEqual(['b']);
  });

  it('reads and acknowledges a linked child through the original root-session owner', async () => {
    const config: LocalConfig = { repo: { localPath: root, remote: '' }, username: 'member', scope: 'project', projectRoot: root, dataHome: path.join(root, 'data'), additionalRoles: [] };
    const votes = path.join(getVotesDir(config), 'member.yaml');
    await incrementUpvoted(votes, ['a'], 'parent');
    await appendRecallLines(config, [{ kind: 'link', ts: new Date().toISOString(), child: 'child', parent: 'parent' }]);
    const pending = await pendingAdoptedSummary(config, 'child');
    expect(pending?.docIds).toEqual(['a']);
    expect(await pendingSummaryForSession(votes, 'child')).toBeNull();
    await pending!.acknowledge();
    expect(await pendingSummaryForSession(votes, 'parent')).toBeNull();
  });

  it('does not backfill legacy credits and preserves new pending IDs on later credit', async () => {
    fs.mkdirSync(path.dirname(file));
    const ts = new Date().toISOString();
    fs.writeFileSync(file, YAML.stringify({ version: 2, votes: {}, deltas: {}, upvotedSessions: { session: { docIds: ['old'], ts } } }));
    expect(await pendingSummaryForSession(file, 'session')).toBeNull();
    await incrementUpvoted(file, ['old', 'new'], 'session');
    expect((await pendingSummaryForSession(file, 'session'))?.docIds).toEqual(['new']);
  });

  it('ignores invalid pending values and expired sessions', async () => {
    fs.mkdirSync(path.dirname(file));
    const ts = new Date().toISOString();
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(file, YAML.stringify({ version: 2, votes: {}, deltas: {}, upvotedSessions: {
      invalid: { docIds: ['a'], pendingSummaryDocIds: 'a', ts },
      expired: { docIds: ['a'], pendingSummaryDocIds: ['a'], ts: old },
    } }));
    expect(await pendingSummaryForSession(file, 'invalid')).toBeNull();
    expect(await pendingSummaryForSession(file, 'expired')).toBeNull();
  });

  it('does not acknowledge a replacement ledger entry', async () => {
    await incrementUpvoted(file, ['a'], 'session');
    const snapshot = (await pendingSummaryForSession(file, 'session'))!;
    await acknowledgeSummary(file, 'session', { ...snapshot, firstTs: 'different' });
    expect((await pendingSummaryForSession(file, 'session'))?.docIds).toEqual(['a']);
  });

  it.each(['legacy', 'reports'])('keeps pending state local during %s vote sync', async (mode) => {
    await incrementUpvoted(file, ['a'], 'session');
    const repo = path.join(root, 'remote');
    fs.mkdirSync(repo);
    if (mode === 'legacy') await syncVotesToTeam(repo, 'member', path.dirname(file));
    else {
      const stage = await stageVotesMerge(repo, 'member', path.dirname(file), null);
      expect(stage).not.toBeNull();
      await confirmVotesSynced(file, stage!.syncedDeltas);
    }
    const uploaded = fs.readFileSync(path.join(repo, 'votes', 'member.yaml'), 'utf8');
    expect(uploaded).not.toContain('pendingSummaryDocIds');
    expect(uploaded).not.toContain('upvotedSessions');
    expect(YAML.parse(uploaded).votes.a.upvoted_count).toBe(1);
    expect((await pendingSummaryForSession(file, 'session'))?.docIds).toEqual(['a']);
  });
});
