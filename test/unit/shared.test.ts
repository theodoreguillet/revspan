import { describe, expect, it } from 'vitest';
import { parsePrUrl } from '../../src/shared/pr-url.ts';
import { normalizeRepo, parseRepoList } from '../../src/shared/repos.ts';

describe('parsePrUrl', () => {
    it('reconnaît les URL de PR Bitbucket, avec ou sans protocole ni suffixe', () => {
        expect(parsePrUrl('https://bitbucket.org/acme/records-api/pull-requests/212/overview')).toEqual({ workspace: 'acme', repo: 'records-api', id: 212 });
        expect(parsePrUrl(' bitbucket.org/ws/r/pull-requests/1 ')).toEqual({ workspace: 'ws', repo: 'r', id: 1 });
    });

    it('refuse le reste', () => {
        expect(parsePrUrl('https://github.com/a/b/pull/1')).toBeNull();
        expect(parsePrUrl('https://bitbucket.org/ws/r/pull-requests/abc')).toBeNull();
        expect(parsePrUrl('https://bitbucket.org/%E0%A4%A/r/pull-requests/1')).toBeNull();
        expect(parsePrUrl(null)).toBeNull();
    });
});

describe('dépôts', () => {
    it('normalizeRepo : « workspace/dépôt », URL acceptée, segments « . » et « .. » refusés', () => {
        expect(normalizeRepo('acme/records-api')).toBe('acme/records-api');
        expect(normalizeRepo('https://bitbucket.org/acme/records-api/src/master/')).toBe('acme/records-api');
        expect(normalizeRepo('../..')).toBeNull();
        expect(normalizeRepo('pas un repo')).toBeNull();
        expect(normalizeRepo('seul')).toBeNull();
    });

    it('parseRepoList : valides sans doublon, invalides à part, lignes vides ignorées', () => {
        expect(parseRepoList(['acme/records-api', '', 'pas un repo', 'https://bitbucket.org/acme/records-api/', 'ws/r']))
            .toEqual({ repos: ['acme/records-api', 'ws/r'], bad: ['pas un repo'] });
    });
});
