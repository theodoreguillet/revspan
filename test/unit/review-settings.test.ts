import { describe, expect, it } from 'vitest';
import { DEFAULT_REVIEW_SETTINGS, normalizeReviewSettings, requiredApprovalsFor } from '../../src/shared/review-settings.ts';

describe('normalizeReviewSettings', () => {
    it('anything unusable gives the defaults', () => {
        for (const raw of [undefined, null, 'x', 3, [], {}]) {
            expect(normalizeReviewSettings(raw)).toEqual(DEFAULT_REVIEW_SETTINGS);
        }
    });

    it('invalid required approvals fall back to 2', () => {
        for (const bad of [0, -1, 2.5, '3', 21, NaN, null]) {
            expect(normalizeReviewSettings({ requiredApprovals: bad }).requiredApprovals).toBe(2);
        }
        expect(normalizeReviewSettings({ requiredApprovals: 3 }).requiredApprovals).toBe(3);
        expect(normalizeReviewSettings({ requiredApprovals: 20 }).requiredApprovals).toBe(20);
    });

    it('invalid refresh interval falls back to 5', () => {
        for (const bad of [0, -5, 1.5, '10', 121]) {
            expect(normalizeReviewSettings({ refreshMinutes: bad }).refreshMinutes).toBe(5);
        }
        expect(normalizeReviewSettings({ refreshMinutes: 120 }).refreshMinutes).toBe(120);
    });

    it('per-repository overrides keep only valid entries', () => {
        const result = normalizeReviewSettings({ requiredApprovalsByRepo: { 'acme/records-api': 3, 'acme/bad': 0, 'acme/frac': 1.5, 'not a repo': 2, 'acme/x/y': 2 } });
        expect(result.requiredApprovalsByRepo).toEqual({ 'acme/records-api': 3 });
        expect(normalizeReviewSettings({ requiredApprovalsByRepo: ['acme/records-api'] }).requiredApprovalsByRepo).toEqual({});
    });

    it('followed users: invalid entries dropped, duplicate uuids removed', () => {
        const result = normalizeReviewSettings({
            followed: [
                { uuid: '{a}', displayName: 'Alice Martin' },
                { uuid: '{a}', displayName: 'Alice again' },
                { uuid: '', displayName: 'Nobody' },
                { displayName: 'No uuid' },
                'text',
                { uuid: '{b}' },
            ],
        });
        expect(result.followed).toEqual([{ uuid: '{a}', displayName: 'Alice Martin' }, { uuid: '{b}', displayName: '{b}' }]);
    });

    it('notifications: booleans kept, anything else gives the default of that key', () => {
        expect(normalizeReviewSettings({ notifications: { newPullRequest: false, buildFailed: true, newVersion: 'yes' } }).notifications)
            .toEqual({ newPullRequest: false, newVersion: true, buildFailed: true });
    });
});

describe('requiredApprovalsFor', () => {
    const settings = normalizeReviewSettings({ requiredApprovals: 2, requiredApprovalsByRepo: { 'acme/records-api': 3 } });

    it('the override wins, otherwise the global value applies', () => {
        expect(requiredApprovalsFor(settings, 'acme/records-api')).toBe(3);
        expect(requiredApprovalsFor(settings, 'acme/records-web')).toBe(2);
    });

    it('invalid values never change the global minimum', () => {
        const bad = normalizeReviewSettings({ requiredApprovals: 0, requiredApprovalsByRepo: { 'acme/records-api': -1, 'acme/untracked': 0 } });
        expect(requiredApprovalsFor(bad, 'acme/records-api')).toBe(2);
        expect(requiredApprovalsFor(bad, 'acme/records-web')).toBe(2);
    });
});
