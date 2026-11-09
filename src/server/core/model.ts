// PR model built from raw Bitbucket data: versions, participants, threads, last review.
// Pure functions (network loading lives in services/).
import type {
    Comment, Participant, PrInfo, PrRef, Review, ReviewSource, Thread, User, Version,
} from '../../shared/api.ts';
import type { BbActivity, BbComment, BbPullRequest, BbUser } from '../bitbucket/types.ts';
import { sameHash } from './classify.ts';

/** Push of the PR, as read from the activity. */
export interface PushUpdate {
    hash: string;
    destHash: string | null;
    date: string;
    author: BbUser | null;
}

/** Commit of a version (commit endpoint). */
export interface CommitInfo {
    hash: string;
    message: string;
    parents: string[];
}

/** Minimal version (date + hash) enough to date the events. */
export type DatedVersion = Pick<Version, 'index' | 'hash' | 'pushedAt'>;

/** Local "reviewed" mark and seen files (stored in state.json). */
export interface LocalReview {
    reviewedHash?: string;
    reviewedAt?: string;
    viewed: Record<string, string>;
}

export function userOf(raw: BbUser | null | undefined): User | null {
    if (!raw) {
        return null;
    }
    return { uuid: raw.uuid ?? '', displayName: raw.display_name ?? raw.nickname ?? '?', nickname: raw.nickname ?? '' };
}

/** Pushes in chronological order, consecutive duplicates removed, current version added if missing. */
export function extractUpdates(activity: readonly BbActivity[], pr: BbPullRequest | null): PushUpdate[] {
    const updates: PushUpdate[] = [];
    for (const entry of activity) {
        const hash = entry.update?.source?.commit?.hash;
        if (entry.update && hash) {
            updates.push({
                hash,
                destHash: entry.update.destination?.commit?.hash ?? null,
                date: entry.update.date,
                author: entry.update.author ?? null,
            });
        }
    }
    updates.sort((a, b) => a.date.localeCompare(b.date));

    const out: PushUpdate[] = [];
    for (const update of updates) {
        const last = out[out.length - 1];
        if (!last || !sameHash(last.hash, update.hash)) {
            out.push(update);
        }
    }
    const current = pr?.source?.commit?.hash;
    const last = out[out.length - 1];
    if (pr && current && (!last || !sameHash(last.hash, current))) {
        out.push({
            hash: current,
            destHash: pr.destination?.commit?.hash ?? null,
            date: pr.updated_on ?? new Date().toISOString(),
            author: pr.author ?? null,
        });
    }
    return out;
}

/**
 * commits[i] and bases[i] (real merge-base, or null) match updates[i]. A missing commit (null) = unavailable
 * version: Bitbucket erased it. Rebase and message are compared with the last readable version.
 */
export function buildVersions(updates: readonly PushUpdate[], commits: readonly (CommitInfo | null | undefined)[], bases: readonly (string | null)[]): Version[] {
    const versions: Version[] = [];
    let previousReadable: Version | undefined;
    updates.forEach((update, i) => {
        const commit = commits[i] ?? null;
        const available = commit !== null;
        const hash = commit?.hash ?? update.hash;
        const base = available ? bases[i] ?? commit.parents[0] ?? update.destHash ?? '' : '';
        const message = commit?.message ?? '';
        const version: Version = {
            index: i + 1,
            hash,
            shortHash: hash.slice(0, 7),
            pushedAt: update.date,
            pushedBy: userOf(update.author),
            destHash: update.destHash ?? '',
            base,
            baseShort: base.slice(0, 7),
            isRebase: available && previousReadable !== undefined && !sameHash(previousReadable.base, base),
            message,
            messageChanged: available && previousReadable !== undefined && previousReadable.message.trim() !== message.trim(),
            available,
        };
        versions.push(version);
        if (available) {
            previousReadable = version;
        }
    });
    return versions;
}

/** Version whose commit still exists (`available` absent = readable). */
export const isReadable = (version: Partial<Pick<Version, 'available'>> | undefined): boolean => version !== undefined && version.available !== false;

/** Last readable version before `index` (0 = master base if none). */
export function previousAvailable(versions: readonly Partial<Pick<Version, 'available'>>[], index: number): number {
    for (let k = index - 1; k >= 1; k--) {
        if (isReadable(versions[k - 1])) {
            return k;
        }
    }
    return 0;
}

/** Index of the version in progress at a given date (1 if the event precedes the 1st version). */
export function versionAt(versions: readonly DatedVersion[], isoDate: string): number {
    let index = versions.length > 0 ? 1 : 0;
    for (const version of versions) {
        if (version.pushedAt <= isoDate) {
            index = version.index;
        }
    }
    return index;
}

export function versionByHash<V extends DatedVersion>(versions: readonly V[], hash: string): V | null {
    return versions.find((v) => sameHash(v.hash, hash)) ?? null;
}

/** A reply (discussion) does not count as a review. */
export function isReply(comment: Pick<BbComment, 'parent'>): boolean {
    return Boolean(comment.parent?.id);
}

interface ReviewCandidate {
    source: ReviewSource;
    at: string;
    version: number;
}

/**
 * Last review = the most recent of my approvals / change requests / new comments,
 * or of the local "reviewed" mark.
 */
export function computeReview(input: {
    versions: readonly DatedVersion[];
    activity: readonly BbActivity[];
    comments: readonly BbComment[];
    meUuid: string | null;
    local: LocalReview | null;
}): Review {
    const { versions, activity, comments, meUuid, local } = input;
    const candidates: ReviewCandidate[] = [];
    if (meUuid) {
        for (const entry of activity) {
            const event = entry.approval ?? entry.changes_requested;
            if (event?.user?.uuid === meUuid && event.date) {
                candidates.push({ source: 'approval', at: event.date, version: versionAt(versions, event.date) });
            }
        }
        for (const comment of comments) {
            if (comment.user?.uuid === meUuid && !comment.deleted && comment.created_on && !isReply(comment)) {
                candidates.push({ source: 'comment', at: comment.created_on, version: versionAt(versions, comment.created_on) });
            }
        }
    }
    if (local?.reviewedHash) {
        const version = versionByHash(versions, local.reviewedHash);
        if (version) {
            candidates.push({ source: 'local', at: local.reviewedAt ?? version.pushedAt, version: version.index });
        }
    }
    let best: ReviewCandidate | null = null;
    for (const candidate of candidates) {
        if (!best || candidate.version > best.version || (candidate.version === best.version && candidate.at > best.at)) {
            best = candidate;
        }
    }
    return {
        lastReviewed: best?.version ?? null,
        lastReviewedSource: best?.source ?? null,
        lastReviewedAt: best?.at ?? null,
        viewed: { ...local?.viewed },
    };
}

export function buildParticipants(pr: BbPullRequest, activity: readonly BbActivity[], versions: readonly DatedVersion[]): Participant[] {
    const lastEvent = new Map<string, string>();
    for (const entry of activity) {
        const event = entry.approval ?? entry.changes_requested;
        const uuid = event?.user?.uuid;
        if (uuid && event.date && (lastEvent.get(uuid) ?? '') < event.date) {
            lastEvent.set(uuid, event.date);
        }
    }
    return (pr.participants ?? []).map((p): Participant => {
        const state = p.state ?? (p.approved ? 'approved' : null);
        const date = p.user?.uuid ? lastEvent.get(p.user.uuid) : undefined;
        return {
            user: userOf(p.user),
            role: p.role ?? 'PARTICIPANT',
            approved: Boolean(p.approved),
            state: state === 'approved' || state === 'changes_requested' ? state : null,
            approvedVersion: state && date ? versionAt(versions, date) : null,
        };
    });
}

function toComment(c: BbComment, versions: readonly DatedVersion[], meUuid: string | null, sinceDate: string | null): Comment {
    return {
        id: c.id,
        user: userOf(c.user),
        createdOn: c.created_on,
        version: versionAt(versions, c.created_on),
        html: c.deleted ? '' : (c.content?.html ?? ''),
        raw: c.deleted ? '' : (c.content?.raw ?? ''),
        isNew: sinceDate !== null && !c.deleted && c.created_on > sinceDate && c.user?.uuid !== meUuid,
        deleted: Boolean(c.deleted),
        mine: Boolean(meUuid) && c.user?.uuid === meUuid,
    };
}

/** Comment threads (root + replies, in order). */
export function buildThreads(
    rawComments: readonly BbComment[],
    versions: readonly DatedVersion[],
    { meUuid, sinceDate }: { meUuid: string | null; sinceDate: string | null },
): Thread[] {
    const byId = new Map(rawComments.map((c) => [c.id, c]));

    const rootOf = (comment: BbComment): BbComment => {
        let current = comment;
        const seen = new Set<number>();
        let parent = current.parent ? byId.get(current.parent.id) : undefined;
        while (parent && !seen.has(current.id)) {
            seen.add(current.id);
            current = parent;
            parent = current.parent ? byId.get(current.parent.id) : undefined;
        }
        return current;
    };

    const comments = new Map(rawComments.map((c) => [c.id, toComment(c, versions, meUuid, sinceDate)]));

    const threads = new Map<number, Thread>();
    for (const c of rawComments) {
        const comment = comments.get(c.id);
        if (!comment) {
            continue;
        }
        const root = rootOf(c);
        let thread = threads.get(root.id);
        if (!thread) {
            thread = {
                id: root.id,
                path: root.inline?.path ?? null,
                anchor: root.inline ? { to: root.inline.to ?? null, from: root.inline.from ?? null } : null,
                version: versionAt(versions, root.created_on),
                resolved: Boolean(root.resolution),
                resolvedBy: userOf(root.resolution?.user),
                comments: [],
            };
            threads.set(root.id, thread);
        }
        thread.comments.push(comment);
    }
    const list = [...threads.values()];
    for (const thread of list) {
        thread.comments.sort((a, b) => (a.id === thread.id ? -1 : b.id === thread.id ? 1 : a.createdOn.localeCompare(b.createdOn)));
    }
    // A thread whose comments are all deleted is no longer of interest.
    return list
        .filter((t) => t.comments.some((c) => !c.deleted))
        .sort((a, b) => (a.comments[0]?.createdOn ?? '').localeCompare(b.comments[0]?.createdOn ?? ''));
}

export function prInfo(ref: PrRef, pr: BbPullRequest): PrInfo {
    return {
        ...ref,
        title: pr.title ?? '',
        description: pr.description ?? '',
        state: pr.state ?? 'OPEN',
        author: userOf(pr.author),
        sourceBranch: pr.source?.branch?.name ?? '',
        destBranch: pr.destination?.branch?.name ?? '',
        createdOn: pr.created_on ?? '',
        updatedOn: pr.updated_on ?? '',
        url: prUrl(ref, pr),
    };
}

export function prUrl(ref: PrRef, pr: BbPullRequest): string {
    return pr.links?.html?.href ?? `https://bitbucket.org/${ref.workspace}/${ref.repo}/pull-requests/${ref.id}`;
}
