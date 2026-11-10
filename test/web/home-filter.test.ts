import { describe, expect, it } from 'vitest';
import type { Home, HomeGroupKey, PrCard, User } from '../../src/shared/api.ts';
import { alwaysShown, visibleGroups } from '../../src/shared/home-filter.ts';

const ME: User = { uuid: '{me}', displayName: 'Thomas Girard' };
const CAM: User = { uuid: '{cam}', displayName: 'Camille Durand' };
const YAN: User = { uuid: '{yan}', displayName: 'Yann Bernard' };

let nextId = 1;

/** A PR of an unfollowed author that does not concern me. */
function card(over: Partial<PrCard> = {}): PrCard {
    return {
        workspace: 'acme', repo: 'records-api', id: nextId++, title: 'feat: something', author: CAM,
        url: 'https://bitbucket.org/acme/records-api/pull-requests/1', createdOn: '2026-10-01T09:00:00Z', updatedOn: '2026-10-01T09:00:00Z',
        versionsCount: null, lastPushAt: '2026-10-01T09:00:00Z', lastReviewed: null, newVersions: 0, newCodeVersions: null,
        approvals: 2, requiredApprovals: 2, myApproval: false, newComments: 0, needsReview: false, designatedReviewer: false,
        followed: false, approvalHolds: false, build: null, needsRebase: null, head: '', draft: false,
        ...over,
    };
}

const homeOf = (groups: Partial<Record<HomeGroupKey, PrCard[]>>, hideUnfollowed: boolean): Pick<Home, 'groups' | 'hideUnfollowed'> => ({
    hideUnfollowed,
    groups: (['to-do', 'to-rebase', 'mine', 'waiting', 'others'] as const).map((key) => ({ key, prs: groups[key] ?? [] })),
});

const ids = (home: ReturnType<typeof visibleGroups>): Record<string, number[]> =>
    Object.fromEntries(home.groups.map((g) => [g.key, g.prs.map((p) => p.id)]));

describe('alwaysShown', () => {
    it('my PRs, followed authors, designated reviews and PRs I reviewed or approved are never hidden', () => {
        expect(alwaysShown('mine', card({ author: ME }))).toBe(true);
        expect(alwaysShown('to-rebase', card({ author: ME, needsRebase: true }))).toBe(true);
        expect(alwaysShown('others', card({ author: YAN, followed: true }))).toBe(true);
        expect(alwaysShown('others', card({ designatedReviewer: true }))).toBe(true);
        expect(alwaysShown('waiting', card({ lastReviewed: 1 }))).toBe(true);
        expect(alwaysShown('to-do', card({ myApproval: true, newCodeVersions: 1 }))).toBe(true);
    });

    it('an unfollowed author\'s PR that does not concern me can be hidden', () => {
        expect(alwaysShown('others', card())).toBe(false);
        expect(alwaysShown('to-do', card({ needsReview: true }))).toBe(false);
    });
});

describe('visibleGroups', () => {
    const groups = (): Partial<Record<HomeGroupKey, PrCard[]>> => ({
        'to-do': [card({ id: 1, author: YAN, followed: true, needsReview: true }), card({ id: 2, designatedReviewer: true })],
        'to-rebase': [card({ id: 3, author: ME, needsRebase: true })],
        mine: [card({ id: 4, author: ME })],
        waiting: [card({ id: 5, myApproval: true })],
        others: [card({ id: 6 }), card({ id: 7, needsReview: true }), card({ id: 8, author: YAN, followed: true })],
    });

    it('on: hides the unfollowed authors\' PRs that do not concern me, and counts them', () => {
        const visible = visibleGroups(homeOf(groups(), true));
        expect(ids(visible)).toEqual({ 'to-do': [1, 2], 'to-rebase': [3], mine: [4], waiting: [5], others: [8] });
        expect(visible.hidden).toBe(2);
    });

    it('off (or nobody followed, which the server sends as off): every PR is listed, nothing counted', () => {
        const visible = visibleGroups(homeOf(groups(), false));
        expect(ids(visible).others).toEqual([6, 7, 8]);
        expect(visible.hidden).toBe(0);
    });

    it('a PR with an unknown author is hidden like any unfollowed one', () => {
        expect(visibleGroups(homeOf({ others: [card({ id: 9, author: null })] }, true))).toMatchObject({ hidden: 1 });
    });
});
