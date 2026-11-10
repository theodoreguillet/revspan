import { describe, expect, it } from 'vitest';
import type { PrCard, User } from '../../src/shared/api.ts';
import { groupCards, groupingFor, isGrouping } from '../../src/shared/home-grouping.ts';

const CAM: User = { uuid: '{cam}', displayName: 'Camille Durand' };
const YAN: User = { uuid: '{yan}', displayName: 'Yann Bernard' };
const JUL: User = { uuid: '{jul}', displayName: 'Jules Mercier' };

let nextId = 1;

function card(over: Partial<PrCard> = {}): PrCard {
    return {
        workspace: 'acme',
        repo: 'records-api',
        id: nextId++,
        title: 'feat: something',
        author: CAM,
        url: 'https://bitbucket.org/acme/records-api/pull-requests/1',
        createdOn: '2026-10-01T09:00:00Z',
        updatedOn: '2026-10-01T09:00:00Z',
        versionsCount: null,
        lastPushAt: '2026-10-01T09:00:00Z',
        lastReviewed: null,
        newVersions: 0,
        newCodeVersions: null,
        approvals: 0,
        requiredApprovals: 2,
        myApproval: false,
        newComments: 0,
        needsReview: true,
        designatedReviewer: false,
        followed: false,
        approvalHolds: false,
        build: null,
        needsRebase: null,
        ...over,
    };
}

const ids = (cards: PrCard[]): number[] => cards.map((c) => c.id);

describe('groupCards', () => {
    it('by contributor: cards of the same author are together, followed authors first', () => {
        const cam1 = card({ author: CAM, lastPushAt: '2026-10-05T09:00:00Z' });
        const yan1 = card({ author: YAN, followed: true, lastPushAt: '2026-10-01T09:00:00Z' });
        const jul1 = card({ author: JUL, lastPushAt: '2026-10-09T09:00:00Z' });
        const cam2 = card({ author: CAM, lastPushAt: '2026-10-08T09:00:00Z' });
        const yan2 = card({ author: YAN, followed: true, lastPushAt: '2026-10-03T09:00:00Z' });

        const groups = groupCards([cam1, yan1, jul1, cam2, yan2], 'contributor');

        expect(groups.map((g) => g.label)).toEqual(['Yann Bernard', 'Camille Durand', 'Jules Mercier']);
        expect(groups.map((g) => g.key)).toEqual(['{yan}', '{cam}', '{jul}']);
        // Inside a subgroup: last push first.
        expect(groups.map((g) => ids(g.cards))).toEqual([[yan2.id, yan1.id], [cam2.id, cam1.id], [jul1.id]]);
    });

    it('by contributor: a card without author goes to a last group with an empty label', () => {
        const anonymous = card({ author: null });
        const cam1 = card({ author: CAM });
        const groups = groupCards([anonymous, cam1], 'contributor');
        expect(groups.map((g) => g.label)).toEqual(['Camille Durand', '']);
        expect(groups[1]?.cards).toEqual([anonymous]);
    });

    it('by repository: groups sorted by repository name, followed authors first inside each', () => {
        const api1 = card({ repo: 'records-api', lastPushAt: '2026-10-09T09:00:00Z' });
        const export1 = card({ repo: 'records-export' });
        const api2 = card({ repo: 'records-api', author: YAN, followed: true, lastPushAt: '2026-10-01T09:00:00Z' });
        const billing = card({ repo: 'billing-ui' });

        const groups = groupCards([api1, export1, api2, billing], 'repository');

        expect(groups.map((g) => g.label)).toEqual(['acme/billing-ui', 'acme/records-api', 'acme/records-export']);
        expect(groups.map((g) => g.key)).toEqual(['acme/billing-ui', 'acme/records-api', 'acme/records-export']);
        expect(ids(groups[1]?.cards ?? [])).toEqual([api2.id, api1.id]);
    });

    it('with none: a single group, followed first then by last push', () => {
        const old = card({ lastPushAt: '2026-09-01T09:00:00Z' });
        const recent = card({ repo: 'billing-ui', lastPushAt: '2026-10-09T09:00:00Z' });
        const followed = card({ author: YAN, followed: true, lastPushAt: '2026-08-01T09:00:00Z' });

        const groups = groupCards([old, recent, followed], 'none');

        expect(groups).toHaveLength(1);
        expect(groups[0]?.label).toBe('');
        expect(ids(groups[0]?.cards ?? [])).toEqual([followed.id, recent.id, old.id]);
    });

    it('no card: no group, whatever the grouping', () => {
        expect(groupCards([], 'none')).toEqual([]);
        expect(groupCards([], 'repository')).toEqual([]);
        expect(groupCards([], 'contributor')).toEqual([]);
    });

    it('does not reorder the input array', () => {
        const a = card({ lastPushAt: '2026-09-01T09:00:00Z' });
        const b = card({ lastPushAt: '2026-10-01T09:00:00Z' });
        const input = [a, b];
        groupCards(input, 'none');
        expect(input).toEqual([a, b]);
    });
});

describe('groupingFor', () => {
    it('the choice applies to "to-do" and "others", "mine" is by repository, "waiting" is not grouped', () => {
        expect(groupingFor('to-do', 'contributor')).toBe('contributor');
        expect(groupingFor('others', 'none')).toBe('none');
        expect(groupingFor('mine', 'contributor')).toBe('repository');
        expect(groupingFor('waiting', 'repository')).toBe('none');
    });
});

describe('isGrouping', () => {
    it('accepts the three groupings only', () => {
        expect(['repository', 'contributor', 'none'].every(isGrouping)).toBe(true);
        expect(isGrouping('author')).toBe(false);
        expect(isGrouping(null)).toBe(false);
    });
});
