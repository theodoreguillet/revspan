// Bitbucket Cloud REST client (API 2.0): Basic auth with e-mail + Atlassian API token, pagination,
// concurrency limit, retries (429/5xx for reads, 429 only for writes), disk cache of immutable data.
import { createHash } from 'node:crypto';
import type { BuildCheck, NewComment, User } from '../../shared/api.ts';
import { AppError, badRequest } from '../errors.ts';
import type { Cache } from '../infra/cache.ts';
import { toBuildChecks } from '../core/build.ts';
import type { CompareSource, DiffstatEntry, FileContent } from '../core/compare.ts';
import { userOf } from '../core/model.ts';
import type {
    BbActivity, BbBranch, BbComment, BbCommit, BbDiffstatEntry, BbPage, BbParticipant, BbPullRequest, BbSrcMeta, BbStatus, BbUser,
} from './types.ts';

export const DEFAULT_BASE_URL = 'https://api.bitbucket.org/2.0';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const LIVE_TTL_MS = 15000;
const BUILD_TTL_MS = 60000;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 3;

export interface BitbucketAuth {
    email: string;
    token: string;
}

/** How much of a repository's open PR list is read: `pages` pages of `pagelen` PRs (Bitbucket's maximum is 50). */
export interface PrListLimit {
    pagelen: number;
    pages: number;
}

/** 200 open PRs per repository. */
const DEFAULT_PR_LIST_LIMIT: PrListLimit = { pagelen: 50, pages: 4 };

export interface CommitSummary {
    hash: string;
    message: string;
    date: string | null;
    parents: string[];
}

type Query = Record<string, string | number | undefined>;

interface RequestOptions {
    query?: Query;
    body?: unknown;
    allow404?: boolean;
}

function errorFor(status: number, path: string, detail: string): AppError {
    const details = detail ? { detail } : {};
    switch (status) {
        case 401:
            return new AppError(401, 'BB_UNAUTHORIZED', 'Bitbucket rejected the token (invalid or expired). Renew it in the settings.');
        case 403:
            return new AppError(403, 'BB_FORBIDDEN', detail ? `Missing Bitbucket permission for this action: ${detail}` : 'Missing Bitbucket permission for this action.', details);
        case 404:
            return new AppError(404, 'BB_NOT_FOUND', `Not found on Bitbucket: ${path}`, { path });
        default:
            return new AppError(502, 'BB_ERROR', `Bitbucket error ${status} on ${path}${detail ? `: ${detail}` : ''}`, { status, path, ...details });
    }
}

class Semaphore {
    private active = 0;
    private readonly queue: (() => void)[] = [];
    private readonly max: number;

    constructor(max: number) {
        this.max = max;
    }

    async run<T>(task: () => Promise<T>): Promise<T> {
        if (this.active >= this.max) {
            await new Promise<void>((resolve) => this.queue.push(resolve));
        }
        this.active++;
        try {
            return await task();
        } finally {
            this.active--;
            this.queue.shift()?.();
        }
    }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const sha1 = (data: string | Buffer): string => createHash('sha1').update(data).digest('hex');

/** Abbreviation of a head hash in build keys: the PR list gives 12 characters, the activity sometimes the full hash. */
const HEAD_PREFIX = 12;
/**
 * Grace period after a push: until then a CI may still post its first status on the head, so even settled checks (or no
 * check at all) are read again once per interval. Past it, settled checks are final for that head, and no status at all
 * means no CI.
 */
const CHECKS_GRACE_MS = 3600_000;
/** A check whose state can no longer change on that commit. */
const SETTLED_STATES: ReadonlySet<BuildCheck['state']> = new Set(['success', 'failed', 'stopped']);

const commitKey = (ws: string, repo: string, hash: string): string => `commit:${ws}/${repo}:${hash}`;
const mergeBaseKey = (ws: string, repo: string, a: string, b: string): string => `merge-base:${ws}/${repo}:${a}..${b}`;

/** Encodes a file path; rejects empty segments, `.` and `..` (new URL() would normalize them out of the repo). */
function encodePath(filePath: string): string {
    const segments = filePath.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        throw badRequest(`Invalid file path: ${filePath}`);
    }
    return segments.map(encodeURIComponent).join('/');
}

export class BitbucketClient {
    private readonly baseUrl: string;
    private readonly auth: BitbucketAuth;
    private readonly cache: Cache;
    private readonly fetchImpl: typeof fetch;
    private readonly limiter: Semaphore;
    private readonly prListLimit: PrListLimit;

    /** prListLimit: lowered by the tests to cut a short list. */
    constructor({ baseUrl = DEFAULT_BASE_URL, auth, cache, concurrency = 6, fetchImpl = fetch, prListLimit = DEFAULT_PR_LIST_LIMIT }: {
        baseUrl?: string;
        auth: BitbucketAuth;
        cache: Cache;
        concurrency?: number;
        fetchImpl?: typeof fetch;
        prListLimit?: PrListLimit;
    }) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.auth = auth;
        this.cache = cache;
        this.fetchImpl = fetchImpl;
        this.limiter = new Semaphore(concurrency);
        this.prListLimit = prListLimit;
    }

    private url(path: string, query?: Query): string {
        const url = new URL(path.startsWith('http') ? path : `${this.baseUrl}/${path.replace(/^\/+/, '')}`);
        for (const [key, value] of Object.entries(query ?? {})) {
            if (value !== undefined) {
                url.searchParams.set(key, String(value));
            }
        }
        return url.toString();
    }

    /** Raw request: HTTP response (null if a 404 is allowed). Errors are translated into AppError. */
    private async send(method: string, path: string, { query, body, allow404 = false }: RequestOptions, accept: string): Promise<Response | null> {
        const url = this.url(path, query);
        const headers: Record<string, string> = {
            Authorization: `Basic ${Buffer.from(`${this.auth.email}:${this.auth.token}`).toString('base64')}`,
            Accept: accept,
        };
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
        }
        // A write is retried only on 429 (request not processed): after a 5xx, a network error or a timeout,
        // Bitbucket may have executed it, and resending it would create a duplicate.
        const idempotent = method === 'GET';
        return this.limiter.run(async () => {
            for (let attempt = 0; ; attempt++) {
                let response: Response;
                try {
                    response = await this.fetchFollowingRedirects(url, {
                        method,
                        headers,
                        body: body === undefined ? undefined : JSON.stringify(body),
                    });
                } catch (error) {
                    if (error instanceof AppError) {
                        throw error;
                    }
                    if (idempotent && attempt < 2) {
                        await sleep(500 * (attempt + 1));
                        continue;
                    }
                    throw new AppError(502, 'BB_UNREACHABLE', `Bitbucket unreachable (${(error as Error).message})`, { detail: (error as Error).message });
                }
                const retryable = response.status === 429 || (idempotent && response.status >= 500);
                if (retryable && attempt < 3) {
                    const retryAfter = Number(response.headers.get('retry-after'));
                    await sleep(retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 1000 * 2 ** attempt);
                    continue;
                }
                if (response.status === 404 && allow404) {
                    return null;
                }
                if (!response.ok) {
                    const detail = await response.json()
                        .then((data) => (data as { error?: { message?: string } }).error?.message ?? '', () => '');
                    throw errorFor(response.status, path.replace(/\?.*$/, ''), detail);
                }
                return response;
            }
        });
    }

    /**
     * Follows at most MAX_REDIRECTS redirects (GET only). The Authorization header is sent only to the origin
     * of the configured API, never to another domain (file storage, CDN).
     */
    private async fetchFollowingRedirects(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<Response> {
        const apiOrigin = new URL(this.baseUrl).origin;
        let current = url;
        for (let hops = 0; ; hops++) {
            const headers = { ...init.headers };
            if (new URL(current).origin !== apiOrigin) {
                delete headers.Authorization;
            }
            const response = await this.fetchImpl(current, {
                ...init,
                headers,
                redirect: 'manual',
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            const location = response.headers.get('location');
            if (response.status < 300 || response.status >= 400 || !location) {
                return response;
            }
            if (init.method !== 'GET' || hops >= MAX_REDIRECTS) {
                throw new AppError(502, 'BB_ERROR', `Bitbucket redirect refused on ${new URL(url).pathname}`);
            }
            current = new URL(location, current).toString();
        }
    }

    private async json<T>(method: string, path: string, options: RequestOptions = {}): Promise<T | null> {
        const response = await this.send(method, path, options, 'application/json');
        if (!response || response.status === 204) {
            return null;
        }
        const text = await response.text();
        if (!text) {
            return null;
        }
        try {
            return JSON.parse(text) as T;
        } catch {
            throw errorFor(502, path.replace(/\?.*$/, ''), 'non-JSON response');
        }
    }

    private async getJson<T>(path: string, query?: Query): Promise<T> {
        const value = await this.json<T>('GET', path, query ? { query } : {});
        if (value === null) {
            throw errorFor(502, path, 'empty response');
        }
        return value;
    }

    private async getAllPages<T>(path: string, query: Query = {}, maxPages = 40): Promise<T[]> {
        return (await this.getPages<T>(path, query, maxPages)).values;
    }

    /** Values of at most maxPages pages; truncated: a next page was still announced at the cap. */
    private async getPages<T>(path: string, query: Query, maxPages: number): Promise<{ values: T[]; truncated: boolean }> {
        const values: T[] = [];
        let page = await this.getJson<BbPage<T>>(path, query);
        for (let i = 1; ; i++) {
            for (const value of page.values ?? []) {
                values.push(value);
            }
            if (!page.next || i >= maxPages) {
                return { values, truncated: Boolean(page.next) };
            }
            // The token never follows a pagination URL outside the configured API.
            if (!page.next.startsWith(`${this.baseUrl}/`)) {
                throw new AppError(502, 'BB_ERROR', `Unexpected Bitbucket pagination: ${new URL(page.next).origin}`);
            }
            page = await this.getJson<BbPage<T>>(page.next);
        }
    }

    private repoPath(ws: string, repo: string): string {
        return `repositories/${encodeURIComponent(ws)}/${encodeURIComponent(repo)}`;
    }

    private prPath(ws: string, repo: string, id: number): string {
        return `${this.repoPath(ws, repo)}/pullrequests/${id}`;
    }

    // ---------- Live data (short in-memory cache) ----------

    async me(): Promise<User | null> {
        return userOf(await this.getJson<BbUser>('user'));
    }

    pullRequest(ws: string, repo: string, id: number): Promise<BbPullRequest> {
        return this.cache.getLive(`live:${ws}/${repo}#${id}:pr`, LIVE_TTL_MS, () => this.getJson<BbPullRequest>(this.prPath(ws, repo, id)));
    }

    /** maxAgeMs: age of a cached answer still served (0: always asked again, concurrent reads shared). */
    activity(ws: string, repo: string, id: number, maxAgeMs = LIVE_TTL_MS): Promise<BbActivity[]> {
        return this.cache.getLive(`live:${ws}/${repo}#${id}:activity`, maxAgeMs,
            () => this.getAllPages<BbActivity>(`${this.prPath(ws, repo, id)}/activity`, { pagelen: 50 }, 400));
    }

    comments(ws: string, repo: string, id: number): Promise<BbComment[]> {
        return this.cache.getLive(`live:${ws}/${repo}#${id}:comments`, LIVE_TTL_MS,
            () => this.getAllPages<BbComment>(`${this.prPath(ws, repo, id)}/comments`, { pagelen: 100 }));
    }

    /**
     * Build checks of the PR's head commit. Once the head was pushed (pushedAt) more than an hour ago and every check is
     * settled (success, failed or stopped), or there is none at all, they are kept on disk for that head and never asked
     * again. Before that (another CI may not have posted yet), with an unknown push date, or while a check runs, they are
     * asked again once older than maxAgeMs.
     * recheck: asks even kept checks (the PR page and the explicit Refresh, where a re-run shows) and updates what is
     * kept for that head.
     */
    async headChecks(ws: string, repo: string, id: number, head: string, { maxAgeMs = BUILD_TTL_MS, recheck = false, pushedAt = '' }: {
        maxAgeMs?: number;
        recheck?: boolean;
        pushedAt?: string;
    } = {}): Promise<BuildCheck[]> {
        const short = head.slice(0, HEAD_PREFIX);
        const settledKey = `build:${ws}/${repo}#${id}:${short}`;
        const settled = recheck ? undefined : this.cache.get<BuildCheck[]>(settledKey);
        if (settled) {
            return settled;
        }
        // The head commit's own statuses (one request, where the PR route pages through every commit of the PR); the key
        // holds the head, so a new push is always read.
        const statuses = await this.cache.getLive(`live:statuses:${ws}/${repo}#${id}:${short}`, maxAgeMs,
            () => this.getAllPages<BbStatus>(`${this.repoPath(ws, repo)}/commit/${encodeURIComponent(head)}/statuses`, { pagelen: 50 }));
        const checks = toBuildChecks(statuses, short);
        const pushedMs = Date.parse(pushedAt);
        const pastGrace = !Number.isNaN(pushedMs) && Date.now() - pushedMs > CHECKS_GRACE_MS;
        // No check at all past the grace period: no CI for that head.
        if (pastGrace && checks.every((check) => SETTLED_STATES.has(check.state))) {
            this.cache.set(settledKey, checks);
        } else if (recheck) {
            // A re-run started on a head whose checks were kept: the home reads them again.
            this.cache.delete(settledKey);
        }
        return checks;
    }

    /** Head commit of a branch, or null if the branch no longer exists. */
    branchHead(ws: string, repo: string, branch: string, maxAgeMs = BUILD_TTL_MS): Promise<string | null> {
        return this.cache.getLive(`live:branch:${ws}/${repo}:${branch}`, maxAgeMs, async () => {
            const raw = await this.json<BbBranch>('GET', `${this.repoPath(ws, repo)}/refs/branches/${encodePath(branch)}`, { allow404: true });
            return raw?.target?.hash ?? null;
        });
    }

    /** Open PRs, up to the list limit (200); truncated: the repository has more, left out. */
    async openPullRequests(ws: string, repo: string): Promise<{ prs: BbPullRequest[]; truncated: boolean }> {
        const { values, truncated } = await this.getPages<BbPullRequest>(`${this.repoPath(ws, repo)}/pullrequests`, {
            state: 'OPEN',
            pagelen: this.prListLimit.pagelen,
            fields: '+values.participants,+values.reviewers',
        }, this.prListLimit.pages);
        return { prs: values, truncated };
    }

    /** Forgets the unsettled build checks and the branch heads read for a repository (explicit refresh). */
    forgetLiveHealth(ws: string, repo: string): void {
        this.cache.invalidateLive(`live:statuses:${ws}/${repo}#`);
        this.cache.invalidateLive(`live:branch:${ws}/${repo}:`);
    }

    invalidatePr(ws: string, repo: string, id: number): void {
        this.cache.invalidateLive(`live:${ws}/${repo}#${id}:`);
    }

    // ---------- Immutable data (disk cache) ----------

    /**
     * Commit, or null if it no longer exists: Bitbucket eventually erases commits overwritten by a force-push
     * (old versions of a PR). Absence is not cached.
     */
    commit(ws: string, repo: string, hash: string): Promise<CommitSummary | null> {
        return this.cache.getOrCompute(commitKey(ws, repo, hash), () => this.fetchCommit(ws, repo, hash), (commit) => commit !== null);
    }

    /**
     * Does the commit still exist? Asked to Bitbucket even if cached (answer kept LIVE_TTL_MS): a cached
     * commit may have been erased since.
     */
    commitExists(ws: string, repo: string, hash: string): Promise<boolean> {
        return this.cache.getLive(`live:commit:${ws}/${repo}:${hash}`, LIVE_TTL_MS, async () => (await this.fetchCommit(ws, repo, hash)) !== null);
    }

    private async fetchCommit(ws: string, repo: string, hash: string): Promise<CommitSummary | null> {
        const raw = await this.json<BbCommit>('GET', `${this.repoPath(ws, repo)}/commit/${hash}`, { allow404: true });
        return raw ? { hash: raw.hash, message: raw.message ?? '', date: raw.date ?? null, parents: (raw.parents ?? []).map((p) => p.hash) } : null;
    }

    /** Forgets a commit erased by Bitbucket since it was cached (hash as passed to commit()). */
    forgetCommit(ws: string, repo: string, hash: string): void {
        this.cache.delete(commitKey(ws, repo, hash));
    }

    /** Forgets a cached merge-base (that of an erased version). */
    forgetMergeBase(ws: string, repo: string, a: string, b: string): void {
        this.cache.delete(mergeBaseKey(ws, repo, a, b));
    }

    mergeBase(ws: string, repo: string, a: string, b: string): Promise<string | null> {
        return this.cache.getOrCompute(mergeBaseKey(ws, repo, a, b), async () => {
            const raw = await this.json<BbCommit>('GET', `${this.repoPath(ws, repo)}/merge-base/${a}..${b}`, { allow404: true });
            return raw?.hash ?? null;
        }, (hash) => hash !== null);
    }

    /** Files that differ between two commits (two-dot diff: oldHash -> newHash). */
    diffstat(ws: string, repo: string, newHash: string, oldHash: string): Promise<DiffstatEntry[]> {
        return this.cache.getOrCompute(`diffstat:${ws}/${repo}:${newHash}..${oldHash}`, async () => {
            const values = await this.getAllPages<BbDiffstatEntry>(`${this.repoPath(ws, repo)}/diffstat/${newHash}..${oldHash}`,
                { topic: 'false', pagelen: 500 }, 20);
            return values.map((v) => ({
                status: v.status,
                oldPath: v.old?.path ?? null,
                newPath: v.new?.path ?? null,
                added: v.lines_added ?? 0,
                removed: v.lines_removed ?? 0,
            }));
        });
    }

    /** Content of a file at a commit (a 404 is not cached: it may be transient). */
    fileContent(ws: string, repo: string, hash: string, filePath: string): Promise<FileContent> {
        let srcPath: string;
        try {
            srcPath = `${this.repoPath(ws, repo)}/src/${hash}/${encodePath(filePath)}`;
        } catch (error) {
            return Promise.reject(error);
        }
        return this.cache.getOrCompute<FileContent>(`src2:${ws}/${repo}:${hash}:${filePath}`, async () => {
            const response = await this.send('GET', srcPath, { allow404: true }, '*/*');
            if (!response) {
                return { missing: true };
            }
            // Content not downloaded: no fingerprint (the /src ETag is not guaranteed to depend only on content), never judged equal.
            if (Number(response.headers.get('content-length')) > MAX_FILE_BYTES) {
                return { tooLarge: true };
            }
            // Binary or too large: keep the bytes' fingerprint to recognize the same file from one version to the next.
            const buffer = Buffer.from(await response.arrayBuffer());
            if (buffer.length > MAX_FILE_BYTES) {
                return { tooLarge: true, fingerprint: sha1(buffer) };
            }
            if (buffer.subarray(0, 8000).includes(0)) {
                return { binary: true, fingerprint: sha1(buffer) };
            }
            const text = buffer.toString('utf8');
            // A submodule returns the hash of the pointed commit (40 characters): present it as git does.
            if (/^[0-9a-f]{40}$/.test(text)) {
                const meta = await this.json<BbSrcMeta>('GET', srcPath, { query: { format: 'meta' }, allow404: true });
                if (meta?.attributes?.includes('subrepository')) {
                    return { text: `Subproject commit ${text}\n`, submodule: true };
                }
            }
            // A folder returns a paginated JSON listing instead of content.
            if ((response.headers.get('content-type') ?? '').includes('application/json') && !filePath.endsWith('.json') && isListing(text)) {
                return { special: true };
            }
            return { text };
        }, (content) => !('missing' in content));
    }

    /** Comparison source (core/compare.ts) backed by this client. */
    source(ws: string, repo: string): CompareSource {
        return {
            diffstat: (newHash, oldHash) => this.diffstat(ws, repo, newHash, oldHash),
            content: (hash, path) => this.fileContent(ws, repo, hash, path),
        };
    }

    // ---------- Writes ----------

    async createComment(ws: string, repo: string, id: number, { raw, parentId, inline }: NewComment): Promise<BbComment> {
        const body: Record<string, unknown> = { content: { raw } };
        if (parentId) {
            body.parent = { id: parentId };
        }
        if (inline) {
            body.inline = { path: inline.path, to: inline.to };
        }
        const created = await this.json<BbComment>('POST', `${this.prPath(ws, repo, id)}/comments`, { body });
        if (!created) {
            throw errorFor(502, 'comments', 'empty response');
        }
        return created;
    }

    async deleteComment(ws: string, repo: string, id: number, commentId: number): Promise<void> {
        await this.json('DELETE', `${this.prPath(ws, repo, id)}/comments/${commentId}`);
    }

    async resolveComment(ws: string, repo: string, id: number, commentId: number, resolved: boolean): Promise<void> {
        await this.json(resolved ? 'POST' : 'DELETE', `${this.prPath(ws, repo, id)}/comments/${commentId}/resolve`);
    }

    async approve(ws: string, repo: string, id: number, on: boolean): Promise<BbParticipant | null> {
        return this.json<BbParticipant>(on ? 'POST' : 'DELETE', `${this.prPath(ws, repo, id)}/approve`);
    }

    async requestChanges(ws: string, repo: string, id: number, on: boolean): Promise<void> {
        await this.json(on ? 'POST' : 'DELETE', `${this.prPath(ws, repo, id)}/request-changes`);
    }
}

function isListing(text: string): boolean {
    try {
        const parsed = JSON.parse(text) as { values?: unknown; pagelen?: unknown };
        return Array.isArray(parsed.values) && parsed.pagelen !== undefined;
    } catch {
        return false;
    }
}
