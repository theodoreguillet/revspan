// "My PRs" home: open PRs of the configured repositories, grouped by the review queue (core/review-queue.ts).
import type { Home, HomeGroup, HomeGroupKey, PrCard, PrRef, User } from '../../shared/api.ts';
import { approvalHoldsSince } from '../../shared/approval.ts';
import { requiredApprovalsFor, type ReviewSettings } from '../../shared/review-settings.ts';
import type { BitbucketClient } from '../bitbucket/client.ts';
import type { BbPullRequest } from '../bitbucket/types.ts';
import { summarizeBuild } from '../core/build.ts';
import { buildParticipants, computeReview, extractUpdates, prUrl, userOf } from '../core/model.ts';
import { classifyPr, needsReview, type QueueInput } from '../core/review-queue.ts';
import type { Cache } from '../infra/cache.ts';
import { prKeyOf, type Store } from '../infra/config.ts';
import { errorPayload } from '../errors.ts';
import { loadBuildChecks, loadNeedsRebase } from './pr-health.ts';
import type { BitbucketSession } from './session.ts';

const HOME_TTL_MS = 60000;

/** Group order of the home page and the VS Code tree (each translates the key into its title). */
const GROUP_ORDER: readonly HomeGroupKey[] = ['to-do', 'mine', 'waiting', 'others'];

interface Card {
    group: HomeGroupKey;
    data: PrCard;
    /** Source head and destination branch, to read the build and the rebase state. */
    head: string;
    destBranch: string;
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

    /** fresh: ignores the short cache (refresh requested). */
    async get({ fresh = false }: { fresh?: boolean } = {}): Promise<Home> {
        if (fresh) {
            this.cache.invalidateLive('live:home:');
            for (const fullName of this.store.config.repos) {
                this.cache.invalidateLive(`live:${fullName}#`);
                this.cache.invalidateLive(`live:${fullName}:branch:`);
            }
        }
        const client = await this.session.getClient();
        const me = await this.session.me();
        const { repos, review } = this.store.config;
        // The settings are part of the key: a change of minimum or of followed contributors shows at once.
        return this.cache.getLive(`live:home:${repos.join(',')}:${JSON.stringify(review)}`, HOME_TTL_MS, () => this.compute(client, me, repos, review));
    }

    private async compute(client: BitbucketClient, me: User | null, repos: readonly string[], review: ReviewSettings): Promise<Home> {
        const errors: Home['errors'] = [];
        const cards: Card[] = [];
        await Promise.all(repos.map(async (fullName) => {
            const [workspace = '', repo = ''] = fullName.split('/');
            try {
                const list = await client.openPullRequests(workspace, repo);
                cards.push(...await Promise.all(list.map((raw) => this.card(client, me, { workspace, repo, id: raw.id }, raw, review))));
            } catch (error) {
                errors.push({ repo: fullName, ...errorPayload(error) });
            }
        }));

        await Promise.all(cards.map((card) => this.withHealth(client, card)));

        const groups: HomeGroup[] = GROUP_ORDER.map((key) => ({
            key,
            prs: cards.filter((c) => c.group === key).map((c) => c.data).sort((a, b) => b.lastPushAt.localeCompare(a.lastPushAt)),
        }));
        errors.sort((a, b) => a.repo.localeCompare(b.repo));
        return { me, repos: [...repos], groups, errors };
    }

    /** Build state for "to-do" and "mine" cards, needs-rebase for "mine" only. Failures leave null. */
    private async withHealth(client: BitbucketClient, card: Card): Promise<void> {
        if (card.group !== 'to-do' && card.group !== 'mine') {
            return;
        }
        const [checks, needsRebase] = await Promise.all([
            loadBuildChecks(client, card.data, card.head),
            card.group === 'mine' ? loadNeedsRebase(client, card.data, card.head, card.destBranch) : null,
        ]);
        card.data.build = checks ? summarizeBuild(checks) : null;
        card.data.needsRebase = needsRebase;
    }

    private async card(client: BitbucketClient, me: User | null, ref: PrRef, raw: BbPullRequest, settings: ReviewSettings): Promise<Card> {
        const meUuid = me?.uuid ?? null;
        const isMe = (uuid: string | undefined): boolean => meUuid !== null && uuid === meUuid;
        const participants = raw.participants ?? [];
        const isMine = isMe(raw.author?.uuid);
        const designatedReviewer = (raw.reviewers ?? []).some((r) => isMe(r.uuid));
        const involved = designatedReviewer || participants.some((p) => isMe(p.user?.uuid));
        const local = this.store.prState(prKeyOf(ref));
        const approvals = participants.filter((p) => p.approved && p.user?.uuid !== raw.author?.uuid).length;
        const requiredApprovals = requiredApprovalsFor(settings, `${ref.workspace}/${ref.repo}`);
        const head = raw.source?.commit?.hash ?? '';
        const destBranch = raw.destination?.branch?.name ?? '';
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
            approvals,
            requiredApprovals,
            myApproval: participants.some((p) => p.approved && isMe(p.user?.uuid)),
            newComments: 0,
            needsReview: needsReview(approvals, requiredApprovals),
            designatedReviewer,
            followed: settings.followed.some((u) => u.uuid === raw.author?.uuid),
            approvalHolds: false,
            build: null,
            needsRebase: null,
            head: head.slice(0, 12),
        };
        const queue: QueueInput = {
            isMine,
            meKnown: meUuid !== null,
            needsReview: base.needsReview,
            designatedReviewer,
            myApprovalCurrent: false,
            approvalHolds: false,
            reviewedOrApproved: false,
            newCodeVersions: null,
        };
        // PR that does not concern me (not author, designated reviewer or participant, never marked reviewed), or me
        // unknown: light card without the history, so the home page stays fast with many repositories.
        if (meUuid === null || (!isMine && !involved && !local.reviewedHash)) {
            return { group: classifyPr(queue), data: base, head, destBranch };
        }

        const activity = await client.activity(ref.workspace, ref.repo, ref.id);
        const versions = extractUpdates(activity, raw).map((u, i) => ({ index: i + 1, hash: u.hash, pushedAt: u.date }));
        // The activity comments are enough here (no need to load all the comments).
        const myComments = activity.flatMap((e) => (e.comment && e.comment.user?.uuid === meUuid ? [e.comment] : []));
        const review = computeReview({ versions, activity, comments: myComments, meUuid, local });
        const lastReviewed = review.lastReviewed;
        const newVersions = versions.length - (lastReviewed ?? 0);

        const newKinds = versions.slice(lastReviewed ?? 0).map((v) => local.kinds[v.hash.slice(0, 12)]);
        const allKnown = newKinds.every(Boolean);
        const newCodeVersions = allKnown ? newKinds.filter((k) => k === 'code' || k === 'deps').length : null;
        const myApprovedVersion = base.myApproval
            ? buildParticipants(raw, activity, versions).find((p) => p.user?.uuid === meUuid)?.approvedVersion ?? null
            : null;
        const approvalHolds = base.myApproval
            && approvalHoldsSince(myApprovedVersion, versions.map((v) => local.kinds[v.hash.slice(0, 12)]));
        const since = review.lastReviewedAt;
        const newComments = since
            ? activity.filter((e) => e.comment && e.comment.user?.uuid !== meUuid && !e.comment.deleted
                && e.comment.created_on > since).length
            : 0;

        const group = classifyPr({
            ...queue,
            myApprovalCurrent: base.myApproval && myApprovedVersion === versions.length,
            approvalHolds,
            reviewedOrApproved: lastReviewed !== null || base.myApproval,
            newCodeVersions,
        });
        return {
            group,
            head,
            destBranch,
            data: {
                ...base,
                versionsCount: versions.length,
                lastPushAt: versions[versions.length - 1]?.pushedAt ?? base.lastPushAt,
                lastReviewed,
                newVersions,
                newCodeVersions,
                newComments,
                approvalHolds,
            },
        };
    }
}
