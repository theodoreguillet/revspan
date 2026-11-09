import { describe, expect, it } from 'vitest';
import { approvalHoldsSince } from '../../src/shared/approval.ts';
import { parsePrUrl } from '../../src/shared/pr-url.ts';
import { normalizeRepo, parseRepoList } from '../../src/shared/repos.ts';

describe('parsePrUrl', () => {
    it('recognizes Bitbucket PR URLs, with or without protocol or suffix', () => {
        expect(parsePrUrl('https://bitbucket.org/acme/records-api/pull-requests/212/overview')).toEqual({ workspace: 'acme', repo: 'records-api', id: 212 });
        expect(parsePrUrl(' bitbucket.org/ws/r/pull-requests/1 ')).toEqual({ workspace: 'ws', repo: 'r', id: 1 });
    });

    it('rejects the rest', () => {
        expect(parsePrUrl('https://github.com/a/b/pull/1')).toBeNull();
        expect(parsePrUrl('https://bitbucket.org/ws/r/pull-requests/abc')).toBeNull();
        expect(parsePrUrl('https://bitbucket.org/%E0%A4%A/r/pull-requests/1')).toBeNull();
        expect(parsePrUrl(null)).toBeNull();
    });
});

describe('repositories', () => {
    it('normalizeRepo: "workspace/repo", URL accepted, "." and ".." segments rejected', () => {
        expect(normalizeRepo('acme/records-api')).toBe('acme/records-api');
        expect(normalizeRepo('https://bitbucket.org/acme/records-api/src/master/')).toBe('acme/records-api');
        expect(normalizeRepo('../..')).toBeNull();
        expect(normalizeRepo('not a repo')).toBeNull();
        expect(normalizeRepo('seul')).toBeNull();
    });

    it('parseRepoList: valid without duplicates, invalid apart, empty lines ignored', () => {
        expect(parseRepoList(['acme/records-api', '', 'not a repo', 'https://bitbucket.org/acme/records-api/', 'ws/r']))
            .toEqual({ repos: ['acme/records-api', 'ws/r'], bad: ['not a repo'] });
    });
});

describe('approvalHoldsSince: the approval rule shared by the server (home) and the page', () => {
    it('holds for the latest version if everything after the approved version is known and neutral', () => {
        expect(approvalHoldsSince(3, ['creation', 'deps', 'deps', 'rebase-only', 'message-only', 'none'])).toBe(true);
        expect(approvalHoldsSince(5, ['creation', 'code', 'code', 'code', 'code'])).toBe(true);
        expect(approvalHoldsSince(3, ['creation', 'deps', 'deps', 'rebase-only', 'code'])).toBe(false);
        expect(approvalHoldsSince(3, ['creation', 'deps', 'deps', 'deps'])).toBe(false);
    });

    it('a version unknown since the approval (summary not computed yet): does not hold', () => {
        expect(approvalHoldsSince(3, ['creation', 'deps', 'deps', undefined])).toBe(false);
    });

    it('a version Bitbucket erased since the approval (unavailable) is neutral', () => {
        expect(approvalHoldsSince(2, ['creation', 'code', 'unavailable', 'rebase-only'])).toBe(true);
        expect(approvalHoldsSince(2, ['creation', 'code', 'unavailable', 'code'])).toBe(false);
    });

    it('approved version unknown: Bitbucket\'s state is authoritative, the approval holds', () => {
        expect(approvalHoldsSince(null, ['creation'])).toBe(true);
        expect(approvalHoldsSince(null, ['creation', 'code', undefined])).toBe(true);
    });
});
