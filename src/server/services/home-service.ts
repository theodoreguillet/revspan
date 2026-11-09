// Accueil « Mes PR » : PR ouvertes des dépôts configurés, groupées par ce qui a bougé depuis ma relecture.
import type { Home, HomeGroup, HomeGroupKey, PrCard, PrRef, User } from '../../shared/api.ts';
import type { BitbucketClient } from '../bitbucket/client.ts';
import type { BbPullRequest } from '../bitbucket/types.ts';
import { computeReview, extractUpdates, prUrl, userOf } from '../core/model.ts';
import type { Cache } from '../infra/cache.ts';
import { prKeyOf, type Store } from '../infra/config.ts';
import type { BitbucketSession } from './session.ts';

const HOME_TTL_MS = 60000;

const GROUP_TITLES: Record<HomeGroupKey, string> = {
    'to-review': 'À relire',
    'rebase-only': 'Réapprobation rapide · seulement des rebases',
    'up-to-date': 'À jour',
    'mine': 'Mes PR',
    'others': 'Autres PR ouvertes',
};

interface Card {
    group: HomeGroupKey;
    data: PrCard;
}

export class HomeService {
    private readonly session: BitbucketSession;
    private readonly store: Store;
    private readonly cache: Cache;

    constructor({ session, store, cache }: { session: BitbucketSession; store: Store; cache: Cache }) {
        this.session = session;
        this.store = store;
        this.cache = cache;
    }

    /** fresh : ignore le cache court (actualisation demandée). */
    async get({ fresh = false }: { fresh?: boolean } = {}): Promise<Home> {
        if (fresh) {
            this.cache.invalidateLive('live:home:');
        }
        const client = await this.session.getClient();
        const me = await this.session.me();
        const { repos } = this.store.config;
        return this.cache.getLive(`live:home:${repos.join(',')}`, HOME_TTL_MS, () => this.compute(client, me, repos));
    }

    private async compute(client: BitbucketClient, me: User | null, repos: readonly string[]): Promise<Home> {
        const errors: Home['errors'] = [];
        const cards: Card[] = [];
        await Promise.all(repos.map(async (fullName) => {
            const [workspace = '', repo = ''] = fullName.split('/');
            try {
                const list = await client.openPullRequests(workspace, repo);
                cards.push(...await Promise.all(list.map((raw) => this.card(client, me, { workspace, repo, id: raw.id }, raw))));
            } catch (error) {
                errors.push({ repo: fullName, message: (error as Error).message });
            }
        }));

        const groups: HomeGroup[] = (Object.keys(GROUP_TITLES) as HomeGroupKey[]).map((key) => ({
            key,
            title: GROUP_TITLES[key],
            prs: cards.filter((c) => c.group === key).map((c) => c.data).sort((a, b) => b.lastPushAt.localeCompare(a.lastPushAt)),
        }));
        errors.sort((a, b) => a.repo.localeCompare(b.repo));
        return { me, repos: [...repos], groups, errors };
    }

    private async card(client: BitbucketClient, me: User | null, ref: PrRef, raw: BbPullRequest): Promise<Card> {
        const meUuid = me?.uuid ?? null;
        const participants = raw.participants ?? [];
        const isMine = Boolean(meUuid) && raw.author?.uuid === meUuid;
        const involved = Boolean(meUuid) && (participants.some((p) => p.user?.uuid === meUuid) || (raw.reviewers ?? []).some((r) => r.uuid === meUuid));
        const local = this.store.prState(prKeyOf(ref));
        const base: PrCard = {
            ...ref,
            title: raw.title ?? '',
            author: userOf(raw.author),
            url: prUrl(ref, raw),
            createdOn: raw.created_on ?? '',
            updatedOn: raw.updated_on ?? '',
            versionsCount: null,
            lastPushAt: raw.updated_on ?? '',
            lastReviewed: null,
            newVersions: 0,
            newCodeVersions: null,
            approvals: participants.filter((p) => p.approved && p.user?.uuid !== meUuid).length,
            myApproval: participants.some((p) => p.approved && p.user?.uuid === meUuid),
            newComments: 0,
        };
        // PR qui ne me concerne pas (ni auteur, ni relecteur, ni participant, jamais marquée relue) :
        // carte légère sans l'historique, pour que l'accueil reste rapide sur beaucoup de dépôts.
        if (!isMine && !involved && !local.reviewedHash) {
            return { group: 'others', data: base };
        }

        const activity = await client.activity(ref.workspace, ref.repo, ref.id);
        const versions = extractUpdates(activity, raw).map((u, i) => ({ index: i + 1, hash: u.hash, pushedAt: u.date }));
        // Les commentaires de l'activité suffisent ici (pas de chargement de tous les commentaires).
        const myComments = activity.flatMap((e) => (e.comment && e.comment.user?.uuid === meUuid ? [e.comment] : []));
        const review = computeReview({ versions, activity, comments: myComments, meUuid, local });
        const lastReviewed = review.lastReviewed;
        const newVersions = versions.length - (lastReviewed ?? 0);

        const newKinds = versions.slice(lastReviewed ?? 0).map((v) => local.kinds[v.hash.slice(0, 12)]);
        const allKnown = newKinds.every(Boolean);
        const newCodeVersions = allKnown ? newKinds.filter((k) => k === 'code' || k === 'deps').length : null;
        const since = review.lastReviewedAt;
        const newComments = since
            ? activity.filter((e) => e.comment && e.comment.user?.uuid !== meUuid && !e.comment.deleted
                && e.comment.created_on > since).length
            : 0;

        let group: HomeGroupKey;
        if (isMine) {
            group = 'mine';
        } else if (lastReviewed !== null && newVersions === 0) {
            group = 'up-to-date';
        } else if (lastReviewed !== null && newCodeVersions === 0) {
            group = 'rebase-only';
        } else {
            group = 'to-review';
        }

        return {
            group,
            data: {
                ...base,
                versionsCount: versions.length,
                lastPushAt: versions[versions.length - 1]?.pushedAt ?? base.lastPushAt,
                lastReviewed,
                newVersions,
                newCodeVersions,
                newComments,
            },
        };
    }
}
