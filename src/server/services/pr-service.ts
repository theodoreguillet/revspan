// Une PR : versions, comparaisons, résumés, et actions (commentaires, résolution, approbation).
import type {
    Comment, Comparison, NewComment, Ok, PrDetail, PrRef, Summary, Thread, Version, ViewedRequest,
} from '../../shared/api.ts';
import type { BitbucketClient } from '../bitbucket/client.ts';
import { compareVersions, fileSides, placeThreads, summarizeVersion, type CompareSource } from '../core/compare.ts';
import {
    buildParticipants, buildThreads, buildVersions, computeReview, extractUpdates, isReadable, previousAvailable, prInfo, userOf, type PushUpdate,
} from '../core/model.ts';
import { AppError, badRequest } from '../errors.ts';
import type { Cache } from '../infra/cache.ts';
import { prKeyOf, type Store } from '../infra/config.ts';
import type { BitbucketSession } from './session.ts';

/** À incrémenter si le calcul des résumés change (invalide le cache disque). */
const SUMMARY_VERSION = 4;

interface LoadedPr {
    client: BitbucketClient;
    /** Pushs lus dans l'activité : updates[i] est la version i + 1. */
    updates: PushUpdate[];
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
        const { versions, results } = await this.withVersions(ref, async ({ versions }, src) => ({
            versions,
            // Version indisponible : résumé immédiat, jamais mis en cache.
            results: await Promise.all(versions.map((v) => (v.available
                ? this.cache.getOrCompute(summaryKey(ref, v, versions[previousAvailable(versions, v.index) - 1]), () => summarizeVersion(src, versions, v.index))
                : summarizeVersion(src, versions, v.index)))),
        }));
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
        return this.withVersions(ref, async ({ versions, detail }, src) => {
            assertComparable(versions, from, to);
            const result = await compareVersions(src, versions, from, to, { context });
            return placeThreads(src, versions, result, detail.threads);
        });
    }

    /** Contenu des deux côtés d'un fichier, tel que comparé (pour l'éditeur de diff de VS Code). */
    async fileSides(ref: PrRef, from: number, to: number, file: { path: string; oldPath: string | null }): Promise<{ oldText: string; newText: string }> {
        return this.withVersions(ref, ({ versions }, src) => {
            assertComparable(versions, from, to);
            return fileSides(src, versions, from, to, file);
        });
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
            throw badRequest(`Unknown version: ${version}`);
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
        const updates = extractUpdates(activity, pr);
        const versions = await loadVersions(client, ref, updates);
        if (versions.length === 0) {
            throw new AppError(404, 'BB_NOT_FOUND', 'No version found for this pull request.', { reason: 'no-versions' });
        }
        const meUuid = me?.uuid ?? null;
        const review = computeReview({ versions, activity, comments, meUuid, local: this.store.prState(prKeyOf(ref)) });
        const threads: Thread[] = buildThreads(comments, versions, { meUuid, sinceDate: review.lastReviewedAt });
        return {
            client,
            updates,
            versions,
            detail: { pr: prInfo(ref, pr), me, versions, participants: buildParticipants(pr, activity, versions), review, threads },
        };
    }

    /**
     * Calcul sur les versions de la PR. Un commit mis en cache puis effacé par Bitbucket ne se révèle qu'ici (404 sur ses
     * contenus) : il est oublié avec ce qui en dépend, la PR rechargée (la version devient indisponible) et le calcul repris.
     */
    private async withVersions<T>(ref: PrRef, run: (loaded: LoadedPr, src: CompareSource) => Promise<T>): Promise<T> {
        let loaded = await this.load(ref);
        const purged = new Set<string>();
        for (;;) {
            try {
                return await run(loaded, purgeAwareSource(loaded.client, ref, loaded.versions));
            } catch (error) {
                // Garde-fou : une version déjà oubliée qui revient (Bitbucket se contredit) arrête la reprise (410).
                if (!(error instanceof VersionPurgedError) || purged.has(error.version.hash)) {
                    throw error;
                }
                const { hash } = error.version;
                purged.add(hash);
                this.forgetVersion(ref, loaded, error.version);
                loaded = await this.load(ref);
                // Si Bitbucket relit quand même ce commit (contenus en 404), on s'arrête là (410) au lieu de boucler.
                if (loaded.versions.some((v) => v.hash === hash && isReadable(v))) {
                    throw error;
                }
            }
        }
    }

    /** Oublie le commit d'une version effacée, sa merge-base et les résumés calculés avec elle (le sien, celui de la suivante). */
    private forgetVersion(ref: PrRef, { client, updates, versions }: LoadedPr, version: Version): void {
        // Clés telles qu'au chargement (loadVersions) : commit demandé par le hash de l'activité, merge-base par le hash complet.
        client.forgetCommit(ref.workspace, ref.repo, updates[version.index - 1]?.hash ?? version.hash);
        client.forgetMergeBase(ref.workspace, ref.repo, version.hash, version.destHash);
        this.cache.delete(summaryKey(ref, version, versions[previousAvailable(versions, version.index) - 1]));
        const next = versions.find((v) => v.index > version.index && isReadable(v));
        if (next) {
            this.cache.delete(summaryKey(ref, next, version));
        }
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
async function loadVersions(client: BitbucketClient, ref: PrRef, updates: readonly PushUpdate[]): Promise<Version[]> {
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

const unavailableMessage = (index: number): string =>
    `Version v${index} is no longer available: Bitbucket deleted its commit (version overwritten by a force-push).`;

/** Bornes valides et versions lisibles (une version dont Bitbucket a effacé le commit ne peut pas être comparée). */
function assertComparable(versions: readonly Version[], from: number, to: number): void {
    if (to > versions.length || from >= to) {
        throw badRequest(`Invalid comparison: from ${from} to ${to} (versions 1 to ${versions.length}).`);
    }
    const unreadable = [from, to].find((index) => index > 0 && !isReadable(versions[index - 1]));
    if (unreadable !== undefined) {
        throw new AppError(410, 'VERSION_UNAVAILABLE', unavailableMessage(unreadable), { version: unreadable });
    }
}

/** Commit d'une version lisible effacé par Bitbucket depuis sa mise en cache. */
class VersionPurgedError extends AppError {
    readonly version: Version;

    constructor(version: Version) {
        super(410, 'VERSION_UNAVAILABLE', unavailableMessage(version.index), { version: version.index });
        this.version = version;
    }
}

/**
 * Source de comparaison qui reconnaît une version effacée après sa mise en cache : sur un 404 (diffstat) ou un contenu
 * absent (src) portant sur le hash d'une version lisible, Bitbucket est interrogé sur le commit lui-même.
 */
function purgeAwareSource(client: BitbucketClient, ref: PrRef, versions: readonly Version[]): CompareSource {
    const src = client.source(ref.workspace, ref.repo);
    const readable = new Map(versions.filter(isReadable).map((v) => [v.hash, v]));
    const assertExists = async (hashes: readonly string[]): Promise<void> => {
        for (const hash of hashes) {
            const version = readable.get(hash);
            if (version && !await client.commitExists(ref.workspace, ref.repo, hash)) {
                throw new VersionPurgedError(version);
            }
        }
    };
    return {
        diffstat: async (newHash, oldHash) => {
            try {
                return await src.diffstat(newHash, oldHash);
            } catch (error) {
                if (error instanceof AppError && error.code === 'BB_NOT_FOUND') {
                    await assertExists([newHash, oldHash]);
                }
                throw error;
            }
        },
        content: async (hash, path) => {
            const content = await src.content(hash, path);
            if ('missing' in content) {
                await assertExists([hash]);
            }
            return content;
        },
    };
}

/** Clé de cache d'un résumé : dépend uniquement des commits (immuables) de la version et de sa version de référence. */
function summaryKey(ref: PrRef, v: Version, prev: Version | undefined): string {
    const previous = prev ? `${prev.hash}:${prev.base}` : 'creation';
    return `summary:${SUMMARY_VERSION}:${ref.workspace}/${ref.repo}:${previous}:${v.hash}:${v.base}:${v.isRebase}:${v.messageChanged}`;
}

