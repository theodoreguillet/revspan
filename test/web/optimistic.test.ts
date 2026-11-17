import { describe, expect, it } from 'vitest';
import type { Comment, Comparison, DiffLine, FileDiff } from '../../src/shared/api.ts';
import {
    removeComment, replaceComment, withEditedComment, withMyPulseEntry, withMyReaction, withMyReactionId, withMyReview, withoutMyReaction, withPendingComment, withPlacement,
    withReactions, withResolved, withReviewedMark,
} from '../../src/web/lib/optimistic.ts';
import { commentById, prLong, threadById } from './fixtures.ts';

const me = { uuid: '{me-uuid}', displayName: 'Thomas Girard', nickname: 'tgirard' };

function serverComment(id: number, raw: string): Comment {
    return { id, user: me, createdOn: '2026-11-16T10:00:00Z', version: null, html: `<p>${raw}</p>`, raw, isNew: false, deleted: false, mine: true, reactions: [], parentId: null };
}

const line = (n: number, t: DiffLine['t'] = ' '): DiffLine => ({ t, o: t === '+' ? null : n, n: t === '-' ? null : n, text: `line ${n}`, hl: [] });

function file(path: string): FileDiff {
    return {
        path, oldPath: null, status: 'modified', category: 'code', binary: false, tooLarge: false, added: 1, removed: 1, contentHash: 'h', conflict: false,
        hunks: [{ oldStart: 10, oldLines: 3, newStart: 10, newLines: 3, header: '', lines: [line(10), line(11, '-'), line(11, '+'), line(12)] }],
        threads: [{ threadId: 120, line: 12, moved: false, outOfHunks: false }],
    };
}

function comparison(): Comparison {
    return {
        from: 7, to: 10, stats: { files: 2, added: 2, removed: 2 }, files: [file('src/A.ts'), file('src/B.ts')], masterOnly: [], messageChanged: false, messageFrom: '', messageTo: '',
    };
}

describe('optimistic updates of the PR detail', () => {
    it('adds a pending reply at the end of its thread', () => {
        const detail = prLong().data;
        const next = withPendingComment(detail, { tempId: -1, raw: 'Looks good', threadId: 120, inline: null }, me);

        const thread = threadById(next, 120);
        expect(thread.comments).toHaveLength(3);
        expect(thread.comments.at(-1)).toMatchObject({ id: -1, raw: 'Looks good', user: me, mine: true, pending: true, deleted: false, isNew: false, reactions: [], parentId: 120 });
        expect(threadById(detail, 120).comments).toHaveLength(2);
        expect(next.threads).toHaveLength(detail.threads.length);
    });

    it('adds a pending inline root as a new thread', () => {
        const detail = prLong().data;
        const next = withPendingComment(detail, { tempId: -2, raw: 'Why?', threadId: null, inline: { path: 'src/A.ts', to: 12 } }, me);

        expect(next.threads).toHaveLength(detail.threads.length + 1);
        expect(next.threads.at(-1)).toMatchObject({
            id: -2, path: 'src/A.ts', anchor: { to: 12, from: null }, version: 10, resolved: false, resolvedBy: null,
            comments: [{ id: -2, raw: 'Why?', pending: true, parentId: null }],
        });
        expect(next.pulse).toBe(detail.pulse);
    });

    it('replaceComment swaps the pending comment and renames a new thread', () => {
        const detail = prLong().data;
        const withReply = withPendingComment(detail, { tempId: -1, raw: 'Looks good', threadId: 120, inline: null }, me);
        const withRoot = withPendingComment(withReply, { tempId: -2, raw: 'Why?', threadId: null, inline: { path: 'src/A.ts', to: 12 } }, me);

        const replied = replaceComment(withRoot, -1, serverComment(501, 'Looks good'));
        expect(threadById(replied, 120).comments.at(-1)).toEqual(serverComment(501, 'Looks good'));

        const rooted = replaceComment(replied, -2, serverComment(502, 'Why?'));
        expect(rooted.threads.some((t) => t.id === -2)).toBe(false);
        expect(threadById(rooted, 502).comments).toEqual([serverComment(502, 'Why?')]);
        expect(threadById(rooted, 502).path).toBe('src/A.ts');
    });

    it('withEditedComment swaps text and HTML and keeps the rest', () => {
        const detail = prLong().data;
        const original = threadById(detail, 120).comments[0]!;
        const next = withEditedComment(detail, { ...original, raw: 'Edited', html: '<p>Edited</p>', isNew: true, version: 99 });

        expect(threadById(next, 120).comments[0]).toEqual({ ...original, raw: 'Edited', html: '<p>Edited</p>' });
        expect(threadById(next, 120).comments[1]).toEqual(threadById(detail, 120).comments[1]);
        expect(threadById(detail, 120).comments[0]).toEqual(original);
        expect(next.threads).toHaveLength(detail.threads.length);
    });

    it('withResolved sets resolvedBy to me and clears it on reopen', () => {
        const detail = prLong().data;
        const resolved = withResolved(detail, 120, true, me);
        expect(threadById(resolved, 120)).toMatchObject({ resolved: true, resolvedBy: me });
        expect(threadById(detail, 120).resolved).toBe(false);

        const reopened = withResolved(resolved, 120, false, me);
        expect(threadById(reopened, 120)).toMatchObject({ resolved: false, resolvedBy: null });
    });
});

describe('optimistic placement of a new inline thread', () => {
    it('withPlacement marks a line outside the hunks', () => {
        const cmp = comparison();
        const inside = withPlacement(cmp, 'src/A.ts', 501, 11);
        expect(inside.files[0]?.threads).toContainEqual({ threadId: 501, line: 11, moved: false, outOfHunks: false });

        const outside = withPlacement(cmp, 'src/A.ts', 502, 40);
        expect(outside.files[0]?.threads).toContainEqual({ threadId: 502, line: 40, moved: false, outOfHunks: true });
        expect(cmp.files[0]?.threads).toHaveLength(1);
    });

    it('withPlacement leaves another file untouched', () => {
        const cmp = comparison();
        const next = withPlacement(cmp, 'src/A.ts', 501, 12);
        expect(next.files[1]).toBe(cmp.files[1]);
        expect(withPlacement(cmp, 'src/Missing.ts', 501, 12)).toBe(cmp);
    });
});

describe('my review state shown at once', () => {
    const AT = '2026-11-16T12:00:00Z';
    const mine = (d: ReturnType<typeof prLong>['data']) => d.participants.find((p) => p.user?.uuid === me.uuid);

    it('approve: approved on the latest version, counted as a review of it, pulse entry matching', () => {
        const base = prLong().data;
        const data = { ...base, pulse: { ...base.pulse, participants: '{me-uuid}:0:,{yan}:1:approved' } };
        const next = withMyReview(data, { approved: true, state: 'approved' }, AT);
        expect(mine(next)).toMatchObject({ approved: true, state: 'approved', approvedVersion: 10, role: 'REVIEWER' });
        expect(next.review).toMatchObject({ lastReviewed: 10, lastReviewedSource: 'approval', lastReviewedAt: AT, viewed: data.review.viewed });
        expect(next.pulse.participants).toBe('{me-uuid}:1:approved,{yan}:1:approved');
        expect(next.participants.filter((p) => p.user?.uuid !== me.uuid)).toEqual(data.participants.filter((p) => p.user?.uuid !== me.uuid));
    });

    it('requesting changes keeps the review mark: the state is patched, the review is not', () => {
        const data = prLong().data;
        const requested = withMyReview(data, { approved: false, state: 'changes_requested' }, AT);
        expect(mine(requested)).toMatchObject({ approved: false, state: 'changes_requested', approvedVersion: 10 });
        expect(requested.review).toEqual(data.review);
        expect(requested.pulse.participants).toBe('{me-uuid}:0:changes_requested');
        const withdrawn = withMyReview(requested, { approved: false, state: null }, AT);
        expect(mine(withdrawn)).toMatchObject({ approved: false, state: null, approvedVersion: null });
        expect(withdrawn.review).toEqual(requested.review);
        expect(withdrawn.pulse.participants).toBe('{me-uuid}:0:');
    });

    it('not a participant yet: added as a participant', () => {
        const base = prLong().data;
        const data = { ...base, participants: base.participants.filter((p) => p.user?.uuid !== me.uuid) };
        expect(mine(withMyReview(data, { approved: true, state: 'approved' }, AT))).toMatchObject({ user: me, role: 'PARTICIPANT', approved: true });
    });

    it('no profile (me unknown): unchanged', () => {
        const data = { ...prLong().data, me: null };
        expect(withMyReview(data, { approved: true, state: 'approved' }, AT)).toBe(data);
    });

    it('Mark as reviewed: the version, unless a later one is already reviewed', () => {
        const data = prLong().data;
        expect(withReviewedMark(data, 10, AT).review).toMatchObject({ lastReviewed: 10, lastReviewedSource: 'local', lastReviewedAt: AT });
        expect(withReviewedMark(data, 5, AT)).toBe(data);
    });

    it('pulse entry: replaced, added, sorted', () => {
        expect(withMyPulseEntry('', '{me}', { approved: true, state: 'approved' })).toBe('{me}:1:approved');
        expect(withMyPulseEntry('{zed}:0:,{me}:0:changes_requested', '{me}', { approved: false, state: null })).toBe('{me}:0:,{zed}:0:');
    });
});

describe('optimistic deletion of a comment', () => {
    /** Thread 120 with Yann's root, Camille's reply 121, and my reply 122 to Camille's. */
    function withMyAnswer(): ReturnType<typeof prLong>['data'] {
        const detail = prLong().data;
        const mine: Comment = { ...serverComment(122, 'Thanks'), parentId: 121 };
        return { ...detail, threads: detail.threads.map((t) => (t.id === 120 ? { ...t, comments: [...t.comments, mine] } : t)) };
    }

    it('a deleted reply with nothing under it goes; the thread stays while anything is shown', () => {
        const next = removeComment(withMyAnswer(), 122);
        expect(threadById(next, 120).comments.map((c) => c.id)).toEqual([120, 121]);
        expect(next.threads).toHaveLength(prLong().data.threads.length);
    });

    it('a deleted comment with a shown reply under it stays as "deleted"; deleting that reply takes both away', () => {
        const kept = removeComment(withMyAnswer(), 121);
        expect(threadById(kept, 120).comments.map((c) => [c.id, c.deleted, c.raw])).toEqual([[120, false, 'can we reuse the batch loader here ?'], [121, true, ''], [122, false, 'Thanks']]);
        const gone = removeComment(kept, 122);
        expect(threadById(gone, 120).comments.map((c) => c.id)).toEqual([120]);
    });

    it('a thread with nothing shown left goes (a deleted root with a shown reply stays)', () => {
        const rootDeleted = removeComment(withMyAnswer(), 120);
        expect(threadById(rootDeleted, 120).comments.map((c) => [c.id, c.deleted])).toEqual([[120, true], [121, false], [122, false]]);
        const empty = removeComment(removeComment(rootDeleted, 122), 121);
        expect(empty.threads.some((t) => t.id === 120)).toBe(false);
    });

    it('a pending comment that could not be sent goes, its thread too when it was the only comment', () => {
        const detail = prLong().data;
        const reply = withPendingComment(detail, { tempId: -1, raw: 'Looks good', threadId: 120, inline: null }, me);
        expect(threadById(removeComment(reply, -1), 120).comments).toEqual(threadById(detail, 120).comments);
        const root = withPendingComment(detail, { tempId: -2, raw: 'Why?', threadId: null, inline: { path: 'src/A.ts', to: 12 } }, me);
        expect(removeComment(root, -2).threads).toEqual(detail.threads);
    });
});

describe('optimistic likes', () => {
    const yann = { uuid: '{yan}', displayName: 'Yann Bernard' };

    it('withMyReaction: a new chip, or me added to an existing one (the reply id negative while it is sent)', () => {
        const detail = prLong().data;
        const liked = withMyReaction(detail, 120, '👍', -1);
        expect(commentById(liked, 120).reactions).toEqual([{ emoji: '👍', users: [me], myCommentIds: [-1] }]);
        expect(commentById(detail, 120).reactions).toEqual([]);
        expect(threadById(liked, 120).comments).toHaveLength(2);
        expect(liked.threads.find((t) => t.id !== 120)).toBe(detail.threads.find((t) => t.id !== 120));

        const others = withReactions(detail, 120, [{ emoji: '👍', users: [yann], myCommentIds: [] }, { emoji: '🎉', users: [yann], myCommentIds: [] }]);
        expect(commentById(withMyReaction(others, 120, '👍', -2), 120).reactions).toEqual([
            { emoji: '👍', users: [yann, me], myCommentIds: [-2] },
            { emoji: '🎉', users: [yann], myCommentIds: [] },
        ]);
    });

    it('withMyReactionId swaps the temporary id for Bitbucket\'s', () => {
        const detail = withMyReaction(prLong().data, 120, '👍', -1);
        expect(commentById(withMyReactionId(detail, 120, '👍', -1, 601), 120).reactions).toEqual([{ emoji: '👍', users: [me], myCommentIds: [601] }]);
    });

    it('withoutMyReaction takes me out; the chip goes when nobody is left', () => {
        const detail = prLong().data;
        expect(commentById(withoutMyReaction(detail, 121, '👍'), 121).reactions).toEqual([]);
        const shared = withReactions(detail, 121, [{ emoji: '👍', users: [me, yann], myCommentIds: [131, 132] }]);
        expect(commentById(withoutMyReaction(shared, 121, '👍'), 121).reactions).toEqual([{ emoji: '👍', users: [yann], myCommentIds: [] }]);
        expect(commentById(detail, 121).reactions).toHaveLength(1);
    });
});
