// Client REST Bitbucket Cloud (API 2.0) : authentification Basic e-mail + jeton API Atlassian, pagination,
// limite de concurrence, reprises sur 429/5xx, cache disque des données immuables.
import type { NewComment, User } from '../../shared/api.ts';
import { AppError } from '../errors.ts';
import type { Cache } from '../infra/cache.ts';
import type { CompareSource, DiffstatEntry, FileContent } from '../core/compare.ts';
import { userOf } from '../core/model.ts';
import type {
    BbActivity, BbComment, BbCommit, BbDiffstatEntry, BbPage, BbParticipant, BbPullRequest, BbSrcMeta, BbUser,
} from './types.ts';

export const DEFAULT_BASE_URL = 'https://api.bitbucket.org/2.0';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const LIVE_TTL_MS = 15000;
const REQUEST_TIMEOUT_MS = 30000;

export interface BitbucketAuth {
    email: string;
    token: string;
}

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
    const suffix = detail ? ` : ${detail}` : '';
    switch (status) {
        case 401:
            return new AppError(401, 'BB_UNAUTHORIZED', 'Bitbucket refuse le jeton (invalide ou expiré). Renouvelle-le dans les réglages.');
        case 403:
            return new AppError(403, 'BB_FORBIDDEN', `Droit manquant sur Bitbucket pour cette action${suffix}.`);
        case 404:
            return new AppError(404, 'BB_NOT_FOUND', `Introuvable sur Bitbucket : ${path}`);
        default:
            return new AppError(502, 'BB_ERROR', `Erreur Bitbucket ${status} sur ${path}${suffix}`);
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
const encodePath = (filePath: string): string => filePath.split('/').map(encodeURIComponent).join('/');

export class BitbucketClient {
    private readonly baseUrl: string;
    private readonly auth: BitbucketAuth;
    private readonly cache: Cache;
    private readonly fetchImpl: typeof fetch;
    private readonly limiter: Semaphore;

    constructor({ baseUrl = DEFAULT_BASE_URL, auth, cache, concurrency = 6, fetchImpl = fetch }: {
        baseUrl?: string;
        auth: BitbucketAuth;
        cache: Cache;
        concurrency?: number;
        fetchImpl?: typeof fetch;
    }) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.auth = auth;
        this.cache = cache;
        this.fetchImpl = fetchImpl;
        this.limiter = new Semaphore(concurrency);
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

    /** Requête brute : réponse HTTP (null si 404 autorisé). Les erreurs sont traduites en AppError. */
    private async send(method: string, path: string, { query, body, allow404 = false }: RequestOptions, accept: string): Promise<Response | null> {
        const url = this.url(path, query);
        const headers: Record<string, string> = {
            Authorization: `Basic ${Buffer.from(`${this.auth.email}:${this.auth.token}`).toString('base64')}`,
            Accept: accept,
        };
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
        }
        return this.limiter.run(async () => {
            for (let attempt = 0; ; attempt++) {
                let response: Response;
                try {
                    response = await this.fetchImpl(url, {
                        method,
                        headers,
                        body: body === undefined ? undefined : JSON.stringify(body),
                        redirect: 'follow',
                        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                    });
                } catch (error) {
                    if (attempt < 2) {
                        await sleep(500 * (attempt + 1));
                        continue;
                    }
                    throw new AppError(502, 'BB_UNREACHABLE', `Bitbucket injoignable (${(error as Error).message})`);
                }
                if ((response.status === 429 || response.status >= 500) && attempt < 3) {
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

    private async json<T>(method: string, path: string, options: RequestOptions = {}): Promise<T | null> {
        const response = await this.send(method, path, options, 'application/json');
        if (!response || response.status === 204) {
            return null;
        }
        const text = await response.text();
        return text ? JSON.parse(text) as T : null;
    }

    private async getJson<T>(path: string, query?: Query): Promise<T> {
        const value = await this.json<T>('GET', path, query ? { query } : {});
        if (value === null) {
            throw errorFor(502, path, 'réponse vide');
        }
        return value;
    }

    private async getAllPages<T>(path: string, query: Query = {}, maxPages = 40): Promise<T[]> {
        const values: T[] = [];
        let page = await this.getJson<BbPage<T>>(path, query);
        for (let i = 1; ; i++) {
            for (const value of page.values ?? []) {
                values.push(value);
            }
            if (!page.next || i >= maxPages) {
                return values;
            }
            // Le jeton ne suit jamais une URL de pagination hors de l'API configurée.
            if (!page.next.startsWith(`${this.baseUrl}/`)) {
                throw new AppError(502, 'BB_ERROR', `Pagination Bitbucket inattendue : ${new URL(page.next).origin}`);
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

    // ---------- Données vivantes (cache mémoire court) ----------

    async me(): Promise<User | null> {
        return userOf(await this.getJson<BbUser>('user'));
    }

    pullRequest(ws: string, repo: string, id: number): Promise<BbPullRequest> {
        return this.cache.getLive(`live:${ws}/${repo}#${id}:pr`, LIVE_TTL_MS, () => this.getJson<BbPullRequest>(this.prPath(ws, repo, id)));
    }

    activity(ws: string, repo: string, id: number): Promise<BbActivity[]> {
        return this.cache.getLive(`live:${ws}/${repo}#${id}:activity`, LIVE_TTL_MS,
            () => this.getAllPages<BbActivity>(`${this.prPath(ws, repo, id)}/activity`, { pagelen: 50 }, 400));
    }

    comments(ws: string, repo: string, id: number): Promise<BbComment[]> {
        return this.cache.getLive(`live:${ws}/${repo}#${id}:comments`, LIVE_TTL_MS,
            () => this.getAllPages<BbComment>(`${this.prPath(ws, repo, id)}/comments`, { pagelen: 100 }));
    }

    openPullRequests(ws: string, repo: string): Promise<BbPullRequest[]> {
        return this.getAllPages<BbPullRequest>(`${this.repoPath(ws, repo)}/pullrequests`, {
            state: 'OPEN',
            pagelen: 50,
            fields: '+values.participants,+values.reviewers',
        }, 4);
    }

    invalidatePr(ws: string, repo: string, id: number): void {
        this.cache.invalidateLive(`live:${ws}/${repo}#${id}:`);
        this.cache.invalidateLive('live:home:');
    }

    // ---------- Données immuables (cache disque) ----------

    /**
     * Commit, ou null s'il n'existe plus : Bitbucket efface au bout d'un moment les commits écrasés par un force-push
     * (anciennes versions d'une PR). L'absence n'est pas mise en cache.
     */
    commit(ws: string, repo: string, hash: string): Promise<CommitSummary | null> {
        return this.cache.getOrCompute(`commit:${ws}/${repo}:${hash}`, async () => {
            const raw = await this.json<BbCommit>('GET', `${this.repoPath(ws, repo)}/commit/${hash}`, { allow404: true });
            return raw ? { hash: raw.hash, message: raw.message ?? '', date: raw.date ?? null, parents: (raw.parents ?? []).map((p) => p.hash) } : null;
        }, (commit) => commit !== null);
    }

    mergeBase(ws: string, repo: string, a: string, b: string): Promise<string | null> {
        return this.cache.getOrCompute(`merge-base:${ws}/${repo}:${a}..${b}`, async () => {
            const raw = await this.json<BbCommit>('GET', `${this.repoPath(ws, repo)}/merge-base/${a}..${b}`, { allow404: true });
            return raw?.hash ?? null;
        }, (hash) => hash !== null);
    }

    /** Fichiers différents entre deux commits (diff à deux points : oldHash → newHash). */
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

    /** Contenu d'un fichier à un commit (un 404 n'est pas mis en cache : il peut être transitoire). */
    fileContent(ws: string, repo: string, hash: string, filePath: string): Promise<FileContent> {
        const srcPath = `${this.repoPath(ws, repo)}/src/${hash}/${encodePath(filePath)}`;
        return this.cache.getOrCompute<FileContent>(`src2:${ws}/${repo}:${hash}:${filePath}`, async () => {
            const response = await this.send('GET', srcPath, { allow404: true }, '*/*');
            if (!response) {
                return { missing: true };
            }
            if (Number(response.headers.get('content-length')) > MAX_FILE_BYTES) {
                return { tooLarge: true };
            }
            const buffer = Buffer.from(await response.arrayBuffer());
            if (buffer.length > MAX_FILE_BYTES) {
                return { tooLarge: true };
            }
            if (buffer.subarray(0, 8000).includes(0)) {
                return { binary: true };
            }
            const text = buffer.toString('utf8');
            // Un sous-module renvoie le hash du commit pointé (40 caractères) : on le présente comme git.
            if (/^[0-9a-f]{40}$/.test(text)) {
                const meta = await this.json<BbSrcMeta>('GET', srcPath, { query: { format: 'meta' }, allow404: true });
                if (meta?.attributes?.includes('subrepository')) {
                    return { text: `Subproject commit ${text}\n`, submodule: true };
                }
            }
            // Un dossier renvoie un listing JSON paginé au lieu d'un contenu.
            if ((response.headers.get('content-type') ?? '').includes('application/json') && !filePath.endsWith('.json') && isListing(text)) {
                return { special: true };
            }
            return { text };
        }, (content) => !('missing' in content));
    }

    /** Source de comparaison (core/compare.ts) adossée à ce client. */
    source(ws: string, repo: string): CompareSource {
        return {
            diffstat: (newHash, oldHash) => this.diffstat(ws, repo, newHash, oldHash),
            content: (hash, path) => this.fileContent(ws, repo, hash, path),
        };
    }

    // ---------- Écritures ----------

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
            throw errorFor(502, 'comments', 'réponse vide');
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
