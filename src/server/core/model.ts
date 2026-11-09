// Modèle d'une PR à partir des données brutes Bitbucket : versions, participants, fils, dernière relecture.
// Fonctions pures (le chargement réseau est dans services/).
import type {
    Comment, Participant, PrInfo, PrRef, Reaction, Review, ReviewSource, Thread, User, Version,
} from '../../shared/api.ts';
import type { BbActivity, BbComment, BbPullRequest, BbUser } from '../bitbucket/types.ts';
import { reactionOf, sameHash } from './classify.ts';

/** Push de la PR, tel que lu dans l'activité. */
export interface PushUpdate {
    hash: string;
    destHash: string | null;
    date: string;
    author: BbUser | null;
}

/** Commit d'une version (endpoint commit). */
export interface CommitInfo {
    hash: string;
    message: string;
    parents: string[];
}

/** Version minimale (date + hash) suffisante pour dater les événements. */
export type DatedVersion = Pick<Version, 'index' | 'hash' | 'pushedAt'>;

/** Marque locale « relue » et fichiers vus (stockés dans state.json). */
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

/** Pushs dans l'ordre chronologique, doublons consécutifs retirés, version courante ajoutée si absente. */
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
 * commits[i] et bases[i] (merge-base réelle, ou null) correspondent à updates[i]. Un commit absent (null) = version
 * indisponible : Bitbucket l'a effacé. Rebase et message se comparent à la dernière version lisible.
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

/** Version dont le commit existe encore (`available` absent = lisible). */
export const isReadable = (version: Partial<Pick<Version, 'available'>> | undefined): boolean => version !== undefined && version.available !== false;

/** Dernière version lisible avant `index` (0 = base master si aucune). */
export function previousAvailable(versions: readonly Partial<Pick<Version, 'available'>>[], index: number): number {
    for (let k = index - 1; k >= 1; k--) {
        if (isReadable(versions[k - 1])) {
            return k;
        }
    }
    return 0;
}

/** Index de la version en cours à une date donnée (1 si l'événement précède la 1re version). */
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

/** Une réponse (discussion) ou une réaction (👍) ne vaut pas relecture. */
export function isReplyOrReaction(comment: Pick<BbComment, 'parent' | 'content'>): boolean {
    return Boolean(comment.parent?.id) || reactionOf(comment.content?.raw) !== null;
}

interface ReviewCandidate {
    source: ReviewSource;
    at: string;
    version: number;
}

/**
 * Dernière relecture = la plus récente des approbations / demandes de modifs / nouveaux commentaires de moi,
 * ou de la marque locale « relue ».
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
            if (comment.user?.uuid === meUuid && !comment.deleted && comment.created_on && !isReplyOrReaction(comment)) {
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
        reactions: [],
    };
}

function groupReactions(list: readonly { emoji: string; comment: BbComment }[], meUuid: string | null): Reaction[] {
    const grouped = new Map<string, Reaction>();
    const sorted = [...list].sort((a, b) => a.comment.created_on.localeCompare(b.comment.created_on));
    for (const { emoji, comment } of sorted) {
        const reaction = grouped.get(emoji) ?? { emoji, users: [], myCommentIds: [] };
        const user = userOf(comment.user);
        if (user && !reaction.users.some((u) => u.uuid === user.uuid)) {
            reaction.users.push(user);
        }
        if (meUuid && comment.user?.uuid === meUuid) {
            reaction.myCommentIds.push(comment.id);
        }
        grouped.set(emoji, reaction);
    }
    return [...grouped.values()];
}

/** Fils de commentaires ; les réponses composées d'un seul emoji deviennent des réactions. */
export function buildThreads(
    rawComments: readonly BbComment[],
    versions: readonly DatedVersion[],
    { meUuid, sinceDate }: { meUuid: string | null; sinceDate: string | null },
): Thread[] {
    const byId = new Map(rawComments.map((c) => [c.id, c]));
    const parents = new Set(rawComments.flatMap((c) => (c.parent?.id ? [c.parent.id] : [])));

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

    const comments = new Map<number, Comment>();
    const reactionsOf = new Map<number, { emoji: string; comment: BbComment }[]>();
    for (const c of rawComments) {
        const emoji = c.parent?.id && !c.deleted && !parents.has(c.id) ? reactionOf(c.content?.raw) : null;
        if (emoji && c.parent && byId.has(c.parent.id)) {
            const list = reactionsOf.get(c.parent.id) ?? [];
            list.push({ emoji, comment: c });
            reactionsOf.set(c.parent.id, list);
        } else {
            comments.set(c.id, toComment(c, versions, meUuid, sinceDate));
        }
    }
    for (const [parentId, list] of reactionsOf) {
        const target = comments.get(parentId);
        if (target) {
            target.reactions = groupReactions(list, meUuid);
        }
    }

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
    // Un fil dont tous les commentaires sont supprimés n'a plus d'intérêt.
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
