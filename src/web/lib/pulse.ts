// What changed on Bitbucket since the detail shown: the periodic light check (pulse) and the user refresh (↻).
import type { Comment, Comparison, PrDetail, PrPulse, Thread } from '../../shared/api.ts';
import type { Translator } from '../i18n/index.ts';

/** How long the "what changed" text stays after a user refresh. */
export const REFRESH_STATUS_MS = 4000;

/** Time between two checks: the refresh interval of the settings (also the server cache's max age). */
export function pulseIntervalMs(refreshMinutes: number): number {
    return refreshMinutes * 60_000;
}

/** What a pulse found against the pulse of the detail shown. */
export interface PulseNews {
    /** The source branch moved (one or more pushes: a pulse cannot count them). */
    newVersion: boolean;
    /** More comments than shown (a deletion meanwhile hides one). */
    newComments: number;
    /** Something else moved (approval, change request, edit, resolution, deletion...). */
    otherActivity: boolean;
}

export function pulseNews(shown: PrPulse, now: PrPulse): PulseNews {
    const newVersion = now.head !== shown.head;
    const newComments = Math.max(0, now.commentCount - shown.commentCount);
    // updated_on moves with every change: it only says something when nothing more precise does (and when it is known,
    // see afterOwnWrite)
    const moved = shown.updatedOn !== UNKNOWN_UPDATED_ON && now.updatedOn !== shown.updatedOn;
    const otherActivity = now.participants !== shown.participants || (!newVersion && newComments === 0 && moved);
    return { newVersion, newComments, otherActivity };
}

/** `updatedOn` of a pulse the page patched after its own write: Bitbucket's new value is not known yet. */
const UNKNOWN_UPDATED_ON = '';

/**
 * Pulse of the detail shown after one of my writes succeeded, until the next read replaces it (even if that read
 * fails, my own write never looks like news): `commentDelta` comments more or less, `updatedOn` unknown since Bitbucket
 * moved it.
 */
export function afterOwnWrite(p: PrPulse, commentDelta = 0): PrPulse {
    return { ...p, updatedOn: UNKNOWN_UPDATED_ON, commentCount: Math.max(0, p.commentCount + commentDelta) };
}

/**
 * Pulse of the detail shown once a pulse read after my task write came back: its open task count, and Bitbucket's
 * `updatedOn` when nothing the detail shows moved meanwhile (otherwise the next check must still report it).
 */
export function afterTaskWrite(shown: PrPulse, now: PrPulse): PrPulse {
    const nothingElse = now.head === shown.head && now.commentCount === shown.commentCount && now.participants === shown.participants;
    return { ...shown, taskCount: now.taskCount, updatedOn: nothingElse ? now.updatedOn : shown.updatedOn };
}

export const hasNews = (n: PulseNews): boolean => n.newVersion || n.newComments > 0 || n.otherActivity;

export const sameNews = (a: PulseNews, b: PulseNews): boolean =>
    a.newVersion === b.newVersion && a.newComments === b.newComments && a.otherActivity === b.otherActivity;

/** What a user refresh brought, compared to the detail shown before it. */
export interface RefreshNews {
    newVersions: number;
    newComments: number;
    /** Approvals, resolutions, edited, deleted or vanished comments, reactions given or taken back. */
    otherChanges: boolean;
}

const commentsOf = (d: PrDetail): Comment[] => d.threads.flatMap((t) => t.comments);
const reactionsKey = (c: Comment): string => c.reactions.map((r) => `${r.emoji}:${r.users.map((u) => u.uuid).join(',')}`).join(' ');
const participantsKey = (d: PrDetail): string =>
    d.participants.map((p) => `${p.user?.uuid ?? ''}:${p.approved}:${p.state ?? ''}:${p.approvedVersion ?? ''}`).sort().join(',');

export function refreshNews(before: PrDetail, after: PrDetail): RefreshNews {
    const known = new Map(commentsOf(before).map((c) => [c.id, c]));
    const newComments = commentsOf(after).filter((c) => !known.has(c.id) && !c.deleted).length;
    // a comment deleted with nothing under it is no longer listed (a comment being sent has a negative id: not a change)
    const listed = new Set(commentsOf(after).map((c) => c.id));
    const vanished = [...known.keys()].some((id) => id > 0 && !listed.has(id));
    const changed = commentsOf(after).some((c) => {
        const old = known.get(c.id);
        return !!old && (old.raw !== c.raw || old.deleted !== c.deleted || reactionsKey(old) !== reactionsKey(c));
    });
    const resolved = new Map(before.threads.map((t) => [t.id, t.resolved]));
    const resolutions = after.threads.some((t) => resolved.has(t.id) && resolved.get(t.id) !== t.resolved);
    return {
        newVersions: Math.max(0, after.versions.length - before.versions.length),
        newComments,
        otherChanges: changed || vanished || resolutions || participantsKey(before) !== participantsKey(after),
    };
}

/**
 * Threads on a file of the comparison that it does not place (ids): the server places every thread on a compared
 * file, so a thread missing there was created after the comparison was computed.
 */
export function unplacedThreads(cmp: Comparison, threads: readonly Thread[]): number[] {
    return threads.filter((t) => {
        if (!t.path) {
            return false;
        }
        const file = cmp.files.find((f) => f.path === t.path || f.oldPath === t.path);
        return !!file && !file.threads.some((p) => p.threadId === t.id);
    }).map((t) => t.id);
}

/** Banner text: "New on this PR: 2 new comments · a new version". */
export function pulseText(tr: Translator, n: PulseNews): string {
    const parts = [
        ...(n.newComments > 0 ? [tr.t('pulse.newComments', { count: n.newComments })] : []),
        ...(n.newVersion ? [tr.t('pulse.newVersion')] : []),
    ];
    return parts.length ? tr.t('pulse.news', { list: parts.join(' · ') }) : tr.t('pulse.activity');
}

/** Status after a user refresh: "1 new version · 2 new comments", "Updated" or "Up to date". */
export function refreshText(tr: Translator, n: RefreshNews): string {
    const parts = [
        ...(n.newVersions > 0 ? [tr.t('pulse.newVersions', { count: n.newVersions })] : []),
        ...(n.newComments > 0 ? [tr.t('pulse.newComments', { count: n.newComments })] : []),
    ];
    if (parts.length) {
        return parts.join(' · ');
    }
    return n.otherChanges ? tr.t('pulse.updated') : tr.t('pulse.upToDate');
}
