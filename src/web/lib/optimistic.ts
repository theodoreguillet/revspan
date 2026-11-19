// Local (optimistic) updates of the PR detail and of a comparison, applied before the server answers or right after
// a write, until the background refresh brings the server's view. Pure: every function returns new objects.
import type { Comment, Comparison, Participant, PrDetail, Reaction, ReviewSource, Thread, User } from '../../shared/api.ts';

/** Comment being sent: negative temporary id; threadId = parent thread (reply), null = new thread. */
export interface PendingComment {
    tempId: number;
    raw: string;
    threadId: number | null;
    /** New-side line `to`, or the range `startTo` to `to`. */
    inline: { path: string; to: number; startTo?: number } | null;
}

function mapThread(detail: PrDetail, threadId: number, change: (thread: Thread) => Thread): PrDetail {
    return { ...detail, threads: detail.threads.map((t) => (t.id === threadId ? change(t) : t)) };
}

function mapComment(detail: PrDetail, commentId: number, change: (comment: Comment) => Comment): PrDetail {
    return {
        ...detail,
        threads: detail.threads.map((t) => (t.comments.some((c) => c.id === commentId)
            ? { ...t, comments: t.comments.map((c) => (c.id === commentId ? change(c) : c)) }
            : t)),
    };
}

/** Adds a comment being sent: at the end of its thread (reply), or as a new thread (general or inline root). */
export function withPendingComment(detail: PrDetail, pending: PendingComment, me: User | null): PrDetail {
    const comment: Comment = {
        id: pending.tempId,
        // a reply answers its thread's root
        parentId: pending.threadId,
        user: me,
        createdOn: new Date().toISOString(),
        // same as a comment returned by the server right after its creation: no flicker when it is replaced
        version: null,
        html: '',
        raw: pending.raw,
        isNew: false,
        deleted: false,
        mine: true,
        reactions: [],
        pending: true,
    };
    if (pending.threadId !== null) {
        return mapThread(detail, pending.threadId, (t) => ({ ...t, comments: [...t.comments, comment] }));
    }
    const thread: Thread = {
        id: pending.tempId,
        path: pending.inline?.path ?? null,
        anchor: pending.inline ? { to: pending.inline.to, from: null, startTo: pending.inline.startTo ?? null, startFrom: null } : null,
        version: detail.versions.at(-1)?.index ?? 0,
        resolved: false,
        resolvedBy: null,
        comments: [comment],
    };
    return { ...detail, threads: [...detail.threads, thread] };
}

/** Replaces a pending comment by the one the server returned; a new thread takes the id of its root. */
export function replaceComment(detail: PrDetail, tempId: number, comment: Comment): PrDetail {
    return {
        ...detail,
        threads: detail.threads.map((t) => {
            if (!t.comments.some((c) => c.id === tempId)) {
                return t;
            }
            return { ...t, id: t.id === tempId ? comment.id : t.id, comments: t.comments.map((c) => (c.id === tempId ? comment : c)) };
        }),
    };
}

/**
 * The comments of a thread that stay shown, as on the server (src/shared/reactions.ts): every comment that is not
 * deleted, and a deleted one only while a shown comment is under it (by `parentId`).
 */
function shownComments(comments: readonly Comment[]): Comment[] {
    const children = new Map<number, Comment[]>();
    for (const c of comments) {
        if (c.parentId !== null) {
            children.set(c.parentId, [...children.get(c.parentId) ?? [], c]);
        }
    }
    const shown = new Map<number, boolean>();
    // `path`: the comments above, so that a parent loop in bad data cannot recurse forever
    const isShown = (c: Comment, path: Set<number>): boolean => {
        let known = shown.get(c.id);
        if (known === undefined) {
            const inner = new Set(path).add(c.id);
            known = !c.deleted || (children.get(c.id) ?? []).some((child) => !inner.has(child.id) && isShown(child, inner));
            shown.set(c.id, known);
        }
        return known;
    };
    return comments.filter((c) => isShown(c, new Set()));
}

/**
 * Removes a comment. A pending one (negative id) disappears. A deleted one shows as deleted only while a shown reply is
 * under it, as on the server; otherwise it disappears, with any deleted comment above it left with nothing shown under
 * it. A thread with nothing shown left disappears.
 */
export function removeComment(detail: PrDetail, commentId: number): PrDetail {
    const threads: Thread[] = [];
    for (const t of detail.threads) {
        if (!t.comments.some((c) => c.id === commentId)) {
            threads.push(t);
            continue;
        }
        const comments = commentId < 0
            ? t.comments.filter((c) => c.id !== commentId)
            : shownComments(t.comments.map((c) => (c.id === commentId ? { ...c, deleted: true, html: '', raw: '' } : c)));
        if (comments.some((c) => !c.deleted)) {
            threads.push({ ...t, comments });
        }
    }
    return { ...detail, threads };
}

/** The reactions of a comment replaced (put back as they were when a like or unlike fails). */
export function withReactions(detail: PrDetail, commentId: number, reactions: Reaction[]): PrDetail {
    return mapComment(detail, commentId, (c) => ({ ...c, reactions }));
}

/**
 * My reaction `emoji` on a comment, made by my reply `replyId` (a negative temporary id while it is sent): me added to
 * its chip, or a new chip at the end.
 */
export function withMyReaction(detail: PrDetail, commentId: number, emoji: string, replyId: number): PrDetail {
    const me = detail.me;
    return mapComment(detail, commentId, (c) => {
        const current = c.reactions.find((r) => r.emoji === emoji);
        if (!current) {
            return { ...c, reactions: [...c.reactions, { emoji, users: me ? [me] : [], myCommentIds: [replyId] }] };
        }
        const users = !me || current.users.some((u) => u.uuid === me.uuid) ? current.users : [...current.users, me];
        return { ...c, reactions: c.reactions.map((r) => (r === current ? { ...r, users, myCommentIds: [...r.myCommentIds, replyId] } : r)) };
    });
}

/** The temporary id of my reply making a reaction replaced by the one Bitbucket gave it. */
export function withMyReactionId(detail: PrDetail, commentId: number, emoji: string, tempId: number, id: number): PrDetail {
    return mapComment(detail, commentId, (c) => ({
        ...c,
        reactions: c.reactions.map((r) => (r.emoji === emoji ? { ...r, myCommentIds: r.myCommentIds.map((x) => (x === tempId ? id : x)) } : r)),
    }));
}

/** My reaction `emoji` taken out of a comment (my replies making it deleted); its chip goes when nobody is left. */
export function withoutMyReaction(detail: PrDetail, commentId: number, emoji: string): PrDetail {
    const meUuid = detail.me?.uuid;
    return mapComment(detail, commentId, (c) => ({
        ...c,
        reactions: c.reactions.flatMap((r) => {
            if (r.emoji !== emoji) {
                return [r];
            }
            const users = r.users.filter((u) => u.uuid !== meUuid);
            return users.length ? [{ ...r, users, myCommentIds: [] }] : [];
        }),
    }));
}

/** Resolves (by `me`) or reopens a thread. */
export function withResolved(detail: PrDetail, threadId: number, resolved: boolean, me: User | null): PrDetail {
    return mapThread(detail, threadId, (t) => ({ ...t, resolved, resolvedBy: resolved ? me : null }));
}

/** Edited comment: new text and HTML from the server, the rest (version, new mark) as computed with the detail. */
export function withEditedComment(detail: PrDetail, comment: Comment): PrDetail {
    return mapComment(detail, comment.id, (c) => ({ ...c, html: comment.html, raw: comment.raw }));
}

/**
 * Places a new inline thread on a line of the "to" side of a file, from `startLine` for a range (replaces an earlier
 * placement of the same thread). No-op if the file is not in the comparison.
 */
export function withPlacement(cmp: Comparison, path: string, threadId: number, line: number, startLine: number | null = null): Comparison {
    const index = cmp.files.findIndex((f) => f.path === path);
    const file = cmp.files[index];
    if (!file) {
        return cmp;
    }
    const outOfHunks = !file.hunks.some((h) => h.lines.some((l) => l.n === line && l.t !== '-'));
    const threads = [...file.threads.filter((p) => p.threadId !== threadId), { threadId, line, startLine, moved: false, outOfHunks }];
    const files = cmp.files.slice();
    files[index] = { ...file, threads };
    return { ...cmp, files };
}

/** Removes the placement of a thread (pending thread whose send failed or that the server renamed). */
export function withoutPlacement(cmp: Comparison, threadId: number): Comparison {
    if (!cmp.files.some((f) => f.threads.some((p) => p.threadId === threadId))) {
        return cmp;
    }
    return { ...cmp, files: cmp.files.map((f) => (f.threads.some((p) => p.threadId === threadId) ? { ...f, threads: f.threads.filter((p) => p.threadId !== threadId) } : f)) };
}

/** My review state on Bitbucket after one of my review buttons: approved, changes requested, or neither. */
export interface MyReviewState {
    approved: boolean;
    state: 'approved' | 'changes_requested' | null;
}

/** `uuid:approved:state` entry of the pulse's participants (see the server's pulseOf) replaced or added for me. */
export function withMyPulseEntry(participants: string, uuid: string, { approved, state }: MyReviewState): string {
    const entries = participants ? participants.split(',').filter((e) => !e.startsWith(`${uuid}:`)) : [];
    return [...entries, `${uuid}:${approved ? 1 : 0}:${state ?? ''}`].sort().join(',');
}

/** A review of `version` (approval or Mark as reviewed) when it is the latest one known. */
function withReviewOf(detail: PrDetail, version: number, source: ReviewSource, at: string): PrDetail {
    const { review } = detail;
    if (review.lastReviewed !== null && version < review.lastReviewed) {
        return detail;
    }
    return { ...detail, review: { ...review, lastReviewed: version, lastReviewedSource: source, lastReviewedAt: at } };
}

/**
 * My participant after a successful approve, unapprove, change request or withdrawal (Bitbucket's outcome is certain):
 * its state on the latest version, the pulse's participants matching (my own write is not news), and an approval
 * counts as a review of the latest version (a change request does not: only an approval or Mark as reviewed does).
 */
export function withMyReview(detail: PrDetail, next: MyReviewState, at: string): PrDetail {
    const me = detail.me;
    if (!me) {
        return detail;
    }
    const latest = detail.versions.at(-1)?.index ?? 0;
    const given = next.state !== null;
    const patch = { approved: next.approved, state: next.state, approvedVersion: given ? latest : null };
    const exists = detail.participants.some((p) => p.user?.uuid === me.uuid);
    const participants: Participant[] = exists
        ? detail.participants.map((p) => (p.user?.uuid === me.uuid ? { ...p, ...patch } : p))
        : [...detail.participants, { user: me, role: 'PARTICIPANT', ...patch }];
    const updated = { ...detail, participants, pulse: { ...detail.pulse, participants: withMyPulseEntry(detail.pulse.participants, me.uuid, next) } };
    return next.state === 'approved' ? withReviewOf(updated, latest, 'approval', at) : updated;
}

/** "Mark as reviewed" of a version: my last reviewed version unless I already reviewed a later one. */
export function withReviewedMark(detail: PrDetail, version: number, at: string): PrDetail {
    return withReviewOf(detail, version, 'local', at);
}
