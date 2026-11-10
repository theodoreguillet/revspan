// "My PRs" home: open PRs of the configured repositories, grouped by the review queue (core/review-queue.ts).
//
// Request budget (the background poll runs every review.refreshMinutes in every VS Code window):
// - a home computed by any window of the profile is shared on disk and reused for half an interval;
// - only the PR lists are always read; a PR's activity is kept on disk while its head, last update, comment count and
//   approvals are unchanged; settled build checks are kept per head; unsettled checks and branch heads are read at most
//   once per interval; merge bases are immutable.
import type { Home, HomeGroup, HomeGroupKey, PrCard, PrRef, User } from '../../shared/api.ts';
import { approvalHoldsSince } from '../../shared/approval.ts';
import { requiredApprovalsFor, type ReviewSettings } from '../../shared/review-settings.ts';
import type { BitbucketClient } from '../bitbucket/client.ts';
import type { BbActivity, BbPullRequest } from '../bitbucket/types.ts';
import { summarizeBuild } from '../core/build.ts';
import { buildParticipants, computeReview, extractUpdates, prUrl, userOf } from '../core/model.ts';
import { classifyPr, needsReview, type QueueInput } from '../core/review-queue.ts';
import type { Cache } from '../infra/cache.ts';
import { prKeyOf, type Store } from '../infra/config.ts';
import { errorPayload } from '../errors.ts';
import { loadBuildChecks, loadNeedsRebase, type BranchHeadReader } from './pr-health.ts';
import type { BitbucketSession } from './session.ts';

const MINUTE_MS = 60_000;
/** Timer drift between two polls: live data read by one poll is always stale for the next one. */
const POLL_JITTER_MS = 15_000;
/** A window computing the home for the others: taken over past this age (closed mid-computation). */
const LEASE_MS = 60_000;
/** Pause between two looks at the home another window is computing. */
const WAIT_STEP_MS = 100;
/** To increment if the activity kept for the home changes shape (invalidates the disk cache). */
const ACTIVITY_FORMAT = 2;
/** To increment if the shared home changes shape (a window running an older version then ignores it). */
const HOME_FORMAT = 1;

/** Group order of the home page and the VS Code tree (each translates the key into its title). */
const GROUP_ORDER: readonly HomeGroupKey[] = ['to-do', 'mine', 'waiting', 'others'];

interface Card {
    group: HomeGroupKey;
    data: PrCard;
    /** Source head and destination branch, to read the build and the rebase state. */
    head: string;
    destBranch: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Age past which unsettled build checks and branch heads are read again: once per poll. */
const recheckAgeMs = (refreshMinutes: number): number => Math.max(refreshMinutes * MINUTE_MS - POLL_JITTER_MS, MINUTE_MS / 2);

/**
 * What the home depends on besides Bitbucket (account, repositories, approval rule, followed contributors, local marks):
 * a change shows at once instead of waiting for the shared home to expire.
 */
function homeKey(email: string, repos: readonly string[], review: ReviewSettings, local: string, generation: number): string {
    return JSON.stringify({
        format: HOME_FORMAT,
        // Bumped by every write on a PR: a read after a write never joins a computation started before it.
        generation,
        email,
        repos,
        approvals: review.requiredApprovals,
        approvalsByRepo: review.requiredApprovalsByRepo,
        followed: review.followed.map((u) => u.uuid),
        local,
    });
}

/** What the home reads in an activity (pushes, approvals, comment authors and dates), without the texts. */
function trimActivity(activity: readonly BbActivity[]): BbActivity[] {
    const user = (raw: { uuid?: string } | undefined): { uuid?: string } | undefined => (raw ? { uuid: raw.uuid } : undefined);
    return activity.flatMap((entry): BbActivity[] => {
        if (entry.update) {
            const { date, source, destination } = entry.update;
            return [{ update: { date, source, destination } }];
        }
        if (entry.approval) {
            return [{ approval: { date: entry.approval.date, user: user(entry.approval.user) } }];
        }
        if (entry.changes_requested) {
            return [{ changes_requested: { date: entry.changes_requested.date, user: user(entry.changes_requested.user) } }];
        }
        if (entry.comment) {
            const { id, created_on: createdOn, deleted, parent } = entry.comment;
            return [{ comment: { id, created_on: createdOn, deleted, parent, user: user(entry.comment.user) } }];
        }
        return [];
    });
}

const sameCommit = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

/**
 * Whether an activity is at least as recent as the list that led to reading it: its last push is the list's head, every
 * approval or change request of the list has its event, and it has all the comments the list counts. A read lagging behind
 * (replica) is used once, never kept.
 */
function consistentWithList(activity: readonly BbActivity[], raw: BbPullRequest): boolean {
    const pushes = activity.flatMap((e) => (e.update?.source?.commit?.hash ? [{ date: e.update.date, hash: e.update.source.commit.hash }] : []));
    const last = pushes.reduce<{ date: string; hash: string } | null>((latest, push) => (!latest || push.date >= latest.date ? push : latest), null);
    const head = raw.source?.commit?.hash ?? '';
    if (last && head && !sameCommit(last.hash, head)) {
        return false;
    }
    const hasEvent = (kind: 'approval' | 'changes_requested', uuid: string | undefined): boolean => activity.some((e) => e[kind]?.user?.uuid === uuid);
    for (const participant of raw.participants ?? []) {
        const uuid = participant.user?.uuid;
        if ((participant.approved && !hasEvent('approval', uuid)) || (participant.state === 'changes_requested' && !hasEvent('changes_requested', uuid))) {
            return false;
        }
    }
    const comments = activity.filter((e) => e.comment && !e.comment.deleted).length;
    return comments >= (raw.comment_count ?? 0);
}

export class HomeService {
    private readonly session: BitbucketSession;
    private readonly store: Store;
    private readonly cache: Cache;
    /** Computations in progress in this window, per home key (the tree and the poll share one). */
    private readonly pending = new Map<string, Promise<Home>>();

    constructor({ session, store, cache }: { session: BitbucketSession; store: Store; cache: Cache }) {
        this.session = session;
        this.store = store;
        this.cache = cache;
    }

    /**
     * fresh: the explicit Refresh. Reads the lists, unsettled build checks and branch heads again, and ignores the home
     * shared by the windows; what is kept per head (activity, settled checks, merge bases) stays.
     */
    async get({ fresh = false }: { fresh?: boolean } = {}): Promise<Home> {
        // No network here: the token is read, the profile is only fetched by a computation.
        const client = await this.session.getClient();
        const { email, repos, review } = this.store.config;
        const generation = this.store.homeGeneration();
        const key = homeKey(email, repos, review, this.store.localSignature(), generation);
        const compute = (): Promise<Home> => this.compute(client, key, generation, repos, review, fresh);
        if (fresh) {
            return compute();
        }
        let pending = this.pending.get(key);
        if (!pending) {
            pending = this.sharedOrComputed(key, review.refreshMinutes * MINUTE_MS / 2, compute).finally(() => this.pending.delete(key));
            this.pending.set(key, pending);
        }
        return pending;
    }

    /** The home another window computed less than reuseMs ago for the same key, if any. */
    private shared(key: string, reuseMs: number): Home | null {
        const snapshot = this.store.homeSnapshot();
        const age = snapshot ? Date.now() - snapshot.at : -1;
        return snapshot && snapshot.key === key && age >= 0 && age < reuseMs ? snapshot.home : null;
    }

    /**
     * The shared home when recent enough; otherwise this window takes the lease and computes it for every window. While
     * another window holds the lease, waits for its home (or takes over once the lease is stale).
     */
    private async sharedOrComputed(key: string, reuseMs: number, compute: () => Promise<Home>): Promise<Home> {
        for (let waited = 0; ; waited += WAIT_STEP_MS) {
            const shared = this.shared(key, reuseMs);
            if (shared) {
                return shared;
            }
            const release = this.store.claimHomeLease(LEASE_MS);
            if (release) {
                try {
                    // Another window may have finished between the look above and the claim.
                    return this.shared(key, reuseMs) ?? await compute();
                } finally {
                    release();
                }
            }
            if (waited >= LEASE_MS) {
                return compute();
            }
            await sleep(WAIT_STEP_MS);
        }
    }

    private async compute(client: BitbucketClient, key: string, generation: number, repos: readonly string[], review: ReviewSettings, fresh: boolean): Promise<Home> {
        const startedAt = Date.now();
        const me = await this.session.me();
        const recheckMs = recheckAgeMs(review.refreshMinutes);
        const errors: Home['errors'] = [];
        const cards: Card[] = [];
        await Promise.all(repos.map(async (fullName) => {
            const [workspace = '', repo = ''] = fullName.split('/');
            if (fresh) {
                client.forgetLiveHealth(workspace, repo);
            }
            let repoCards: Card[];
            try {
                const list = await client.openPullRequests(workspace, repo);
                repoCards = await Promise.all(list.map((raw) => this.card(client, me, { workspace, repo, id: raw.id }, raw, review)));
            } catch (error) {
                errors.push({ repo: fullName, ...errorPayload(error) });
                return;
            }
            // One read of each destination branch per repository and computation, shared by its PRs.
            const heads = new Map<string, Promise<string | null>>();
            const branchHead: BranchHeadReader = (branch) => {
                let head = heads.get(branch);
                if (!head) {
                    head = client.branchHead(workspace, repo, branch, recheckMs);
                    heads.set(branch, head);
                }
                return head;
            };
            await Promise.all(repoCards.map((card) => this.withHealth(client, card, recheckMs, branchHead)));
            cards.push(...repoCards);
        }));

        const groups: HomeGroup[] = GROUP_ORDER.map((group) => ({
            key: group,
            prs: cards.filter((c) => c.group === group).map((c) => c.data).sort((a, b) => b.lastPushAt.localeCompare(a.lastPushAt)),
        }));
        errors.sort((a, b) => a.repo.localeCompare(b.repo));
        const home: Home = { me, repos: [...repos], groups, errors };
        // An incomplete home (unreadable repository, unknown profile) is not shared: the other windows try for themselves.
        if (errors.length === 0 && me !== null) {
            this.store.saveHomeSnapshot({ at: startedAt, key, home }, generation);
        }
        return home;
    }

    /** Build state for "to-do" and "mine" cards, needs-rebase for "mine" only. Failures leave null. */
    private async withHealth(client: BitbucketClient, card: Card, recheckMs: number, branchHead: BranchHeadReader): Promise<void> {
        if (card.group !== 'to-do' && card.group !== 'mine') {
            return;
        }
        const [checks, needsRebase] = await Promise.all([
            // lastPushAt: the last push, or the PR's last update for a light card (never earlier than the push).
            loadBuildChecks(client, card.data, card.head, { maxAgeMs: recheckMs, pushedAt: card.data.lastPushAt }),
            card.group === 'mine' ? loadNeedsRebase(client, card.data, card.head, card.destBranch, branchHead) : null,
        ]);
        card.data.build = checks ? summarizeBuild(checks) : null;
        card.data.needsRebase = needsRebase;
    }

    /**
     * Activity of a PR as the home reads it, kept on disk (one entry per PR) while the PR's head, last update, comment
     * count and approvals (all from the list) are unchanged: a PR nobody touched costs no request. The comment count does
     * not rely on updated_on following every comment.
     */
    private async activityOf(client: BitbucketClient, ref: PrRef, raw: BbPullRequest): Promise<BbActivity[]> {
        // Always asked again when the key changed: a cached answer might predate the change and would be kept for good.
        const read = async (): Promise<BbActivity[]> => trimActivity(await client.activity(ref.workspace, ref.repo, ref.id, 0));
        const head = raw.source?.commit?.hash;
        if (!head || !raw.updated_on) {
            return read();
        }
        const approvals = (raw.participants ?? []).map((p) => `${p.user?.uuid ?? ''}:${p.approved ? 1 : 0}:${p.state ?? ''}`).sort().join(',');
        const key = `${head}:${raw.updated_on}:${raw.comment_count ?? ''}:${approvals}`;
        const entry = `home-activity:${ACTIVITY_FORMAT}:${prKeyOf(ref)}`;
        const kept = this.cache.get<{ key: string; activity: BbActivity[] }>(entry);
        if (kept?.key === key) {
            return kept.activity;
        }
        const activity = await read();
        if (consistentWithList(activity, raw)) {
            this.cache.set(entry, { key, activity });
        }
        return activity;
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

        const activity = await this.activityOf(client, ref, raw);
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
