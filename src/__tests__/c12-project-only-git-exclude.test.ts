/**
 * C12 fork: project-only mode promises that everything teamai delivers into
 * the project stays untracked, so its `delivered` exclude block is on unless
 * the team or the member turns it off. Upstream's default is off (#915).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isGitExcludeEnabled } from '../types.js';

const project = { scope: 'project', projectRoot: '/work/app', dataHome: '/home/m/.teamai/projects/app' };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isGitExcludeEnabled in project-only mode (C12 fork)', () => {
  it('is on by default in project-only mode', () => {
    vi.stubEnv('TEAMAI_PROJECT_ONLY', '1');
    expect(isGitExcludeEnabled(project, {})).toBe(true);
  });

  it('stays off by default outside it, and in user scope', () => {
    expect(isGitExcludeEnabled(project, {})).toBe(false);
    vi.stubEnv('TEAMAI_PROJECT_ONLY', '1');
    expect(isGitExcludeEnabled({ scope: 'user' }, {})).toBe(false);
  });

  it('lets the team, then the member, turn it off', () => {
    vi.stubEnv('TEAMAI_PROJECT_ONLY', '1');
    expect(isGitExcludeEnabled(project, { sharing: { gitExclude: { enabled: false } } })).toBe(false);
    expect(isGitExcludeEnabled({ ...project, gitExcludeEnabled: false }, { sharing: { gitExclude: { enabled: true } } })).toBe(false);
  });
});
