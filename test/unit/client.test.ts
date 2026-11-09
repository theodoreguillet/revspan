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

describe('BitbucketClient : reprises', () => {
    it('ne renvoie pas un POST qui reçoit un 502', async () => {
        const fetchImpl = mockFetch(new Response('bad gateway', { status: 502 }), jsonResponse(201, { id: 1 }));
        await expect(makeClient(fetchImpl).createComment('acme', 'records-api', 1, { raw: 'salut' })).rejects.toMatchObject({ code: 'BB_ERROR' });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('ne renvoie pas un POST après une erreur réseau', async () => {
        const fetchImpl = mockFetch(new Error('reset'), jsonResponse(201, { id: 1 }));
        await expect(makeClient(fetchImpl).createComment('acme', 'records-api', 1, { raw: 'salut' })).rejects.toMatchObject({ code: 'BB_UNREACHABLE' });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('renvoie un POST qui reçoit un 429 (requête non traitée)', async () => {
        const fetchImpl = mockFetch(new Response('', { status: 429, headers: { 'retry-after': '0' } }), jsonResponse(201, { id: 7 }));
        const created = await makeClient(fetchImpl).createComment('acme', 'records-api', 1, { raw: 'salut' });
        expect(created.id).toBe(7);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('reprend un GET qui reçoit un 503', async () => {
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

describe('BitbucketClient : chemins de fichier', () => {
    it.each(['a/../b', '../x', './x', 'a//b', 'a/.'])('refuse %s sans appel réseau', async (filePath) => {
        const fetchImpl = mockFetch(new Response('x'));
        const error = await makeClient(fetchImpl).fileContent('acme', 'records-api', 'abc123', filePath).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).status).toBe(400);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('accepte un chemin normal', async () => {
        const fetchImpl = mockFetch(new Response('contenu', { headers: { 'content-type': 'text/plain' } }));
        await expect(makeClient(fetchImpl).fileContent('acme', 'records-api', 'abc123', 'src/a b.ts')).resolves.toEqual({ text: 'contenu' });
    });
});

describe('BitbucketClient : empreinte des fichiers binaires ou trop gros', () => {
    const sha1 = (data: string | Buffer): string => createHash('sha1').update(data).digest('hex');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);

    it('binaire : sha1 des octets', async () => {
        const fetchImpl = mockFetch(new Response(png, { headers: { 'content-type': 'image/png' } }));
        await expect(makeClient(fetchImpl).fileContent('acme', 'records-api', 'abc123', 'logo.png')).resolves.toEqual({ binary: true, fingerprint: sha1(png) });
    });

    it('trop gros une fois lu (sans content-length) : sha1 des octets', async () => {
        const huge = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61);
        const fetchImpl = mockFetch(new Response(huge));
        await expect(makeClient(fetchImpl).fileContent('acme', 'records-api', 'abc123', 'a.txt')).resolves.toEqual({ tooLarge: true, fingerprint: sha1(huge) });
    });

    it('trop gros d\'après content-length (non téléchargé) : aucune empreinte, même avec un ETag', async () => {
        const fetchImpl = mockFetch(new Response('x', { headers: { 'content-length': String(6 * 1024 * 1024), etag: '"blob-1"' } }));
        await expect(makeClient(fetchImpl).fileContent('acme', 'records-api', 'abc123', 'a.bin')).resolves.toEqual({ tooLarge: true });
    });
});

describe('BitbucketClient : réponse non JSON', () => {
    it('traduit un 200 HTML en BB_ERROR 502 sans le jeton', async () => {
        const fetchImpl = mockFetch(new Response('<html>proxy</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
        const error = await makeClient(fetchImpl).me().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AppError);
        expect(error).toMatchObject({ status: 502, code: 'BB_ERROR' });
        expect((error as AppError).message).not.toContain(TOKEN);
    });
});

describe('BitbucketClient : redirections', () => {
    const redirect = (location: string): Response => new Response(null, { status: 302, headers: { location } });
    const authOf = (fetchImpl: ReturnType<typeof mockFetch>, call: number): unknown =>
        (fetchImpl.mock.calls[call]?.[1]?.headers as Record<string, string>).Authorization;

    it('utilise redirect manual', async () => {
        const fetchImpl = mockFetch(jsonResponse(200, { username: 'jdoe' }));
        await makeClient(fetchImpl).me();
        expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe('manual');
    });

    it('garde Authorization sur la même origine', async () => {
        const fetchImpl = mockFetch(redirect(`${BASE}/elsewhere`), jsonResponse(200, { username: 'jdoe' }));
        await makeClient(fetchImpl).me();
        expect(fetchImpl.mock.calls[1]?.[0]).toBe(`${BASE}/elsewhere`);
        expect(authOf(fetchImpl, 1)).toBeTypeOf('string');
    });

    it('retire Authorization vers une autre origine', async () => {
        const fetchImpl = mockFetch(redirect('https://cdn.example.org/file'), jsonResponse(200, { username: 'jdoe' }));
        await makeClient(fetchImpl).me();
        expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://cdn.example.org/file');
        expect(authOf(fetchImpl, 1)).toBeUndefined();
    });

    it('suit au plus 3 redirections', async () => {
        const fetchImpl = mockFetch(redirect(`${BASE}/1`), redirect(`${BASE}/2`), redirect(`${BASE}/3`), redirect(`${BASE}/4`), jsonResponse(200, {}));
        await expect(makeClient(fetchImpl).me()).rejects.toMatchObject({ code: 'BB_ERROR' });
        expect(fetchImpl).toHaveBeenCalledTimes(4);
    });
});

describe('BitbucketClient : commit effacé après mise en cache', () => {
    const commit = { hash: 'abc123', message: 'feat: x', parents: [{ hash: 'base1' }] };
    const gone = (): Response => jsonResponse(404, { error: { message: 'Commit not found' } });

    it('commitExists interroge Bitbucket même si le commit est en cache, puis forgetCommit le fait relire', async () => {
        const fetchImpl = mockFetch(jsonResponse(200, commit), gone(), gone());
        const client = makeClient(fetchImpl);
        expect(await client.commit('acme', 'records-api', 'abc123')).toMatchObject({ hash: 'abc123' });
        expect(await client.commit('acme', 'records-api', 'abc123')).toMatchObject({ hash: 'abc123' });
        expect(await client.commitExists('acme', 'records-api', 'abc123')).toBe(false);
        client.forgetCommit('acme', 'records-api', 'abc123');
        expect(await client.commit('acme', 'records-api', 'abc123')).toBeNull();
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it('commitExists : vrai si le commit existe, résultat gardé quelques secondes', async () => {
        const fetchImpl = mockFetch(jsonResponse(200, commit));
        const client = makeClient(fetchImpl);
        expect(await client.commitExists('acme', 'records-api', 'abc123')).toBe(true);
        expect(await client.commitExists('acme', 'records-api', 'abc123')).toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('forgetMergeBase fait relire la merge-base', async () => {
        const fetchImpl = mockFetch(jsonResponse(200, { hash: 'base1' }), jsonResponse(200, { hash: 'base1' }));
        const client = makeClient(fetchImpl);
        await client.mergeBase('acme', 'records-api', 'abc123', 'dest1');
        await client.mergeBase('acme', 'records-api', 'abc123', 'dest1');
        client.forgetMergeBase('acme', 'records-api', 'abc123', 'dest1');
        await client.mergeBase('acme', 'records-api', 'abc123', 'dest1');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
});
