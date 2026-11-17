// Local (optimistic) updates of the PR detail and of a comparison, applied before the server answers or right after
// a write, until the background refresh brings the server's view. Pure: every function returns new objects.
import type { Comment, Comparison, Participant, PrDetail, ReviewSource, Thread, User } from '../../shared/api.ts';

/** Comment being sent: negative temporary id; threadId = parent thread (reply), null = new thread. */
export interface PendingComment {
    tempId: number;
    raw: string;
    threadId: number | null;
    inline: { path: string; to: number } | null;
}

function mapThread(detail: PrDetail, threadId: number, change: (thread: Thread) => Thread): PrDetail {
    return { ...detail, threads: detail.threads.map((t) => (t.id === threadId ? change(t) : t)) };
}

/** Adds a comment being sent: at the end of its thread (reply), or as a new thread (general or inline root). */
export function withPendingComment(detail: PrDetail, pending: PendingComment, me: User | null): PrDetail {
    const comment: Comment = {
        id: pending.tempId,
        user: me,
        createdOn: new Date().toISOString(),
        // same as a comment returned by the server right after its creation: no flicker when it is replaced
        version: null,
        html: '',
        raw: pending.raw,
        isNew: false,
        deleted: false,
        mine: true,
        pending: true,
    };
    if (pending.threadId !== null) {
        return mapThread(detail, pending.threadId, (t) => ({ ...t, comments: [...t.comments, comment] }));
    }
    const thread: Thread = {
        id: pending.tempId,
        path: pending.inline?.path ?? null,
        anchor: pending.inline ? { to: pending.inline.to, from: null } : null,
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
 * Removes a comment: a pending one (negative id) disappears, a deleted one is marked deleted as the server shows it.
 * A thread left without any comment that is not deleted disappears, as on the server.
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
            : t.comments.map((c) => (c.id === commentId ? { ...c, deleted: true, html: '', raw: '' } : c));
        if (comments.some((c) => !c.deleted)) {
            threads.push({ ...t, comments });
        }
    }
    return { ...detail, threads };
}

/** Resolves (by `me`) or reopens a thread. */
export function withResolved(detail: PrDetail, threadId: number, resolved: boolean, me: User | null): PrDetail {
    return mapThread(detail, threadId, (t) => ({ ...t, resolved, resolvedBy: resolved ? me : null }));
}

/** Edited comment: new text and HTML from the server, the rest (version, new mark) as computed with the detail. */
export function withEditedComment(detail: PrDetail, comment: Comment): PrDetail {
    return {
        ...detail,
        threads: detail.threads.map((t) => (t.comments.some((c) => c.id === comment.id)
            ? { ...t, comments: t.comments.map((c) => (c.id === comment.id ? { ...c, html: comment.html, raw: comment.raw } : c)) }
            : t)),
    };
}

/**
 * Places a new inline thread on a line of the "to" side of a file (replaces an earlier placement of the same thread).
 * No-op if the file is not in the comparison.
 */
export function withPlacement(cmp: Comparison, path: string, threadId: number, line: number): Comparison {
    const index = cmp.files.findIndex((f) => f.path === path);
    const file = cmp.files[index];
    if (!file) {
        return cmp;
    }
    const outOfHunks = !file.hunks.some((h) => h.lines.some((l) => l.n === line && l.t !== '-'));
    const threads = [...file.threads.filter((p) => p.threadId !== threadId), { threadId, line, moved: false, outOfHunks }];
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

/** A review of `version` (approval or change request, or Mark as reviewed) when it is the latest one known. */
function withReviewOf(detail: PrDetail, version: number, source: ReviewSource, at: string): PrDetail {
    const { review } = detail;
    if (review.lastReviewed !== null && version < review.lastReviewed) {
        return detail;
    }
    return { ...detail, review: { ...review, lastReviewed: version, lastReviewedSource: source, lastReviewedAt: at } };
}

/**
 * My participant after a successful approve, unapprove, change request or withdrawal (Bitbucket's outcome is certain):
 * its state on the latest version, the pulse's participants matching (my own write is not news), and an approval or a
 * change request counts as a review of the latest version.
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
    return given ? withReviewOf(updated, latest, 'approval', at) : updated;
}

/** "Mark as reviewed" of a version: my last reviewed version unless I already reviewed a later one. */
export function withReviewedMark(detail: PrDetail, version: number, at: string): PrDetail {
    return withReviewOf(detail, version, 'local', at);
}
