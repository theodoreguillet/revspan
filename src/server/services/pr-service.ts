// Une PR : versions, comparaisons, résumés, et actions (commentaires, réactions, résolution, approbation).
import type {
    Comment, Comparison, NewComment, Ok, PrDetail, PrRef, ReactRequest, Summary, Thread, Version, ViewedRequest,
} from '../../shared/api.ts';
import type { BitbucketClient } from '../bitbucket/client.ts';
import type { BbActivity, BbPullRequest } from '../bitbucket/types.ts';
import { compareVersions, fileSides, placeThreads, summarizeVersion } from '../core/compare.ts';
import {
    buildParticipants, buildThreads, buildVersions, computeReview, extractUpdates, isReadable, previousAvailable, prInfo, userOf,
} from '../core/model.ts';
import { AppError, badRequest } from '../errors.ts';
import type { Cache } from '../infra/cache.ts';
import { prKeyOf, type Store } from '../infra/config.ts';
import type { BitbucketSession } from './session.ts';

/** À incrémenter si le calcul des résumés change (invalide le cache disque). */
const SUMMARY_VERSION = 3;

interface LoadedPr {
    client: BitbucketClient;
    versions: Version[];
    detail: PrDetail;
}

export class PrService {
    private readonly session: BitbucketSession;
    private readonly store: Store;
    private readonly cache: Cache;

    constructor({ session, store, cache }: { session: BitbucketSession; store: Store; cache: Cache }) {
        this.session = session;
        this.store = store;
        this.cache = cache;
    }

    // ---------- Lecture ----------

    async detail(ref: PrRef): Promise<PrDetail> {
        return (await this.load(ref)).detail;
    }

    async summary(ref: PrRef): Promise<Summary> {
        const { client, versions } = await this.load(ref);
        const src = client.source(ref.workspace, ref.repo);
        // Version indisponible : résumé immédiat, jamais mis en cache.
        const results = await Promise.all(versions.map((v) => (v.available
            ? this.cache.getOrCompute(summaryKey(ref, v, versions[previousAvailable(versions, v.index) - 1]), () => summarizeVersion(src, versions, v.index))
            : summarizeVersion(src, versions, v.index))));
        // Mémorise le type de chaque version pour l'accueil (pas de recalcul là-bas).
        this.store.updatePrState(prKeyOf(ref), (state) => {
            versions.forEach((version, i) => {
                const result = results[i];
                if (result) {
                    state.kinds[version.hash.slice(0, 12)] = result.kind;
                }
            });
        });
        return { versions: results };
    }

    async compare(ref: PrRef, from: number, to: number, context: number): Promise<Comparison> {
        const { client, versions, detail } = await this.load(ref);
        assertComparable(versions, from, to);
        const src = client.source(ref.workspace, ref.repo);
        const result = await compareVersions(src, versions, from, to, { context });
        return placeThreads(src, versions, result, detail.threads);
    }

    /** Contenu des deux côtés d'un fichier, tel que comparé (pour l'éditeur de diff de VS Code). */
    async fileSides(ref: PrRef, from: number, to: number, file: { path: string; oldPath: string | null }): Promise<{ oldText: string; newText: string }> {
        const { client, versions } = await this.load(ref);
        assertComparable(versions, from, to);
        return fileSides(client.source(ref.workspace, ref.repo), versions, from, to, file);
    }

    // ---------- Actions ----------

    async createComment(ref: PrRef, input: NewComment): Promise<Comment> {
        const created = await this.write(ref, (client) => client.createComment(ref.workspace, ref.repo, ref.id, input));
        const me = await this.session.me().catch(() => null);
        return {
            id: created.id,
            user: userOf(created.user),
            createdOn: created.created_on,
            version: null,
            html: created.content?.html ?? '',
            raw: created.content?.raw ?? input.raw,
            isNew: false,
            deleted: false,
            mine: Boolean(me) && created.user?.uuid === me?.uuid,
            reactions: [],
        };
    }

    async deleteComment(ref: PrRef, commentId: number): Promise<Ok> {
        await this.write(ref, (client) => client.deleteComment(ref.workspace, ref.repo, ref.id, commentId));
        return { ok: true };
    }

    async resolve(ref: PrRef, commentId: number, resolved: boolean): Promise<Ok> {
        await this.write(ref, (client) => client.resolveComment(ref.workspace, ref.repo, ref.id, commentId, resolved));
        return { ok: true };
    }

    /** Like = réponse « 👍 » (pas de réactions dans l'API Bitbucket) ; recliquer supprime mes réponses-emoji. */
    async react(ref: PrRef, { commentId, emoji }: ReactRequest): Promise<{ reacted: boolean }> {
        // Données fraîches : un like posté depuis Bitbucket ne doit pas être doublé.
        (await this.session.getClient()).invalidatePr(ref.workspace, ref.repo, ref.id);
        const { detail } = await this.load(ref);
        const comment = detail.threads.flatMap((t) => t.comments).find((c) => c.id === commentId);
        if (!comment) {
            throw new AppError(404, 'BB_NOT_FOUND', 'Commentaire introuvable.');
        }
        const mine = comment.reactions.find((r) => r.emoji === emoji)?.myCommentIds ?? [];
        if (mine.length > 0) {
            for (const id of mine) {
                await this.deleteComment(ref, id);
            }
            return { reacted: false };
        }
        await this.write(ref, (client) => client.createComment(ref.workspace, ref.repo, ref.id, { raw: emoji, parentId: comment.id }));
        return { reacted: true };
    }

    /**
     * Réapprouver : si mon approbation existe déjà (sur une version antérieure), on la retire puis on la remet,
     * pour que Bitbucket enregistre une approbation datée de maintenant (donc sur la dernière version).
     */
    async approve(ref: PrRef, on: boolean): Promise<Ok> {
        const me = on ? await this.session.me().catch(() => null) : null;
        await this.write(ref, async (client) => {
            if (me) {
                client.invalidatePr(ref.workspace, ref.repo, ref.id);
                const pr = await client.pullRequest(ref.workspace, ref.repo, ref.id);
                if ((pr.participants ?? []).some((p) => p.user?.uuid === me.uuid && p.approved)) {
                    await client.approve(ref.workspace, ref.repo, ref.id, false);
                }
            }
            await client.approve(ref.workspace, ref.repo, ref.id, on);
        });
        return { ok: true };
    }

    async requestChanges(ref: PrRef, on: boolean): Promise<Ok> {
        await this.write(ref, (client) => client.requestChanges(ref.workspace, ref.repo, ref.id, on));
        return { ok: true };
    }

    async markReviewed(ref: PrRef, version: number): Promise<Ok> {
        const { versions } = await this.load(ref);
        const target = versions[version - 1];
        if (!target) {
            throw badRequest(`Version inconnue : ${version}`);
        }
        this.store.updatePrState(prKeyOf(ref), (state) => {
            state.reviewedHash = target.hash;
            state.reviewedAt = new Date().toISOString();
        });
        return { ok: true };
    }

    markViewed(ref: PrRef, { path, contentHash, viewed }: ViewedRequest): Ok {
        this.store.updatePrState(prKeyOf(ref), (state) => {
            if (viewed) {
                state.viewed[path] = contentHash ?? '';
            } else {
                delete state.viewed[path];
            }
        });
        return { ok: true };
    }

    // ---------- Interne ----------

    private async load(ref: PrRef): Promise<LoadedPr> {
        const client = await this.session.getClient();
        const [pr, activity, comments, me] = await Promise.all([
            client.pullRequest(ref.workspace, ref.repo, ref.id),
            client.activity(ref.workspace, ref.repo, ref.id),
            client.comments(ref.workspace, ref.repo, ref.id),
            this.session.me(),
        ]);
        const versions = await loadVersions(client, ref, pr, activity);
        if (versions.length === 0) {
            throw new AppError(404, 'BB_NOT_FOUND', 'Aucune version trouvée pour cette PR.');
        }
        const meUuid = me?.uuid ?? null;
        const review = computeReview({ versions, activity, comments, meUuid, local: this.store.prState(prKeyOf(ref)) });
        const threads: Thread[] = buildThreads(comments, versions, { meUuid, sinceDate: review.lastReviewedAt });
        return {
            client,
            versions,
            detail: { pr: prInfo(ref, pr), me, versions, participants: buildParticipants(pr, activity, versions), review, threads },
        };
    }

    /** Écriture sur Bitbucket, puis invalidation des données vivantes de la PR et de l'accueil. */
    private async write<T>(ref: PrRef, action: (client: BitbucketClient) => Promise<T>): Promise<T> {
        const client = await this.session.getClient();
        try {
            return await action(client);
        } finally {
            client.invalidatePr(ref.workspace, ref.repo, ref.id);
        }
    }
}

/** Versions de la PR : commit de chaque push + base réelle (merge-base avec master au moment du push). */
async function loadVersions(client: BitbucketClient, ref: PrRef, pr: BbPullRequest, activity: BbActivity[]): Promise<Version[]> {
    const updates = extractUpdates(activity, pr);
    // null : commit effacé par Bitbucket (version écrasée par un force-push), la version est marquée indisponible.
    const commits = await Promise.all(updates.map((u) => client.commit(ref.workspace, ref.repo, u.hash)));
    const bases = await Promise.all(updates.map(async (update, i) => {
        const commit = commits[i];
        if (!commit || !update.destHash) {
            return commit?.parents[0] ?? null;
        }
        return (await client.mergeBase(ref.workspace, ref.repo, commit.hash, update.destHash)) ?? commit.parents[0] ?? null;
    }));
    return buildVersions(updates, commits, bases);
}

/** Bornes valides et versions lisibles (une version dont Bitbucket a effacé le commit ne peut pas être comparée). */
function assertComparable(versions: readonly Version[], from: number, to: number): void {
    if (to > versions.length || from >= to) {
        throw badRequest(`Comparaison invalide : de ${from} à ${to} (versions 1 à ${versions.length}).`);
    }
    const unreadable = [from, to].find((index) => index > 0 && !isReadable(versions[index - 1]));
    if (unreadable !== undefined) {
        throw new AppError(410, 'VERSION_UNAVAILABLE',
            `La version v${unreadable} n'est plus disponible : Bitbucket a effacé son commit (version écrasée par un force-push).`);
    }
}

/** Clé de cache d'un résumé : dépend uniquement des commits (immuables) de la version et de sa version de référence. */
function summaryKey(ref: PrRef, v: Version, prev: Version | undefined): string {
    const previous = prev ? `${prev.hash}:${prev.base}` : 'creation';
    return `summary:${SUMMARY_VERSION}:${ref.workspace}/${ref.repo}:${previous}:${v.hash}:${v.base}:${v.isRebase}:${v.messageChanged}`;
}

