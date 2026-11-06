// Pont de l'extension : l'application HTTP en mémoire (comme dans VS Code) branchée sur le faux Bitbucket.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { PrDetail } from '../../src/shared/api.ts';
import { createHttpApp } from '../../src/server/http/app.ts';
import { Cache } from '../../src/server/infra/cache.ts';
import { Store } from '../../src/server/infra/config.ts';
import { createSecretStore } from '../../src/server/infra/secrets.ts';
import { createServices, type Services } from '../../src/server/services/index.ts';
import { IN_MEMORY_HOST, callApi, isSuccessfulWrite } from '../../src/extension/lib/bridge.ts';
import { FAKE_EMAIL, FAKE_PRS, FAKE_TOKEN, REPO, WS, startFakeBitbucket, type FakeBitbucket } from '../support/fake-bitbucket.ts';

let fake: FakeBitbucket;
let dir: string;
let services: Services;
let http: Hono;

beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-ext-'));
    fake = await startFakeBitbucket();
    const store = new Store(dir);
    const secrets = await createSecretStore({ dir, env: { STRATA_TOKEN_STORE: 'file' } });
    services = createServices({ store, secrets, cache: new Cache(path.join(dir, 'cache')), baseUrl: fake.url });
    await services.settings.update({ email: FAKE_EMAIL, token: FAKE_TOKEN, repos: [`${WS}/${REPO}`] });
    http = createHttpApp({ version: 'test', settings: services.settings, home: services.home, prs: services.prs, allowedHosts: () => [IN_MEMORY_HOST] });
});

afterEach(async () => {
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const PR = `/api/pr/${WS}/${REPO}/${FAKE_PRS.main}`;

describe('pont de l\'extension (application HTTP en mémoire)', () => {
    it('lecture : même réponse qu\'en HTTP', async () => {
        const result = await callApi(http, { method: 'GET', path: PR });
        expect(result.status).toBe(200);
        expect((result.body as PrDetail).versions).toHaveLength(6);
    });

    it('écriture : l\'en-tête de mutation est ajouté par le pont, l\'appel atteint Bitbucket', async () => {
        const thread = ((await callApi(http, { method: 'GET', path: PR })).body as PrDetail).threads[0];
        const call = { method: 'POST', path: `${PR}/comments`, body: { raw: 'Depuis VS Code', parentId: thread?.id } };
        const result = await callApi(http, call);
        expect(result.status).toBe(200);
        expect(isSuccessfulWrite(call, result)).toBe(true);
        expect(fake.calls.at(-1)?.body).toEqual({ content: { raw: 'Depuis VS Code' }, parent: { id: thread?.id } });
    });

    it('erreurs : validation (400) et chemin hors API refusé', async () => {
        const invalid = await callApi(http, { method: 'POST', path: `${PR}/comments`, body: { raw: ' ' } });
        expect(invalid.status).toBe(400);
        expect(isSuccessfulWrite({ method: 'POST', path: '' }, invalid)).toBe(false);
        expect((await callApi(http, { method: 'GET', path: '/index.html' })).status).toBe(400);
        expect((await callApi(http, { method: 'PATCH', path: PR })).status).toBe(400);
    });

    it('le contrôle d\'hôte reste actif pour tout autre hôte', async () => {
        const response = await http.request(`http://evil.example${PR}`, { method: 'GET' });
        expect(response.status).toBe(403);
    });

    it('côtés d\'un fichier pour l\'éditeur de diff (rejoués à travers le rebase)', async () => {
        const sides = await services.prs.fileSides({ workspace: WS, repo: REPO, id: FAKE_PRS.main }, 2, 4, { path: 'package-lock.json', oldPath: null });
        expect(sides.oldText).toContain('1.0.0-rc.1');
        expect(sides.newText).toContain('1.0.0-rc.2');
    });
});
