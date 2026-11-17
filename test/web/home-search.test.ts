import { describe, expect, it } from 'vitest';
import type { PrCard } from '../../src/shared/api.ts';
import { matchesPrQuery } from '../../src/web/lib/home-search.ts';

function card(over: Partial<PrCard> = {}): PrCard {
    return {
        workspace: 'acme', repo: 'records-api', id: 46, title: 'DEMO-46 - feat(never): Éviter les doublons', author: { uuid: '{cam}', displayName: 'Camille Durand' },
        url: 'https://bitbucket.org/acme/records-api/pull-requests/46', createdOn: '2026-10-01T09:00:00Z', updatedOn: '2026-10-01T09:00:00Z',
        versionsCount: null, lastPushAt: '2026-10-01T09:00:00Z', lastReviewed: null, newVersions: 0, newCodeVersions: null,
        approvals: 0, requiredApprovals: 2, myApproval: false, newComments: 0, needsReview: true, designatedReviewer: false,
        followed: false, approvalHolds: false, build: null, needsRebase: null, head: '', draft: false,
        ...over,
    };
}

describe('matchesPrQuery', () => {
    it('matches everything on an empty or blank query', () => {
        expect(matchesPrQuery(card(), '')).toBe(true);
        expect(matchesPrQuery(card(), '   ')).toBe(true);
    });

    it('matches a substring of the title, ignoring case', () => {
        expect(matchesPrQuery(card(), 'FEAT(never)')).toBe(true);
        expect(matchesPrQuery(card(), 'zzz')).toBe(false);
    });

    it('ignores accents on both sides', () => {
        expect(matchesPrQuery(card(), 'eviter')).toBe(true);
        expect(matchesPrQuery(card({ title: 'Evaluer' }), 'évaluer')).toBe(true);
    });

    it('matches the number with or without #', () => {
        expect(matchesPrQuery(card(), '#46')).toBe(true);
        expect(matchesPrQuery(card({ title: 'x' }), '46')).toBe(true);
        expect(matchesPrQuery(card({ title: 'x' }), '#45')).toBe(false);
    });

    it('matches the repository and the author name', () => {
        expect(matchesPrQuery(card({ title: 'x' }), 'records')).toBe(true);
        expect(matchesPrQuery(card({ title: 'x' }), 'camille')).toBe(true);
        expect(matchesPrQuery(card({ title: 'x', author: null }), 'camille')).toBe(false);
    });

    it('trims the query and treats it as text, not as a pattern', () => {
        expect(matchesPrQuery(card(), '  doublons ')).toBe(true);
        expect(matchesPrQuery(card({ title: 'a.b' }), 'a.b')).toBe(true);
        expect(matchesPrQuery(card({ title: 'axb' }), 'a.b')).toBe(false);
        expect(matchesPrQuery(card({ title: 'x' }), '(')).toBe(false);
    });
});
