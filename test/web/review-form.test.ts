import { describe, expect, it } from 'vitest';
import { byRepoRows, followCandidates, reviewFromForm, type ReviewForm } from '../../src/web/lib/review-form.ts';

const form = (over: Partial<ReviewForm> = {}): ReviewForm => ({
    requiredApprovals: 2,
    byRepo: [],
    refreshMinutes: 5,
    followed: [],
    hideUnfollowed: true,
    notifications: { newPullRequest: true, newVersion: true, buildFailed: false },
    ...over,
});

describe('reviewFromForm', () => {
    it('valid rows become the settings, repository URLs normalized, blank rows ignored', () => {
        const result = reviewFromForm(form({
            requiredApprovals: '3',
            byRepo: [{ repo: 'https://bitbucket.org/acme/records-api/src/main/', approvals: 1 }, { repo: '  ', approvals: null }, { repo: '', approvals: '' }],
        }));
        expect(result).toEqual({ ok: true, review: expect.objectContaining({ requiredApprovals: 3, requiredApprovalsByRepo: { 'acme/records-api': 1 } }) });
    });

    it('invalid approvals, override rows or refresh interval are reported, never silently replaced', () => {
        for (const bad of [0, -1, 2.5, 21, '', 'abc', null]) {
            expect(reviewFromForm(form({ requiredApprovals: bad }))).toEqual({ ok: false, error: 'settings.invalidApprovals' });
        }
        expect(reviewFromForm(form({ refreshMinutes: 0 }))).toEqual({ ok: false, error: 'settings.invalidRefresh' });
        for (const row of [{ repo: 'not a repo', approvals: 2 }, { repo: 'acme/records-api', approvals: 0 }, { repo: 'acme/records-api', approvals: null }, { repo: '', approvals: 2 }]) {
            expect(reviewFromForm(form({ byRepo: [row] }))).toEqual({ ok: false, error: 'settings.invalidByRepo' });
        }
        expect(reviewFromForm(form({ byRepo: [{ repo: 'acme/records-api', approvals: 1 }, { repo: 'acme/records-api', approvals: 2 }] }))).toEqual({ ok: false, error: 'settings.invalidByRepo' });
    });
});

describe('hideUnfollowed and the contributors to follow', () => {
    it('the checkbox value is saved as is', () => {
        expect(reviewFromForm(form({ hideUnfollowed: false }))).toEqual({ ok: true, review: expect.objectContaining({ hideUnfollowed: false }) });
        expect(reviewFromForm(form({ hideUnfollowed: true }))).toEqual({ ok: true, review: expect.objectContaining({ hideUnfollowed: true }) });
    });

    it('candidates: the contributors not followed yet, sorted by name', () => {
        const contributors = [
            { uuid: '{yan}', displayName: 'Yann Bernard' },
            { uuid: '{cam}', displayName: 'Camille Durand' },
            { uuid: '{jul}', displayName: 'Jules Mercier' },
        ];
        expect(followCandidates(contributors, [{ uuid: '{jul}', displayName: 'Jules Mercier' }])).toEqual([
            { uuid: '{cam}', displayName: 'Camille Durand' },
            { uuid: '{yan}', displayName: 'Yann Bernard' },
        ]);
        expect(followCandidates([], [])).toEqual([]);
    });

    it('candidates never include me (the server cannot exclude me when it does not know who I am)', () => {
        const me = { uuid: '{me}', displayName: 'Thomas Girard' };
        const contributors = [me, { uuid: '{yan}', displayName: 'Yann Bernard' }];
        expect(followCandidates(contributors, [], me)).toEqual([{ uuid: '{yan}', displayName: 'Yann Bernard' }]);
        expect(followCandidates(contributors, [], null)).toEqual(contributors);
    });
});

describe('byRepoRows', () => {
    it('one row per override, sorted', () => {
        expect(byRepoRows({ 'acme/records-web': 1, 'acme/records-api': 3 })).toEqual([{ repo: 'acme/records-api', approvals: 3 }, { repo: 'acme/records-web', approvals: 1 }]);
    });
});
