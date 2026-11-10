import { describe, expect, it } from 'vitest';
import { byRepoRows, reviewFromForm, type ReviewForm } from '../../src/web/lib/review-form.ts';

const form = (over: Partial<ReviewForm> = {}): ReviewForm => ({
    requiredApprovals: 2,
    byRepo: [],
    refreshMinutes: 5,
    followed: [],
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

describe('byRepoRows', () => {
    it('one row per override, sorted', () => {
        expect(byRepoRows({ 'acme/records-web': 1, 'acme/records-api': 3 })).toEqual([{ repo: 'acme/records-api', approvals: 3 }, { repo: 'acme/records-web', approvals: 1 }]);
    });
});
