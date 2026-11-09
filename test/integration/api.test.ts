// Vrai serveur Revspan (Hono) branché sur le faux Bitbucket. Chaque test part d'un environnement neuf
// (faux Bitbucket + configuration temporaire) : aucun test ne dépend d'un autre.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, Comparison, Home, PrCard, PrDetail, Settings, Summary } from '../../src/shared/api.ts';
import { startApp, type RunningApp } from '../../src/server/app.ts';
import {
    FAKE_EMAIL, FAKE_PRS, FAKE_TOKEN, REPO, WS, pushVersion, startFakeBitbucket, type FakeBitbucket, type RecordedCall,
} from '../support/fake-bitbucket.ts';

interface Env {
    fake: FakeBitbucket;
    app: RunningApp;
    dir: string;
}

let env: Env | null = null;

const startRevspan = (dir: string, fake: FakeBitbucket): Promise<RunningApp> =>
    startApp({ port: 0, env: { REVSPAN_CONFIG_DIR: dir, REVSPAN_TOKEN_STORE: 'file', REVSPAN_BITBUCKET_API: fake.url } });

/** Environnement neuf ; avec jeton configuré par défaut. */
async function setup({ withToken = true } = {}): Promise<Env> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revspan-it-'));
    const fake = await startFakeBitbucket();
    const app = await startRevspan(dir, fake);
    if (withToken) {
        await app.settings.update({ email: FAKE_EMAIL, token: FAKE_TOKEN, repos: [`${WS}/${REPO}`] });
    }
    env = { fake, app, dir };
    return env;
}

/** Relance Revspan sur la même configuration : cache mémoire vide, cache disque conservé. */
async function restart(current: Env): Promise<void> {
    await current.app.close();
    current.app = await startRevspan(current.dir, current.fake);
}

afterEach(async () => {
    if (env) {
        await env.app.close();
        await env.fake.close();
        fs.rmSync(env.dir, { recursive: true, force: true });
        env = null;
    }
});

const prPath = (id: number = FAKE_PRS.main): string => `/api/pr/${WS}/${REPO}/${id}`;

async function api<T = unknown>(method: string, route: string, body?: unknown, { header = true } = {}): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (header && method !== 'GET') {
        headers['X-Revspan'] = '1';
    }
    const response = await fetch(`${env?.app.url}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

/** Requête avec un en-tête Host choisi (fetch ne permet pas de le forcer). */
function rawGet(route: string, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: env?.app.port, path: route, headers: { Host: host } }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.end();
    });
}

const shortCall = (c: RecordedCall): string => `${c.method} ${c.path.replace(/^.*pullrequests\/\d+/, '')}`;
const detail = async (id?: number): Promise<PrDetail> => (await api<PrDetail>('GET', prPath(id))).body;

describe('réglages et sécurité', () => {
    it('sans jeton : réglages vides et NO_TOKEN', async () => {
        await setup({ withToken: false });
        expect((await api<Settings>('GET', '/api/settings')).body).toMatchObject({ hasToken: false, tokenStore: 'file' });
        const home = await api<ApiErrorBody>('GET', '/api/home');
        expect(home.status).toBe(409);
        expect(home.body.error.code).toBe('NO_TOKEN');
    });

    it('en-tête X-Revspan obligatoire, Host et origine étrangers refusés, en-têtes de sécurité', async () => {
        const { app } = await setup();
        expect((await api('PUT', '/api/settings', { email: 'x@y.z' }, { header: false })).status).toBe(403);
        expect(await rawGet('/api/health', 'evil.example:80')).toBe(403);
        const foreign = await fetch(`${app.url}/api/settings`, {
            method: 'PUT', headers: { 'X-Revspan': '1', Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}',
        });
        expect(foreign.status).toBe(403);
        const health = await fetch(`${app.url}/api/health`);
        expect(await health.json()).toEqual({ app: 'revspan', version: '2.0.0' });
        expect(health.headers.get('content-security-policy')).toContain("script-src 'self'");
        expect(health.headers.get('cache-control')).toBe('no-store');
    });

    it('jeton invalide puis valide, fichier de jeton en 0600, jeton jamais renvoyé', async () => {
        const { dir } = await setup({ withToken: false });
        const bad = await api<Settings>('PUT', '/api/settings', { email: FAKE_EMAIL, token: 'wrong', repos: [`${WS}/${REPO}`, 'pas un repo', '../..'] });
        expect(bad.body.repos).toEqual([`${WS}/${REPO}`]);
        expect((await api('POST', '/api/settings/test')).body).toMatchObject({ ok: false, error: { code: 'BB_UNAUTHORIZED' } });

        const good = await api<Settings>('PUT', '/api/settings', { token: FAKE_TOKEN });
        expect(good.body).toMatchObject({ hasToken: true, me: { displayName: 'Thomas Girard' } });
        expect((await api('POST', '/api/settings/test')).body).toEqual({ ok: true, me: { uuid: '{me}', displayName: 'Thomas Girard', nickname: 'tgirard' } });
        expect(fs.statSync(path.join(dir, 'token.json')).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).not.toContain(FAKE_TOKEN);
        expect(JSON.stringify((await api('GET', '/api/settings')).body)).not.toContain(FAKE_TOKEN);
    });

    it('validation des entrées (400) et routes inconnues (404)', async () => {
        const { app } = await setup();
        expect((await api('PUT', '/api/settings', { repos: 'pas une liste' })).status).toBe(400);
        expect((await api('POST', `${prPath()}/comments`, { raw: '   ' })).status).toBe(400);
        expect((await api('GET', `${prPath()}/compare?from=5&to=2`)).status).toBe(400);
        expect((await api('GET', `/api/pr/${WS}/${REPO}/abc`)).status).toBe(404);
        const nullBody = await fetch(`${app.url}${prPath()}/comments`, { method: 'POST', headers: { 'X-Revspan': '1', 'Content-Type': 'application/json' }, body: 'null' });
        expect(nullBody.status).toBe(400);
    });

    it('redirection /open et fichiers statiques protégés', async () => {
        const { app } = await setup();
        const open = await fetch(`${app.url}/open?url=${encodeURIComponent(`https://bitbucket.org/${WS}/${REPO}/pull-requests/42/overview`)}`, { redirect: 'manual' });
        expect(open.status).toBe(302);
        expect(open.headers.get('location')).toBe(`/#/pr/${WS}/${REPO}/42`);
        expect(await rawGet('/../package.json', `127.0.0.1:${app.port}`)).not.toBe(200);
        expect(await rawGet('/%2e%2e/package.json', `127.0.0.1:${app.port}`)).not.toBe(200);
    });

    it('erreurs Bitbucket traduites (403 → BB_FORBIDDEN)', async () => {
        const { fake } = await setup();
        await fetch(`http://127.0.0.1:${fake.port}/__fail-next?status=403`);
        const res = await api<ApiErrorBody>('POST', `${prPath()}/approve`);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('BB_FORBIDDEN');
    });
});

describe('lecture d\'une PR', () => {
    it('versions, rebases, participants, dernière relecture, fils', async () => {
        await setup();
        const body = await detail();
        expect(body.pr.title).toBe('DEMO-1 - feat(records): archive records in bulk');
        expect(body.versions.map((v) => v.isRebase)).toEqual([false, false, true, false, true, false]);
        expect(body.versions[5]?.messageChanged).toBe(true);
        // Mon commentaire du 2 oct. → v2
        expect(body.review).toMatchObject({ lastReviewed: 2, lastReviewedSource: 'comment' });
        expect(body.participants.find((p) => p.user?.uuid === '{yan}')?.approvedVersion).toBe(6);
        expect(body.threads).toHaveLength(4);
        const mine = body.threads.find((t) => t.path === 'src/Action.ts' && !t.resolved);
        expect(mine?.version).toBe(2);
        expect(mine?.comments.map((c) => c.raw)).toEqual(['Utilise le repository pour sauver.', 'Fait dans la dernière version.']);
        expect(mine?.comments[1]?.isNew).toBe(true);
    });

    it('résumé des versions', async () => {
        await setup();
        const { body } = await api<Summary>('GET', `${prPath()}/summary`);
        expect(body.versions.map((v) => v.kind)).toEqual(['creation', 'code', 'rebase-only', 'deps', 'code', 'message-only']);
        expect(body.versions[2]?.masterFiles).toBe(3);
    });

    it('comparaison à travers un rebase et placement des fils', async () => {
        await setup();
        const { body } = await api<Comparison>('GET', `${prPath()}/compare?from=2&to=5`);
        expect(body.files.map((f) => f.path)).toEqual(['src/Action.ts', 'package-lock.json']);
        expect(body.files[0]?.threads.find((t) => !t.outOfHunks && t.moved)?.line).toBe(7);
        expect(body.files[0]?.hunks[0]?.header).toBe('export class Action {');
        expect(body.masterOnly).toContain('changelog.md');
        expect((await api<Comparison>('GET', `${prPath()}/compare?from=0&to=6&context=100000`)).body.files).toHaveLength(3);
    });

    it('PR longue : 34 versions, rebases toutes les 7, relue à v30 (approbation)', async () => {
        await setup();
        const body = await detail(FAKE_PRS.long);
        expect(body.versions).toHaveLength(34);
        expect(body.versions.filter((v) => v.isRebase).map((v) => v.index)).toEqual([7, 14, 21, 28]);
        expect(body.review).toMatchObject({ lastReviewed: 30, lastReviewedSource: 'approval' });
    });

    it('rebase seul depuis ma relecture : v2 sans changement de l\'auteur', async () => {
        await setup();
        expect((await detail(FAKE_PRS.rebaseOnly)).review.lastReviewed).toBe(1);
        const { body } = await api<Summary>('GET', `${prPath(FAKE_PRS.rebaseOnly)}/summary`);
        expect(body.versions.map((v) => v.kind)).toEqual(['creation', 'rebase-only']);
    });

    it('version effacée par Bitbucket : page chargée, v1 indisponible, résumés et comparaisons sans elle', async () => {
        await setup();
        const pr = await detail(FAKE_PRS.purged);
        expect(pr.versions.map((v) => [v.index, v.available, v.isRebase])).toEqual([[1, false, false], [2, true, false], [3, true, false]]);
        expect(pr.versions[0]).toMatchObject({ base: '', message: '' });
        expect(pr.review.lastReviewed).toBe(1);

        const { body: summary } = await api<Summary>('GET', `${prPath(FAKE_PRS.purged)}/summary`);
        expect(summary.versions.map((s) => [s.kind, s.since ?? null, s.added])).toEqual([['unavailable', null, 0], ['code', 0, 1], ['code', null, 1]]);

        const refused = await api<ApiErrorBody>('GET', `${prPath(FAKE_PRS.purged)}/compare?from=1&to=3`);
        expect(refused.status).toBe(410);
        expect(refused.body.error).toMatchObject({ code: 'VERSION_UNAVAILABLE' });
        expect(refused.body.error.message).toContain('v1');

        // Le fil posé sur v1 reste visible, au niveau du fichier (sa position d'origine est illisible).
        const { body: full } = await api<Comparison>('GET', `${prPath(FAKE_PRS.purged)}/compare?from=0&to=3`);
        expect(full.stats).toEqual({ files: 1, added: 2, removed: 0 });
        const thread = pr.threads.find((t) => t.path === 'src/Purged.ts');
        expect(full.files[0]?.threads.find((p) => p.threadId === thread?.id)).toMatchObject({ line: null, moved: false });
    });

    it('version effacée après mise en cache, puis nouveau push : résumé 200 sans elle, comparaison 410', async () => {
        const current = await setup();
        const route = prPath(FAKE_PRS.mine);
        expect((await api<Summary>('GET', `${route}/summary`)).body.versions.map((s) => s.kind)).toEqual(['creation', 'code']);
        const v2 = (await detail(FAKE_PRS.mine)).versions[1]?.hash ?? '';
        // Plus tard : Bitbucket efface v2 (écrasée par un force-push), l'auteur pousse v3 ; le commit de v2 reste en cache disque.
        current.fake.data.repo.commits.delete(v2);
        pushVersion(current.fake.data, FAKE_PRS.mine, {
            commit: 'mine:v3', from: 'mine:v1', base: 'mine:m0', changes: { 'src/mine.ts': 'x\ny1\ny2\ny3\n' }, date: '2026-10-20T09:00:00Z',
        });
        await restart(current);

        const summary = await api<Summary>('GET', `${route}/summary`);
        expect(summary.status).toBe(200);
        expect(summary.body.versions.map((s) => [s.kind, s.since ?? null, s.added])).toEqual([['creation', null, 1], ['unavailable', null, 0], ['code', 1, 2]]);
        const refused = await api<ApiErrorBody>('GET', `${route}/compare?from=2&to=3`);
        expect(refused.status).toBe(410);
        expect(refused.body.error).toMatchObject({ code: 'VERSION_UNAVAILABLE' });
        expect((await detail(FAKE_PRS.mine)).versions.map((v) => v.available)).toEqual([true, false, true]);
    });

    it('fichier absent d\'une version encore lisible (ajouté à travers un rebase) : comparaison normale', async () => {
        const { fake } = await setup();
        pushVersion(fake.data, FAKE_PRS.rebaseOnly, {
            commit: 'rebase:v3', from: 'rebase:v2', base: 'rebase:m1', changes: { 'src/Extra.ts': 'e\n' }, date: '2026-10-06T09:00:00Z',
        });
        const { status, body } = await api<Comparison>('GET', `${prPath(FAKE_PRS.rebaseOnly)}/compare?from=1&to=3`);
        expect(status).toBe(200);
        expect(body.files.map((f) => `${f.status}:${f.path}`)).toEqual(['added:src/Extra.ts']);
        expect((await detail(FAKE_PRS.rebaseOnly)).versions.every((v) => v.available)).toBe(true);
    });

    it('version effacée après mise en cache : un contenu en 404 la rend indisponible (410), sans fichier perdu', async () => {
        const { fake } = await setup();
        await api('GET', `${prPath()}/summary`);
        // Diffstat de v2 en cache, mais pas tests/ActionSpec.ts à v2 : son contenu est demandé à Bitbucket.
        fake.data.repo.commits.delete((await detail()).versions[1]?.hash ?? '');

        const refused = await api<ApiErrorBody>('GET', `${prPath()}/compare?from=0&to=2`);
        expect(refused.status).toBe(410);
        expect(refused.body.error).toMatchObject({ code: 'VERSION_UNAVAILABLE' });
        expect((await detail()).versions.map((v) => v.available)).toEqual([true, false, true, true, true, true]);
        const { body: summary } = await api<Summary>('GET', `${prPath()}/summary`);
        expect(summary.versions.map((s) => s.kind)).toEqual(['creation', 'unavailable', 'code', 'deps', 'code', 'message-only']);
        expect(summary.versions[2]?.since).toBe(1);
    });
});

describe('actions', () => {
    it('répondre, commenter en ligne, résoudre, approuver', async () => {
        const { fake } = await setup();
        const thread = (await detail()).threads.find((t) => t.path === 'src/Action.ts' && !t.resolved);
        expect(thread).toBeTruthy();
        if (!thread) {
            return;
        }
        const reply = await api<{ raw: string; mine: boolean }>('POST', `${prPath()}/comments`, { raw: 'Merci !', parentId: thread.id });
        expect(reply.body).toMatchObject({ raw: 'Merci !', mine: true });
        expect((await api('POST', `${prPath()}/comments`, { raw: 'Nit', inline: { path: 'src/Action.ts', to: 3 } })).status).toBe(200);

        expect((await api('POST', `${prPath()}/comments/${thread.id}/resolve`)).status).toBe(200);
        expect((await detail()).threads.find((t) => t.id === thread.id)?.resolved).toBe(true);
        expect((await api('DELETE', `${prPath()}/comments/${thread.id}/resolve`)).status).toBe(200);

        expect((await api('POST', `${prPath()}/approve`)).status).toBe(200);
        const approved = await detail();
        expect(approved.review.lastReviewed).toBe(6);
        expect(approved.participants.find((p) => p.user?.uuid === '{me}')?.approved).toBe(true);

        expect(fake.calls.map(shortCall)).toEqual([
            'POST /comments', 'POST /comments',
            `POST /comments/${thread.id}/resolve`, `DELETE /comments/${thread.id}/resolve`, 'POST /approve',
        ]);
        expect(fake.calls[0]?.body).toEqual({ content: { raw: 'Merci !' }, parent: { id: thread.id } });
        expect(fake.calls[1]?.body).toEqual({ content: { raw: 'Nit' }, inline: { path: 'src/Action.ts', to: 3 } });
    });

    it('une réponse ne fait pas avancer la dernière relecture', async () => {
        await setup();
        const thread = (await detail()).threads.find((t) => t.path === 'src/Action.ts' && !t.resolved);
        await api('POST', `${prPath()}/comments`, { raw: 'Merci !', parentId: thread?.id });
        expect((await detail()).review.lastReviewed).toBe(2);
    });

    it('réapprouver : l\'ancienne approbation est retirée puis remise (datée de maintenant)', async () => {
        const { fake } = await setup();
        await api('POST', `${prPath()}/approve`);
        await api('POST', `${prPath()}/approve`);
        expect(fake.calls.map(shortCall)).toEqual(['POST /approve', 'DELETE /approve', 'POST /approve']);
    });

    it('état local : fichiers vus et marque « relue » persistés', async () => {
        const { dir } = await setup();
        expect((await api('POST', `${prPath()}/viewed`, { path: 'src/Action.ts', contentHash: 'abc', viewed: true })).status).toBe(200);
        expect((await api('POST', `${prPath()}/reviewed`, { version: 6 })).status).toBe(200);
        expect((await detail()).review).toMatchObject({ viewed: { 'src/Action.ts': 'abc' }, lastReviewed: 6, lastReviewedSource: 'local' });
        const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as { prs: Record<string, { reviewedHash?: string }> };
        expect(state.prs[`${WS}/${REPO}#${FAKE_PRS.main}`]?.reviewedHash).toBeTruthy();
        await api('POST', `${prPath()}/viewed`, { path: 'src/Action.ts', viewed: false });
        expect((await detail()).review.viewed).toEqual({});
        expect((await api('POST', `${prPath()}/reviewed`, { version: 99 })).status).toBe(400);
    });
});

describe('accueil', () => {
    it('aucun dépôt suivi par défaut : accueil vide, sans erreur', async () => {
        const { app } = await setup({ withToken: false });
        await app.settings.update({ email: FAKE_EMAIL, token: FAKE_TOKEN });
        expect((await api<Settings>('GET', '/api/settings')).body.repos).toEqual([]);
        const { body } = await api<Home>('GET', '/api/home');
        expect(body).toMatchObject({ repos: [], errors: [] });
        expect(body.groups.flatMap((g) => g.prs)).toEqual([]);
    });

    it('groupe chaque PR selon ce qui a bougé depuis ma relecture', async () => {
        await setup();
        // Le type des versions de #44 n'est connu qu'une fois son résumé calculé (ouverture de la PR).
        await api('GET', `${prPath(FAKE_PRS.rebaseOnly)}/summary`);
        const { body } = await api<Home>('GET', '/api/home');
        expect(body.me?.displayName).toBe('Thomas Girard');
        expect(body.repos).toEqual([`${WS}/${REPO}`]);
        expect(body.errors).toEqual([]);
        const groupOf = Object.fromEntries(body.groups.flatMap((g) => g.prs.map((p) => [p.id, g.key])));
        expect(groupOf).toEqual({
            [FAKE_PRS.main]: 'to-review',
            [FAKE_PRS.long]: 'to-review',
            [FAKE_PRS.rebaseOnly]: 'rebase-only',
            [FAKE_PRS.mine]: 'mine',
            [FAKE_PRS.neverReviewed]: 'to-review',
            [FAKE_PRS.others]: 'others',
            [FAKE_PRS.purged]: 'to-review',
        });
        const card = (id: number): PrCard | undefined => body.groups.flatMap((g) => g.prs).find((p) => p.id === id);
        expect(card(FAKE_PRS.main)).toMatchObject({ versionsCount: 6, lastReviewed: 2, newVersions: 4, approvals: 1, newComments: 2 });
        expect(card(FAKE_PRS.long)).toMatchObject({ lastReviewed: 30, newVersions: 4, myApproval: true });
        expect(card(FAKE_PRS.rebaseOnly)).toMatchObject({ lastReviewed: 1, newVersions: 1, newCodeVersions: 0 });
        expect(card(FAKE_PRS.neverReviewed)).toMatchObject({ lastReviewed: null, newVersions: 2 });
        expect(card(FAKE_PRS.others)).toMatchObject({ versionsCount: null, lastReviewed: null });
    });

    it('ouvrir une PR qui ne me concerne pas ne la fait pas changer de groupe', async () => {
        await setup();
        await detail(FAKE_PRS.others);
        const { body } = await api<Home>('GET', '/api/home');
        expect(body.groups.find((g) => g.key === 'others')?.prs.map((p) => p.id)).toEqual([FAKE_PRS.others]);
    });

    it('une PR relue jusqu\'à la dernière version est « à jour »', async () => {
        await setup();
        await api('POST', `${prPath()}/reviewed`, { version: 6 });
        const { body } = await api<Home>('GET', '/api/home');
        expect(body.groups.find((g) => g.key === 'up-to-date')?.prs.map((p) => p.id)).toEqual([FAKE_PRS.main]);
    });

    it('seulement des rebases depuis mon approbation, que Bitbucket a gardée : « à jour », pas de réapprobation', async () => {
        const { fake } = await setup();
        const me = fake.data.prs.get(FAKE_PRS.rebaseOnly)?.pr.participants.find((p) => p.user?.uuid === '{me}');
        expect(me).toBeTruthy();
        Object.assign(me!, { approved: true, state: 'approved' });
        await api('GET', `${prPath(FAKE_PRS.rebaseOnly)}/summary`);
        const { body } = await api<Home>('GET', '/api/home');
        const groupOf = (id: number): string | undefined => body.groups.find((g) => g.prs.some((p) => p.id === id))?.key;
        expect(groupOf(FAKE_PRS.rebaseOnly)).toBe('up-to-date');
        expect(body.groups.flatMap((g) => g.prs).find((p) => p.id === FAKE_PRS.rebaseOnly)).toMatchObject({ myApproval: true, newVersions: 1, newCodeVersions: 0 });
    });
});
