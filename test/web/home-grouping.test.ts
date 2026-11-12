import { describe, expect, it } from 'vitest';
import type { PrCard, User } from '../../src/shared/api.ts';
import { groupCards, groupingFor, isGrouping, isOwnGroup } from '../../src/shared/home-grouping.ts';

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
        head: '',
        draft: false,
        ...over,
    };
}

const ids = (cards: PrCard[]): number[] => cards.map((c) => c.id);

describe('groupCards', () => {
    it('by contributor: subgroups ordered by their most recent PR, PRs newest first inside each', () => {
        const cam1 = card({ author: CAM, lastPushAt: '2026-10-05T09:00:00Z' });
        const yan1 = card({ author: YAN, followed: true, lastPushAt: '2026-10-01T09:00:00Z' });
        const jul1 = card({ author: JUL, lastPushAt: '2026-10-09T09:00:00Z' });
        const cam2 = card({ author: CAM, lastPushAt: '2026-10-08T09:00:00Z' });
        const yan2 = card({ author: YAN, followed: true, lastPushAt: '2026-10-03T09:00:00Z' });

        const groups = groupCards([cam1, yan1, jul1, cam2, yan2], 'contributor');

        // Jules (10-09) before Camille (10-08) before Yann (10-03): following someone does not change the order.
        expect(groups.map((g) => g.label)).toEqual(['Jules Mercier', 'Camille Durand', 'Yann Bernard']);
        expect(groups.map((g) => g.key)).toEqual(['{jul}', '{cam}', '{yan}']);
        expect(groups.map((g) => ids(g.cards))).toEqual([[jul1.id], [cam2.id, cam1.id], [yan2.id, yan1.id]]);
    });

    it('by contributor: a card without author has its own group with an empty label, ordered by date too', () => {
        const anonymous = card({ author: null, lastPushAt: '2026-10-09T09:00:00Z' });
        const cam1 = card({ author: CAM, lastPushAt: '2026-10-01T09:00:00Z' });
        const groups = groupCards([cam1, anonymous], 'contributor');
        expect(groups.map((g) => g.label)).toEqual(['', 'Camille Durand']);
        expect(groups[0]?.cards).toEqual([anonymous]);
    });

    it('by repository: subgroups ordered by their most recent PR, PRs newest first inside each', () => {
        const api1 = card({ repo: 'records-api', lastPushAt: '2026-10-09T09:00:00Z' });
        const export1 = card({ repo: 'records-export', lastPushAt: '2026-10-05T09:00:00Z' });
        const api2 = card({ repo: 'records-api', author: YAN, followed: true, lastPushAt: '2026-10-01T09:00:00Z' });
        const billing = card({ repo: 'billing-ui', lastPushAt: '2026-10-07T09:00:00Z' });

        const groups = groupCards([api1, export1, api2, billing], 'repository');

        expect(groups.map((g) => g.label)).toEqual(['acme/records-api', 'acme/billing-ui', 'acme/records-export']);
        expect(groups.map((g) => g.key)).toEqual(['acme/records-api', 'acme/billing-ui', 'acme/records-export']);
        expect(ids(groups[0]?.cards ?? [])).toEqual([api1.id, api2.id]);
    });

    it('subgroups whose most recent PRs have the same date: by name', () => {
        const export1 = card({ repo: 'records-export', lastPushAt: '2026-10-05T09:00:00Z' });
        const billing = card({ repo: 'billing-ui', lastPushAt: '2026-10-05T09:00:00Z' });
        expect(groupCards([export1, billing], 'repository').map((g) => g.label)).toEqual(['acme/billing-ui', 'acme/records-export']);
    });

    it('with none: a single group, newest push first (following someone does not change the order)', () => {
        const old = card({ lastPushAt: '2026-09-01T09:00:00Z' });
        const recent = card({ repo: 'billing-ui', lastPushAt: '2026-10-09T09:00:00Z' });
        const followed = card({ author: YAN, followed: true, lastPushAt: '2026-08-01T09:00:00Z' });

        const groups = groupCards([old, recent, followed], 'none');

        expect(groups).toHaveLength(1);
        expect(groups[0]?.label).toBe('');
        expect(ids(groups[0]?.cards ?? [])).toEqual([recent.id, old.id, followed.id]);
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
        expect(groupingFor('to-rebase', 'none')).toBe('repository');
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

describe('isOwnGroup', () => {
    it('"to-rebase" and "mine" hold my own PRs, the other groups never do', () => {
        expect(isOwnGroup('to-rebase')).toBe(true);
        expect(isOwnGroup('mine')).toBe(true);
        expect(['to-do', 'waiting', 'others'].map((key) => isOwnGroup(key as 'to-do'))).toEqual([false, false, false]);
    });
});
