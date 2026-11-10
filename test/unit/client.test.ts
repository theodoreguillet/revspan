import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BitbucketClient } from '../../src/server/bitbucket/client.ts';
import { AppError } from '../../src/server/errors.ts';
import { Cache } from '../../src/server/infra/cache.ts';

const BASE = 'https://api.example.test/2.0';
const TOKEN = 'secret-token-123';

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function makeClient(fetchImpl: typeof fetch): BitbucketClient {
    return new BitbucketClient({ baseUrl: BASE, auth: { email: 'a@acme.test', token: TOKEN }, cache: new Cache(null), fetchImpl });
}

const mockFetch = (...responses: (Response | Error)[]) => vi.fn<typeof fetch>(async () => {
    const next = responses.shift();
    if (!next) {
        throw new Error('trop d\'appels');
    }
    if (next instanceof Error) {
        throw next;
    }
    return next;
});

describe('BitbucketClient: retries', () => {
    it('does not resend a POST that gets a 502', async () => {
        const fetchImpl = mockFetch(new Response('bad gateway', { status: 502 }), jsonResponse(201, { id: 1 }));
        await expect(makeClient(fetchImpl).createComment('acme', 'records-api', 1, { raw: 'salut' })).rejects.toMatchObject({ code: 'BB_ERROR' });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('does not resend a POST after a network error', async () => {
        const fetchImpl = mockFetch(new Error('reset'), jsonResponse(201, { id: 1 }));
        await expect(makeClient(fetchImpl).createComment('acme', 'records-api', 1, { raw: 'salut' })).rejects.toMatchObject({ code: 'BB_UNREACHABLE' });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('resends a POST that gets a 429 (request not processed)', async () => {
        vi.useFakeTimers();
        try {
            const fetchImpl = mockFetch(new Response('', { status: 429, headers: { 'retry-after': '0' } }), jsonResponse(201, { id: 7 }));
            const promise = makeClient(fetchImpl).createComment('acme', 'records-api', 1, { raw: 'salut' });
            await vi.runAllTimersAsync();
            expect((await promise).id).toBe(7);
            expect(fetchImpl).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('retries a GET that gets a 503', async () => {
        vi.useFakeTimers();
        try {
            const fetchImpl = mockFetch(new Response('', { status: 503 }), jsonResponse(200, { username: 'jdoe' }));
            const promise = makeClient(fetchImpl).me();
            await vi.runAllTimersAsync();
            await expect(promise).resolves.not.toBeUndefined();
            expect(fetchImpl).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('BitbucketClient: file paths', () => {
    it.each(['a/../b', '../x', './x', 'a//b', 'a/.'])('rejects %s without a network call', async (filePath) => {
        const fetchImpl = mockFetch(new Response('x'));
        const error = await makeClient(fetchImpl).fileContent('acme', 'records-api', 'abc123', filePath).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).status).toBe(400);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('accepts a normal path', async () => {
        const fetchImpl = mockFetch(new Response('contenu', { headers: { 'content-type': 'text/plain' } }));
        await expect(makeClient(fetchImpl).fileContent('acme', 'records-api', 'abc123', 'src/a b.ts')).resolves.toEqual({ text: 'contenu' });
    });
});

describe('BitbucketClient: fingerprint of binary or oversized files', () => {
    const sha1 = (data: string | Buffer): string => createHash('sha1').update(data).digest('hex');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);

    it('binary: sha1 of the bytes', async () => {
        const fetchImpl = mockFetch(new Response(png, { headers: { 'content-type': 'image/png' } }));
        await expect(makeClient(fetchImpl).fileContent('acme', 'records-api', 'abc123', 'logo.png')).resolves.toEqual({ binary: true, fingerprint: sha1(png) });
    });

    it('too large once read (no content-length): sha1 of the bytes', async () => {
        const huge = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61);
        const fetchImpl = mockFetch(new Response(huge));
        await expect(makeClient(fetchImpl).fileContent('acme', 'records-api', 'abc123', 'a.txt')).resolves.toEqual({ tooLarge: true, fingerprint: sha1(huge) });
    });

    it('too large according to content-length (not downloaded): no fingerprint, even with an ETag', async () => {
        const fetchImpl = mockFetch(new Response('x', { headers: { 'content-length': String(6 * 1024 * 1024), etag: '"blob-1"' } }));
        await expect(makeClient(fetchImpl).fileContent('acme', 'records-api', 'abc123', 'a.bin')).resolves.toEqual({ tooLarge: true });
    });
});

describe('BitbucketClient: non-JSON response', () => {
    it('turns an HTML 200 into BB_ERROR 502 without the token', async () => {
        const fetchImpl = mockFetch(new Response('<html>proxy</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
        const error = await makeClient(fetchImpl).me().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AppError);
        expect(error).toMatchObject({ status: 502, code: 'BB_ERROR' });
        expect((error as AppError).message).not.toContain(TOKEN);
    });
});

describe('BitbucketClient: redirects', () => {
    const redirect = (location: string): Response => new Response(null, { status: 302, headers: { location } });
    const authOf = (fetchImpl: ReturnType<typeof mockFetch>, call: number): unknown =>
        (fetchImpl.mock.calls[call]?.[1]?.headers as Record<string, string>).Authorization;

    it('uses redirect manual', async () => {
        const fetchImpl = mockFetch(jsonResponse(200, { username: 'jdoe' }));
        await makeClient(fetchImpl).me();
        expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe('manual');
    });

    it('keeps Authorization on the same origin', async () => {
        const fetchImpl = mockFetch(redirect(`${BASE}/elsewhere`), jsonResponse(200, { username: 'jdoe' }));
        await makeClient(fetchImpl).me();
        expect(fetchImpl.mock.calls[1]?.[0]).toBe(`${BASE}/elsewhere`);
        expect(authOf(fetchImpl, 1)).toBeTypeOf('string');
    });

    it('drops Authorization towards another origin', async () => {
        const fetchImpl = mockFetch(redirect('https://cdn.example.org/file'), jsonResponse(200, { username: 'jdoe' }));
        await makeClient(fetchImpl).me();
        expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://cdn.example.org/file');
        expect(authOf(fetchImpl, 1)).toBeUndefined();
    });

    it('follows at most 3 redirects', async () => {
        const fetchImpl = mockFetch(redirect(`${BASE}/1`), redirect(`${BASE}/2`), redirect(`${BASE}/3`), redirect(`${BASE}/4`), jsonResponse(200, {}));
        await expect(makeClient(fetchImpl).me()).rejects.toMatchObject({ code: 'BB_ERROR' });
        expect(fetchImpl).toHaveBeenCalledTimes(4);
    });
});

describe('BitbucketClient: commit erased after being cached', () => {
    const commit = { hash: 'abc123', message: 'feat: x', parents: [{ hash: 'base1' }] };
    const gone = (): Response => jsonResponse(404, { error: { message: 'Commit not found' } });

    it('commitExists asks Bitbucket even if the commit is cached, then forgetCommit makes it be read again', async () => {
        const fetchImpl = mockFetch(jsonResponse(200, commit), gone(), gone());
        const client = makeClient(fetchImpl);
        expect(await client.commit('acme', 'records-api', 'abc123')).toMatchObject({ hash: 'abc123' });
        expect(await client.commit('acme', 'records-api', 'abc123')).toMatchObject({ hash: 'abc123' });
        expect(await client.commitExists('acme', 'records-api', 'abc123')).toBe(false);
        client.forgetCommit('acme', 'records-api', 'abc123');
        expect(await client.commit('acme', 'records-api', 'abc123')).toBeNull();
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it('commitExists: true if the commit exists, result kept for a few seconds', async () => {
        const fetchImpl = mockFetch(jsonResponse(200, commit));
        const client = makeClient(fetchImpl);
        expect(await client.commitExists('acme', 'records-api', 'abc123')).toBe(true);
        expect(await client.commitExists('acme', 'records-api', 'abc123')).toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('forgetMergeBase makes the merge-base be read again', async () => {
        const fetchImpl = mockFetch(jsonResponse(200, { hash: 'base1' }), jsonResponse(200, { hash: 'base1' }));
        const client = makeClient(fetchImpl);
        await client.mergeBase('acme', 'records-api', 'abc123', 'dest1');
        await client.mergeBase('acme', 'records-api', 'abc123', 'dest1');
        client.forgetMergeBase('acme', 'records-api', 'abc123', 'dest1');
        await client.mergeBase('acme', 'records-api', 'abc123', 'dest1');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
});

describe('BitbucketClient: open PR list', () => {
    const page = (ids: number[], next?: string): Response => jsonResponse(200, { values: ids.map((id) => ({ id })), ...(next ? { next } : {}) });
    const nextPage = (n: number): string => `${BASE}/repositories/acme/records-api/pullrequests?page=${n}`;

    it('I5: reads at most 4 pages of 50 and says when the list was cut there (a next page was still announced)', async () => {
        const fetchImpl = mockFetch(page([1], nextPage(2)), page([2], nextPage(3)), page([3], nextPage(4)), page([4], nextPage(5)));
        const list = await makeClient(fetchImpl).openPullRequests('acme', 'records-api');
        expect(list).toEqual({ prs: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }], truncated: true });
        expect(fetchImpl).toHaveBeenCalledTimes(4);
        expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).searchParams.get('pagelen')).toBe('50');
    });

    it('I5: a last page without a next one: complete', async () => {
        const fetchImpl = mockFetch(page([1, 2], nextPage(2)), page([3]));
        expect(await makeClient(fetchImpl).openPullRequests('acme', 'records-api')).toEqual({ prs: [{ id: 1 }, { id: 2 }, { id: 3 }], truncated: false });
    });

    it('I5: the cap can be lowered (tests): page length and number of pages', async () => {
        const fetchImpl = mockFetch(page([1, 2], nextPage(2)));
        const client = new BitbucketClient({ baseUrl: BASE, auth: { email: 'a@acme.test', token: TOKEN }, cache: new Cache(null), fetchImpl, prListLimit: { pagelen: 2, pages: 1 } });
        expect(await client.openPullRequests('acme', 'records-api')).toEqual({ prs: [{ id: 1 }, { id: 2 }], truncated: true });
        expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).searchParams.get('pagelen')).toBe('2');
    });
});

describe('BitbucketClient: build statuses and branch heads', () => {
    const HEAD = 'a'.repeat(40);
    const status = (key: string, state: string, hash = HEAD): Record<string, unknown> => ({ key, state, commit: { hash }, updated_on: '2026-10-01T00:00:00Z' });
    /** A push long before the clock of these tests (2026-11-10T12:00:00Z): past the grace period of settled checks. */
    const OLD_PUSH = '2026-11-01T09:00:00Z';

    it('reads the head commit\'s statuses (not every status of the PR), page length 50, following pagination, other commits left out', async () => {
        const next = `${BASE}/repositories/acme/records-api/commit/${HEAD.slice(0, 12)}/statuses?page=2`;
        const fetchImpl = mockFetch(
            jsonResponse(200, { values: [status('ci', 'FAILED'), status('old', 'SUCCESSFUL', 'b'.repeat(40))], next }),
            jsonResponse(200, { values: [status('scan', 'SUCCESSFUL')] }),
        );
        const checks = await makeClient(fetchImpl).headChecks('acme', 'records-api', 7, HEAD.slice(0, 12));
        expect(checks.map((c) => `${c.key}:${c.state}`)).toEqual(['ci:failed', 'scan:success']);
        const first = new URL(String(fetchImpl.mock.calls[0]?.[0]));
        expect(first.pathname).toBe(`/2.0/repositories/acme/records-api/commit/${HEAD.slice(0, 12)}/statuses`);
        expect(first.searchParams.get('pagelen')).toBe('50');
    });

    it('settled checks (success, failed, stopped) on a head pushed more than an hour ago are kept and never asked again', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
        try {
            const fetchImpl = mockFetch(jsonResponse(200, { values: [status('ci', 'FAILED'), status('scan', 'STOPPED'), status('lint', 'SUCCESSFUL')] }));
            const client = makeClient(fetchImpl);
            await client.headChecks('acme', 'records-api', 7, HEAD, { maxAgeMs: 1000, pushedAt: OLD_PUSH });
            vi.advanceTimersByTime(24 * 3600_000);
            expect((await client.headChecks('acme', 'records-api', 7, HEAD.slice(0, 12), { maxAgeMs: 1000, pushedAt: OLD_PUSH })).map((c) => c.state))
                .toEqual(['failed', 'stopped', 'success']);
            expect(fetchImpl).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('I2: settled checks on a head pushed less than an hour ago are re-read past maxAgeMs (another CI may not have posted yet), kept once older', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
        try {
            const fetchImpl = mockFetch(
                jsonResponse(200, { values: [status('lint', 'SUCCESSFUL')] }),
                jsonResponse(200, { values: [status('lint', 'SUCCESSFUL'), status('ci', 'INPROGRESS')] }),
                jsonResponse(200, { values: [status('lint', 'SUCCESSFUL'), status('ci', 'FAILED')] }),
                jsonResponse(200, { values: [status('lint', 'SUCCESSFUL'), status('ci', 'FAILED')] }),
            );
            const client = makeClient(fetchImpl);
            const read = async (): Promise<string[]> => (await client.headChecks('acme', 'records-api', 7, HEAD, { maxAgeMs: 60_000, pushedAt: '2026-11-10T11:58:00Z' }))
                .map((c) => `${c.key}:${c.state}`);
            expect(await read()).toEqual(['lint:success']);
            vi.advanceTimersByTime(61_000);
            expect(await read()).toEqual(['lint:success', 'ci:running']);
            vi.advanceTimersByTime(61_000);
            expect(await read()).toEqual(['lint:success', 'ci:failed']);
            // Within maxAgeMs: the read is reused.
            expect(await read()).toEqual(['lint:success', 'ci:failed']);
            expect(fetchImpl).toHaveBeenCalledTimes(3);
            // Past the hour: read once more, then kept for good.
            vi.advanceTimersByTime(3600_000);
            expect(await read()).toEqual(['lint:success', 'ci:failed']);
            vi.advanceTimersByTime(24 * 3600_000);
            expect(await read()).toEqual(['lint:success', 'ci:failed']);
            expect(fetchImpl).toHaveBeenCalledTimes(4);
        } finally {
            vi.useRealTimers();
        }
    });

    it('I2: settled checks of a head whose push date is unknown are not kept: re-read past maxAgeMs', async () => {
        vi.useFakeTimers();
        try {
            const fetchImpl = mockFetch(jsonResponse(200, { values: [status('ci', 'SUCCESSFUL')] }), jsonResponse(200, { values: [status('ci', 'SUCCESSFUL')] }));
            const client = makeClient(fetchImpl);
            await client.headChecks('acme', 'records-api', 7, HEAD, { maxAgeMs: 60_000 });
            vi.advanceTimersByTime(61_000);
            await client.headChecks('acme', 'records-api', 7, HEAD, { maxAgeMs: 60_000 });
            expect(fetchImpl).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a running check or no check at all is asked again once older than maxAgeMs, and for a new head', async () => {
        vi.useFakeTimers();
        try {
            const fetchImpl = mockFetch(
                jsonResponse(200, { values: [status('ci', 'INPROGRESS'), status('scan', 'SUCCESSFUL')] }),
                jsonResponse(200, { values: [status('ci', 'SUCCESSFUL'), status('scan', 'SUCCESSFUL')] }),
                jsonResponse(200, { values: [] }),
                jsonResponse(200, { values: [] }),
            );
            const client = makeClient(fetchImpl);
            await client.headChecks('acme', 'records-api', 7, HEAD, { maxAgeMs: 60_000 });
            vi.advanceTimersByTime(59_000);
            await client.headChecks('acme', 'records-api', 7, HEAD, { maxAgeMs: 60_000 });
            expect(fetchImpl).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(2_000);
            expect((await client.headChecks('acme', 'records-api', 7, HEAD, { maxAgeMs: 60_000 })).map((c) => c.state)).toEqual(['success', 'success']);
            // No check on a new head: read, then read again only past maxAgeMs.
            const other = 'c'.repeat(40);
            expect(await client.headChecks('acme', 'records-api', 7, other, { maxAgeMs: 60_000 })).toEqual([]);
            await client.headChecks('acme', 'records-api', 7, other, { maxAgeMs: 60_000 });
            expect(fetchImpl).toHaveBeenCalledTimes(3);
            vi.advanceTimersByTime(61_000);
            await client.headChecks('acme', 'records-api', 7, other, { maxAgeMs: 60_000 });
            expect(fetchImpl).toHaveBeenCalledTimes(4);
        } finally {
            vi.useRealTimers();
        }
    });

    it('recheck asks even settled checks; a re-run drops what was kept, so the next read asks again', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
        try {
            const fetchImpl = mockFetch(
                jsonResponse(200, { values: [status('ci', 'FAILED')] }),
                jsonResponse(200, { values: [status('ci', 'INPROGRESS')] }),
                jsonResponse(200, { values: [status('ci', 'SUCCESSFUL')] }),
            );
            const client = makeClient(fetchImpl);
            await client.headChecks('acme', 'records-api', 7, HEAD, { pushedAt: OLD_PUSH });
            vi.advanceTimersByTime(61_000);
            expect((await client.headChecks('acme', 'records-api', 7, HEAD, { recheck: true, pushedAt: OLD_PUSH })).map((c) => c.state)).toEqual(['running']);
            vi.advanceTimersByTime(61_000);
            expect((await client.headChecks('acme', 'records-api', 7, HEAD, { pushedAt: OLD_PUSH })).map((c) => c.state)).toEqual(['success']);
            expect(fetchImpl).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
        }
    });

    it('no status at all on a head pushed more than an hour ago: settled as none, never asked again', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
        try {
            const fetchImpl = mockFetch(jsonResponse(200, { values: [] }), jsonResponse(200, { values: [] }));
            const client = makeClient(fetchImpl);
            expect(await client.headChecks('acme', 'records-api', 7, HEAD, { maxAgeMs: 60_000, pushedAt: '2026-11-10T10:00:00Z' })).toEqual([]);
            vi.advanceTimersByTime(24 * 3600_000);
            expect(await client.headChecks('acme', 'records-api', 7, HEAD, { maxAgeMs: 60_000, pushedAt: '2026-11-10T10:00:00Z' })).toEqual([]);
            expect(fetchImpl).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('no status yet on a head pushed 10 minutes ago: asked again past maxAgeMs; a new head is always asked', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
        try {
            const fetchImpl = mockFetch(...[1, 2, 3].map(() => jsonResponse(200, { values: [] })));
            const client = makeClient(fetchImpl);
            await client.headChecks('acme', 'records-api', 7, HEAD, { maxAgeMs: 60_000, pushedAt: '2026-11-10T11:50:00Z' });
            vi.advanceTimersByTime(61_000);
            await client.headChecks('acme', 'records-api', 7, HEAD, { maxAgeMs: 60_000, pushedAt: '2026-11-10T11:50:00Z' });
            expect(fetchImpl).toHaveBeenCalledTimes(2);
            await client.headChecks('acme', 'records-api', 7, 'd'.repeat(40), { maxAgeMs: 60_000, pushedAt: '2026-11-10T09:00:00Z' });
            expect(fetchImpl).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
        }
    });

    it('branch heads are reused for maxAgeMs, then asked again; forgetLiveHealth drops them', async () => {
        vi.useFakeTimers();
        try {
            const fetchImpl = mockFetch(...['1', '2', '3'].map((c) => jsonResponse(200, { target: { hash: c.repeat(40) } })));
            const client = makeClient(fetchImpl);
            expect(await client.branchHead('acme', 'records-api', 'master', 300_000)).toBe('1'.repeat(40));
            vi.advanceTimersByTime(200_000);
            expect(await client.branchHead('acme', 'records-api', 'master', 300_000)).toBe('1'.repeat(40));
            vi.advanceTimersByTime(101_000);
            expect(await client.branchHead('acme', 'records-api', 'master', 300_000)).toBe('2'.repeat(40));
            client.forgetLiveHealth('acme', 'records-api');
            expect(await client.branchHead('acme', 'records-api', 'master', 300_000)).toBe('3'.repeat(40));
        } finally {
            vi.useRealTimers();
        }
    });

    it('returns the head hash of a branch and encodes each segment of its name', async () => {
        const fetchImpl = mockFetch(jsonResponse(200, { name: 'release/1.x', target: { hash: 'c'.repeat(40) } }));
        await expect(makeClient(fetchImpl).branchHead('acme', 'records-api', 'release/1.x')).resolves.toBe('c'.repeat(40));
        expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).pathname).toBe('/2.0/repositories/acme/records-api/refs/branches/release/1.x');
    });

    it('encodes special characters in a branch name', async () => {
        const fetchImpl = mockFetch(jsonResponse(200, { target: { hash: 'c'.repeat(40) } }));
        await makeClient(fetchImpl).branchHead('acme', 'records-api', 'feature/a b#c');
        expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/refs/branches/feature/a%20b%23c');
    });

    it('returns null when the branch does not exist', async () => {
        const fetchImpl = mockFetch(jsonResponse(404, { error: { message: 'gone' } }));
        await expect(makeClient(fetchImpl).branchHead('acme', 'records-api', 'old')).resolves.toBeNull();
    });
});
