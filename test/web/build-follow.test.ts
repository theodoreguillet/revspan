import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildCheck, BuildSummary, Home, PrCard } from '../../src/shared/api.ts';
import { createTranslator } from '../../src/web/i18n/translator.ts';
import { buildCheckText, buildHeaderText, buildRowText, safeBuildUrl } from '../../src/web/lib/build.ts';
import { withFollowed, withFollowedCards } from '../../src/shared/follow.ts';

const fr = createTranslator('fr');
const en = createTranslator('en');

const summary = (over: Partial<BuildSummary>): BuildSummary => ({ state: 'none', failed: 0, running: 0, total: 0, ...over });

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T14:00:00Z'));
});

afterEach(() => {
    vi.useRealTimers();
});

describe('build texts', () => {
    it('row pill: short state', () => {
        expect(buildRowText(fr, summary({ state: 'failed', failed: 1, total: 2 }))).toBe('✗ échec');
        expect(buildRowText(fr, summary({ state: 'running', running: 1, total: 2 }))).toBe('en cours');
        expect(buildRowText(fr, summary({ state: 'success', total: 2 }))).toBe('✓ réussi');
        expect(buildRowText(en, summary({ state: 'failed', failed: 1, total: 2 }))).toBe('✗ failed');
        expect(buildRowText(fr, summary({ state: 'none' }))).toBe('');
    });

    it('header badge: number of failures, running or passed', () => {
        expect(buildHeaderText(fr, summary({ state: 'failed', failed: 1, total: 3 }))).toBe('✗ 1 échec');
        expect(buildHeaderText(fr, summary({ state: 'failed', failed: 2, total: 3 }))).toBe('✗ 2 échecs');
        expect(buildHeaderText(en, summary({ state: 'failed', failed: 1, total: 3 }))).toBe('✗ 1 failure');
        expect(buildHeaderText(fr, summary({ state: 'running', running: 1, total: 2 }))).toBe('build en cours');
        expect(buildHeaderText(en, summary({ state: 'running', running: 1, total: 2 }))).toBe('build running');
        expect(buildHeaderText(fr, summary({ state: 'success', total: 2 }))).toBe('✓ builds réussis');
        expect(buildHeaderText(en, summary({ state: 'success', total: 2 }))).toBe('✓ builds passed');
    });

    it('a check: name, state and age', () => {
        const check: BuildCheck = { key: 'p', name: 'Pipeline #12', state: 'stopped', url: null, updatedOn: '2026-11-05T13:48:00Z' };
        expect(buildCheckText(fr, check)).toEqual({ state: 'arrêté', when: 'il y a 12 min' });
        expect(buildCheckText(en, { ...check, state: 'failed', updatedOn: null })).toEqual({ state: 'failed', when: '' });
    });

    it('safe link: absolute http and https only', () => {
        expect(safeBuildUrl('https://ci.example.test/job/1')).toBe('https://ci.example.test/job/1');
        expect(safeBuildUrl('http://ci.example.test/job/1')).toBe('http://ci.example.test/job/1');
        expect(safeBuildUrl('javascript:alert(1)')).toBeNull();
        expect(safeBuildUrl('mailto:ci@example.test')).toBeNull();
        expect(safeBuildUrl('/relative/path')).toBeNull();
        expect(safeBuildUrl(null)).toBeNull();
    });
});

describe('follow', () => {
    const cam = { uuid: '{cam}', displayName: 'Camille Durand' };
    const yan = { uuid: '{yan}', displayName: 'Yann Bernard' };

    it('adds once and removes by uuid', () => {
        expect(withFollowed([cam], yan, true)).toEqual([cam, yan]);
        expect(withFollowed([cam, yan], { ...yan, displayName: 'Other name' }, true)).toEqual([cam, yan]);
        expect(withFollowed([cam, yan], cam, false)).toEqual([yan]);
        expect(withFollowed([], cam, false)).toEqual([]);
    });

    it('marks every card of the followed authors, on a new home object', () => {
        const base = { workspace: 'acme', repo: 'records-api' } as const;
        const cards = [
            { ...base, id: 1, author: cam, followed: false },
            { ...base, id: 2, author: yan, followed: true },
            { ...base, id: 3, author: null, followed: false },
        ] as PrCard[];
        const home: Home = { me: null, repos: [], errors: [], truncated: [], hideUnfollowed: false, contributors: [], groups: [{ key: 'to-do', prs: cards }] };
        const next = withFollowedCards(home, [cam]);
        expect(next).not.toBe(home);
        expect(next.groups[0]?.prs.map((c) => c.followed)).toEqual([true, false, false]);
        expect(cards.map((c) => c.followed)).toEqual([false, true, false]);
    });
});
