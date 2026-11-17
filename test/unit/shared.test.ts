import { describe, expect, it } from 'vitest';
import { approvalHoldsSince } from '../../src/shared/approval.ts';
import { parsePrUrl } from '../../src/shared/pr-url.ts';
import { classifyComments, reactionOf, reactionReplies } from '../../src/shared/reactions.ts';
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

describe('reactions: replies made of a single emoji (the Bitbucket API has no reactions)', () => {
    it('reactionOf: a single emoji or its alias, nothing else', () => {
        expect(reactionOf('👍')).toBe('👍');
        expect(reactionOf(' :+1: ')).toBe('👍');
        expect(reactionOf(':thumbsup:')).toBe('👍');
        expect(reactionOf('+1')).toBe('👍');
        expect(reactionOf('🎉')).toBe('🎉');
        expect(reactionOf('👍 merci')).toBeNull();
        expect(reactionOf('👍👍')).toBeNull();
        expect(reactionOf('')).toBeNull();
        expect(reactionOf(null)).toBeNull();
    });

    it('reactionOf: emoji variation selector and skin tones ignored, shortcodes; ZWJ sequences and flags are text', () => {
        expect(reactionOf('❤')).toBe('❤️');
        expect(reactionOf('❤️')).toBe('❤️');
        expect(reactionOf('👍️')).toBe('👍');
        expect(reactionOf('👍🏽')).toBe('👍');
        expect(reactionOf('👏🏿')).toBe('👏');
        expect([':tada:', ':heart:', ':rocket:', ':eyes:', ':clap:', ':white_check_mark:'].map(reactionOf)).toEqual(['🎉', '❤️', '🚀', '👀', '👏', '✅']);
        // zero-width-joiner sequences (👨‍💻, 👍+ZWJ+🔥) and flags are not single emoji
        expect(reactionOf('\u{1F468}\u200D\u{1F4BB}')).toBeNull();
        expect(reactionOf('👍\u200D🔥')).toBeNull();
        expect(reactionOf('🇫🇷')).toBeNull();
        expect(reactionOf('👍🏽👍')).toBeNull();
    });

    it('reactionReplies: a live reply made of a single emoji, to a listed comment, with nothing shown under it', () => {
        const comments = [
            // a root is never a reaction
            { id: 1, content: { raw: '👍' } },
            { id: 2, parent: { id: 1 }, content: { raw: 'Done' } },
            { id: 3, parent: { id: 2 }, content: { raw: '👍' } },
            { id: 4, parent: { id: 2 }, content: { raw: ':+1:' } },
            // answered by a shown reply: stays a comment, so its reply keeps its place
            { id: 5, parent: { id: 1 }, content: { raw: '🎉' } },
            { id: 6, parent: { id: 5 }, content: { raw: 'Why?' } },
            // parent not listed
            { id: 7, parent: { id: 99 }, content: { raw: '👍' } },
            // deleted (Bitbucket blanks its text): never a reaction
            { id: 8, parent: { id: 2 }, content: { raw: '', html: '' }, deleted: true },
            // its only reply (a like) was taken back: nothing shown under it any more, a reaction again
            { id: 9, parent: { id: 2 }, content: { raw: '✅' } },
            { id: 10, parent: { id: 9 }, content: { raw: '', html: '' }, deleted: true },
            // a reaction to a reaction: the first one stays a comment, the second one shows on it
            { id: 11, parent: { id: 2 }, content: { raw: '🚀' } },
            { id: 12, parent: { id: 11 }, content: { raw: '👀' } },
        ];
        expect(reactionReplies(comments)).toEqual(new Map([[3, '👍'], [4, '👍'], [9, '✅'], [12, '👀']]));
    });

    it('classifyComments: a deleted comment shows only while a shown comment is under it, never for a reaction alone', () => {
        const comments = [
            // deleted root and reply kept for the comment under them; the deleted leaf goes
            { id: 1, content: { raw: '' }, deleted: true },
            { id: 2, parent: { id: 1 }, content: { raw: '' }, deleted: true },
            { id: 3, parent: { id: 2 }, content: { raw: 'Still here' } },
            { id: 4, parent: { id: 3 }, content: { raw: '' }, deleted: true },
            // a deleted chain with nothing shown under it goes whole
            { id: 5, parent: { id: 3 }, content: { raw: '' }, deleted: true },
            { id: 6, parent: { id: 5 }, content: { raw: '' }, deleted: true },
            // a live reaction does not keep a deleted comment (it goes with it)
            { id: 7, content: { raw: '' }, deleted: true },
            { id: 8, parent: { id: 7 }, content: { raw: '👍' } },
        ];
        const { reactions, hidden } = classifyComments(comments);
        expect(reactions).toEqual(new Map([[8, '👍']]));
        expect([...hidden].sort((a, b) => a - b)).toEqual([4, 5, 6, 7]);
    });
});
