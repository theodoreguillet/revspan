// Real Revspan server (Hono) wired to the fake Bitbucket. Each test starts from a fresh environment
// (fake Bitbucket + temporary configuration): no test depends on another.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiErrorBody, Comparison, FollowedList, Home, HomeGroupKey, PrCard, PrDetail, Settings, Summary } from '../../src/shared/api.ts';
import { startApp, type RunningApp } from '../../src/server/app.ts';
import { Cache } from '../../src/server/infra/cache.ts';
import {
    FAKE_EMAIL, FAKE_PRS, FAKE_TOKEN, REPO, WS, pushVersion, startFakeBitbucket, type FakeBitbucket, type RecordedCall, type RecordedRequest,
} from '../support/fake-bitbucket.ts';

interface Env {
    fake: FakeBitbucket;
    app: RunningApp;
    dir: string;
}

let env: Env | null = null;

const PACKAGE_VERSION = (JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

const startRevspan = (dir: string, fake: FakeBitbucket, fetchImpl: typeof fetch = fetch): Promise<RunningApp> =>
    startApp({ port: 0, fetchImpl, env: { REVSPAN_CONFIG_DIR: dir, REVSPAN_TOKEN_STORE: 'file', REVSPAN_BITBUCKET_API: fake.url } });

/** Fresh environment; with a token configured by default. */
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

/** Restarts Revspan on the same configuration: empty memory cache, disk cache kept. */
async function restart(current: Env, fetchImpl?: typeof fetch): Promise<void> {
    await current.app.close();
    current.app = await startRevspan(current.dir, current.fake, fetchImpl);
}

afterEach(async () => {
    vi.useRealTimers();
    if (env) {
        await env.app.close();
        await env.fake.close();
        fs.rmSync(env.dir, { recursive: true, force: true });
        env = null;
    }
});

const prPath = (id: number = FAKE_PRS.main): string => `/api/pr/${WS}/${REPO}/${id}`;
const groupsOf = (home: Home): Record<number, HomeGroupKey> => Object.fromEntries(home.groups.flatMap((g) => g.prs.map((p) => [p.id, g.key])));
const cardOf = (home: Home, id: number): PrCard | undefined => home.groups.flatMap((g) => g.prs).find((p) => p.id === id);

async function api<T = unknown>(method: string, route: string, body?: unknown, { header = true } = {}): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (header && method !== 'GET') {
        headers['X-Revspan'] = '1';
    }
    const response = await fetch(`${env?.app.url}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

/** Request with a chosen Host header (fetch cannot force it). */
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

describe('settings and security', () => {
    it('no token: empty settings and NO_TOKEN', async () => {
        await setup({ withToken: false });
        expect((await api<Settings>('GET', '/api/settings')).body).toMatchObject({ hasToken: false, tokenStore: 'file' });
        const home = await api<ApiErrorBody>('GET', '/api/home');
        expect(home.status).toBe(409);
        expect(home.body.error.code).toBe('NO_TOKEN');
    });

    it('X-Revspan header required, foreign Host and origin rejected, security headers', async () => {
        const { app } = await setup();
        expect((await api('PUT', '/api/settings', { email: 'x@y.z' }, { header: false })).status).toBe(403);
        expect(await rawGet('/api/health', 'evil.example:80')).toBe(403);
        const foreign = await fetch(`${app.url}/api/settings`, {
            method: 'PUT', headers: { 'X-Revspan': '1', Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}',
        });
        expect(foreign.status).toBe(403);
        const health = await fetch(`${app.url}/api/health`);
        expect(await health.json()).toEqual({ app: 'revspan', version: PACKAGE_VERSION });
        expect(health.headers.get('content-security-policy')).toContain("script-src 'self'");
        expect(health.headers.get('cache-control')).toBe('no-store');
    });

    it('invalid then valid token, token file with mode 0600, token never returned', async () => {
        const { dir } = await setup({ withToken: false });
        const bad = await api<Settings>('PUT', '/api/settings', { email: FAKE_EMAIL, token: 'wrong', repos: [`${WS}/${REPO}`, 'not a repo', '../..'] });
        expect(bad.body.repos).toEqual([`${WS}/${REPO}`]);
        expect((await api('POST', '/api/settings/test')).body).toMatchObject({ ok: false, error: { code: 'BB_UNAUTHORIZED' } });

        const good = await api<Settings>('PUT', '/api/settings', { token: FAKE_TOKEN });
        expect(good.body).toMatchObject({ hasToken: true, me: { displayName: 'Thomas Girard' } });
        expect((await api('POST', '/api/settings/test')).body).toEqual({ ok: true, me: { uuid: '{me}', displayName: 'Thomas Girard', nickname: 'tgirard' } });
        expect(fs.statSync(path.join(dir, 'token.json')).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).not.toContain(FAKE_TOKEN);
        expect(JSON.stringify((await api('GET', '/api/settings')).body)).not.toContain(FAKE_TOKEN);
    });

    it('review settings: defaults, round trip, merge of a partial update, invalid values normalized', async () => {
        await setup();
        const defaults = (await api<Settings>('GET', '/api/settings')).body.review;
        expect(defaults).toEqual({
            requiredApprovals: 2,
            requiredApprovalsByRepo: {},
            followed: [],
            notifications: { newPullRequest: true, newVersion: true, buildFailed: false },
            refreshMinutes: 5,
        });

        const saved = await api<Settings>('PUT', '/api/settings', {
            review: { requiredApprovals: 3, requiredApprovalsByRepo: { [`${WS}/${REPO}`]: 1 }, followed: [{ uuid: '{cam}', displayName: 'Camille Durand' }], refreshMinutes: 10 },
        });
        expect(saved.body.review).toMatchObject({ requiredApprovals: 3, requiredApprovalsByRepo: { [`${WS}/${REPO}`]: 1 }, followed: [{ uuid: '{cam}', displayName: 'Camille Durand' }], refreshMinutes: 10 });
        expect((await api<Settings>('GET', '/api/settings')).body.review).toEqual(saved.body.review);

        // A partial update keeps the rest, the notifications are merged key by key.
        const partial = await api<Settings>('PUT', '/api/settings', { review: { notifications: { buildFailed: true } } });
        expect(partial.body.review).toMatchObject({ requiredApprovals: 3, refreshMinutes: 10, notifications: { newPullRequest: true, newVersion: true, buildFailed: true } });

        const invalid = await api<Settings>('PUT', '/api/settings', {
            review: { requiredApprovals: 0, requiredApprovalsByRepo: { [`${WS}/${REPO}`]: -2, 'acme/untracked': 0 }, refreshMinutes: 2.5 },
        });
        expect(invalid.status).toBe(200);
        expect(invalid.body.review).toMatchObject({ requiredApprovals: 2, requiredApprovalsByRepo: {}, refreshMinutes: 5 });
        expect((await api('PUT', '/api/settings', { review: 'nope' })).status).toBe(400);
    });

    it('invalid approval settings never move the whole queue: the default minimum of 2 applies', async () => {
        await setup();
        await api('PUT', '/api/settings', { review: { requiredApprovals: 0, requiredApprovalsByRepo: { [`${WS}/${REPO}`]: -1, 'acme/untracked': 5 } } });
        const { body } = await api<Home>('GET', '/api/home');
        expect(body.groups.flatMap((g) => g.prs).every((p) => p.requiredApprovals === 2)).toBe(true);
        expect(groupsOf(body)[FAKE_PRS.others]).toBe('others');
        expect(groupsOf(body)[FAKE_PRS.main]).toBe('to-do');
    });

    it('the minimum comes from the settings: a repository override changes the groups at once', async () => {
        await setup();
        expect(groupsOf((await api<Home>('GET', '/api/home')).body)[FAKE_PRS.others]).toBe('others');
        await api('PUT', '/api/settings', { review: { requiredApprovalsByRepo: { [`${WS}/${REPO}`]: 3 } } });
        let { body } = await api<Home>('GET', '/api/home');
        expect(groupsOf(body)[FAKE_PRS.others]).toBe('to-do');
        expect(cardOf(body, FAKE_PRS.others)).toMatchObject({ approvals: 2, requiredApprovals: 3, needsReview: true });
        await api('PUT', '/api/settings', { review: { requiredApprovalsByRepo: {}, requiredApprovals: 1 } });
        ({ body } = await api<Home>('GET', '/api/home'));
        expect(cardOf(body, FAKE_PRS.others)).toMatchObject({ requiredApprovals: 1, needsReview: false });
    });

    it('input validation (400) and unknown routes (404)', async () => {
        const { app } = await setup();
        expect((await api('PUT', '/api/settings', { repos: 'pas une liste' })).status).toBe(400);
        expect((await api('POST', `${prPath()}/comments`, { raw: '   ' })).status).toBe(400);
        expect((await api('GET', `${prPath()}/compare?from=5&to=2`)).status).toBe(400);
        expect((await api('GET', `/api/pr/${WS}/${REPO}/abc`)).status).toBe(404);
        const nullBody = await fetch(`${app.url}${prPath()}/comments`, { method: 'POST', headers: { 'X-Revspan': '1', 'Content-Type': 'application/json' }, body: 'null' });
        expect(nullBody.status).toBe(400);
    });

    it('/open redirect and protected static files', async () => {
        const { app } = await setup();
        const open = await fetch(`${app.url}/open?url=${encodeURIComponent(`https://bitbucket.org/${WS}/${REPO}/pull-requests/42/overview`)}`, { redirect: 'manual' });
        expect(open.status).toBe(302);
        expect(open.headers.get('location')).toBe(`/#/pr/${WS}/${REPO}/42`);
        expect(await rawGet('/../package.json', `127.0.0.1:${app.port}`)).not.toBe(200);
        expect(await rawGet('/%2e%2e/package.json', `127.0.0.1:${app.port}`)).not.toBe(200);
    });

    it('error bodies: English message plus the parameters the page translates from', async () => {
        await setup();
        const missing = await api<ApiErrorBody>('GET', prPath(9999));
        expect(missing.status).toBe(404);
        expect(missing.body.error).toMatchObject({ code: 'BB_NOT_FOUND', message: expect.stringMatching(/^Not found on Bitbucket: /), params: { path: expect.stringContaining('9999') } });
        const purged = await api<ApiErrorBody>('GET', `${prPath(FAKE_PRS.purged)}/compare?from=1&to=3`);
        expect(purged.body.error).toMatchObject({ code: 'VERSION_UNAVAILABLE', params: { version: 1 } });

        await api('PUT', '/api/settings', { repos: [`${WS}/${REPO}`, `${WS}/no-such-repo`] });
        const { body: home } = await api<Home>('GET', '/api/home');
        expect(home.errors).toEqual([expect.objectContaining({ repo: `${WS}/no-such-repo`, code: 'BB_NOT_FOUND', params: { path: expect.stringContaining('no-such-repo') } })]);
        // Language-neutral groups: the page and the VS Code tree translate the key.
        expect(home.groups.map((g) => Object.keys(g).sort())).toEqual(Array(4).fill(['key', 'prs']));
        expect(home.groups.map((g) => g.key)).toEqual(['to-do', 'mine', 'waiting', 'others']);

        const email = await api<ApiErrorBody>('PUT', '/api/settings', { email: 'not-an-email' });
        expect(email.body.error).toEqual({ code: 'BAD_REQUEST', message: 'Invalid email address.', params: { reason: 'invalid-email' } });
        const noEmail = await api<ApiErrorBody>('PUT', '/api/settings', { email: '', token: 'abc' });
        expect(noEmail.body.error).toMatchObject({ code: 'BAD_REQUEST', params: { reason: 'email-required' } });
    });

    it('Bitbucket errors translated (403 -> BB_FORBIDDEN)', async () => {
        const { fake } = await setup();
        await fetch(`http://127.0.0.1:${fake.port}/__fail-next?status=403`);
        const res = await api<ApiErrorBody>('POST', `${prPath()}/approve`);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('BB_FORBIDDEN');
    });
});

describe('reading a PR', () => {
    it('versions, rebases, participants, last review, threads', async () => {
        await setup();
        const body = await detail();
        expect(body.pr.title).toBe('DEMO-1 - feat(records): archive records in bulk');
        expect(body.versions.map((v) => v.isRebase)).toEqual([false, false, true, false, true, false]);
        expect(body.versions[5]?.messageChanged).toBe(true);
        // My comment of Oct 2 -> v2
        expect(body.review).toMatchObject({ lastReviewed: 2, lastReviewedSource: 'comment' });
        expect(body.participants.find((p) => p.user?.uuid === '{yan}')?.approvedVersion).toBe(6);
        expect(body.threads).toHaveLength(4);
        const mine = body.threads.find((t) => t.path === 'src/Action.ts' && !t.resolved);
        expect(mine?.version).toBe(2);
        expect(mine?.comments.map((c) => c.raw)).toEqual(['Utilise le repository pour sauver.', 'Fait dans la dernière version.']);
        expect(mine?.comments[1]?.isNew).toBe(true);
    });

    it('version summary', async () => {
        await setup();
        const { body } = await api<Summary>('GET', `${prPath()}/summary`);
        expect(body.versions.map((v) => v.kind)).toEqual(['creation', 'code', 'rebase-only', 'deps', 'code', 'message-only']);
        expect(body.versions[2]?.masterFiles).toBe(3);
    });

    it('comparison across a rebase and thread placement', async () => {
        await setup();
        const { body } = await api<Comparison>('GET', `${prPath()}/compare?from=2&to=5`);
        expect(body.files.map((f) => f.path)).toEqual(['src/Action.ts', 'package-lock.json']);
        expect(body.files[0]?.threads.find((t) => !t.outOfHunks && t.moved)?.line).toBe(7);
        expect(body.files[0]?.hunks[0]?.header).toBe('export class Action {');
        expect(body.masterOnly).toContain('changelog.md');
        expect((await api<Comparison>('GET', `${prPath()}/compare?from=0&to=6&context=100000`)).body.files).toHaveLength(3);
    });

    it('long PR: 34 versions, a rebase every 7, reviewed at v30 (approval)', async () => {
        await setup();
        const body = await detail(FAKE_PRS.long);
        expect(body.versions).toHaveLength(34);
        expect(body.versions.filter((v) => v.isRebase).map((v) => v.index)).toEqual([7, 14, 21, 28]);
        expect(body.review).toMatchObject({ lastReviewed: 30, lastReviewedSource: 'approval' });
    });

    it('rebase only since my review: v2 with no author change', async () => {
        await setup();
        expect((await detail(FAKE_PRS.rebaseOnly)).review.lastReviewed).toBe(1);
        const { body } = await api<Summary>('GET', `${prPath(FAKE_PRS.rebaseOnly)}/summary`);
        expect(body.versions.map((v) => v.kind)).toEqual(['creation', 'rebase-only']);
    });

    it('version erased by Bitbucket: page loaded, v1 unavailable, summaries and comparisons without it', async () => {
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

        // The thread placed on v1 stays visible, at file level (its original position is unreadable).
        const { body: full } = await api<Comparison>('GET', `${prPath(FAKE_PRS.purged)}/compare?from=0&to=3`);
        expect(full.stats).toEqual({ files: 1, added: 2, removed: 0 });
        const thread = pr.threads.find((t) => t.path === 'src/Purged.ts');
        expect(full.files[0]?.threads.find((p) => p.threadId === thread?.id)).toMatchObject({ line: null, moved: false });
    });

    it('version erased after being cached, then a new push: summary 200 without it, comparison 410', async () => {
        const current = await setup();
        const route = prPath(FAKE_PRS.mine);
        expect((await api<Summary>('GET', `${route}/summary`)).body.versions.map((s) => s.kind)).toEqual(['creation', 'code']);
        const v2 = (await detail(FAKE_PRS.mine)).versions[1]?.hash ?? '';
        // Later: Bitbucket erases v2 (overwritten by a force-push), the author pushes v3; v2's commit stays in the disk cache.
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

    it('erased version detected while another becomes readable on reload: no wrongful 410', async () => {
        const current = await setup();
        const route = prPath(FAKE_PRS.mine);
        await api('GET', `${route}/summary`);
        current.fake.data.repo.commits.delete((await detail(FAKE_PRS.mine)).versions[1]?.hash ?? '');
        pushVersion(current.fake.data, FAKE_PRS.mine, {
            commit: 'mine:v3', from: 'mine:v1', base: 'mine:m0', changes: { 'src/mine.ts': 'x\ny1\ny2\ny3\n' }, date: '2026-10-20T09:00:00Z',
        });
        pushVersion(current.fake.data, FAKE_PRS.mine, {
            commit: 'mine:v4', from: 'mine:v3', base: 'mine:m0', changes: { 'src/mine.ts': 'x\ny1\ny2\ny3\ny4\n' }, date: '2026-10-21T09:00:00Z',
        });
        // The commit of v4 answers 404 on the first load only: like a push that arrived between the two loads,
        // the reload counts one more readable version at the same time as v2 becomes unavailable.
        const v4 = current.fake.data.prs.get(FAKE_PRS.mine)?.pr.source?.commit?.hash ?? '';
        let pending = true;
        await restart(current, async (input, init) => {
            if (pending && String(input).endsWith(`/commit/${v4}`)) {
                pending = false;
                return new Response(JSON.stringify({ error: { message: 'not yet' } }), { status: 404, headers: { 'content-type': 'application/json' } });
            }
            return fetch(input, init);
        });

        const summary = await api<Summary>('GET', `${route}/summary`);
        expect(summary.status).toBe(200);
        expect(summary.body.versions.map((s) => [s.kind, s.since ?? null])).toEqual([['creation', null], ['unavailable', null], ['code', 1], ['code', null]]);
    });

    it('file absent from a still-readable version (added across a rebase): normal comparison', async () => {
        const { fake } = await setup();
        pushVersion(fake.data, FAKE_PRS.rebaseOnly, {
            commit: 'rebase:v3', from: 'rebase:v2', base: 'rebase:m1', changes: { 'src/Extra.ts': 'e\n' }, date: '2026-10-06T09:00:00Z',
        });
        const { status, body } = await api<Comparison>('GET', `${prPath(FAKE_PRS.rebaseOnly)}/compare?from=1&to=3`);
        expect(status).toBe(200);
        expect(body.files.map((f) => `${f.status}:${f.path}`)).toEqual(['added:src/Extra.ts']);
        expect((await detail(FAKE_PRS.rebaseOnly)).versions.every((v) => v.available)).toBe(true);
    });

    it('version erased after being cached: content returning 404 makes it unavailable (410), no file lost', async () => {
        const { fake } = await setup();
        await api('GET', `${prPath()}/summary`);
        // Diffstat of v2 cached, but not tests/ActionSpec.ts at v2: its content is requested from Bitbucket.
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
    it('reply, comment inline, resolve, approve', async () => {
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

    it('a reply does not advance the last review', async () => {
        await setup();
        const thread = (await detail()).threads.find((t) => t.path === 'src/Action.ts' && !t.resolved);
        await api('POST', `${prPath()}/comments`, { raw: 'Merci !', parentId: thread?.id });
        expect((await detail()).review.lastReviewed).toBe(2);
    });

    it('re-approve: the old approval is removed then put back (dated now)', async () => {
        const { fake } = await setup();
        await api('POST', `${prPath()}/approve`);
        await api('POST', `${prPath()}/approve`);
        expect(fake.calls.map(shortCall)).toEqual(['POST /approve', 'DELETE /approve', 'POST /approve']);
    });

    it('local state: seen files and "reviewed" mark persisted', async () => {
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

describe('home', () => {
    it('no tracked repository by default: empty home, no error', async () => {
        const { app } = await setup({ withToken: false });
        await app.settings.update({ email: FAKE_EMAIL, token: FAKE_TOKEN });
        expect((await api<Settings>('GET', '/api/settings')).body.repos).toEqual([]);
        const { body } = await api<Home>('GET', '/api/home');
        expect(body).toMatchObject({ repos: [], errors: [] });
        expect(body.groups.flatMap((g) => g.prs)).toEqual([]);
    });

    it('groups each PR by the review queue', async () => {
        await setup();
        // The type of #44's versions is only known once its summary is computed (PR opening).
        await api('GET', `${prPath(FAKE_PRS.rebaseOnly)}/summary`);
        const { body } = await api<Home>('GET', '/api/home');
        expect(body.me?.displayName).toBe('Thomas Girard');
        expect(body.repos).toEqual([`${WS}/${REPO}`]);
        expect(body.errors).toEqual([]);
        expect(body.truncated).toEqual([]);
        expect(groupsOf(body)).toEqual({
            // Designated reviewer without a current approval.
            [FAKE_PRS.main]: 'to-do',
            [FAKE_PRS.long]: 'to-do',
            [FAKE_PRS.rebaseOnly]: 'to-do',
            [FAKE_PRS.mine]: 'mine',
            [FAKE_PRS.neverReviewed]: 'to-do',
            // Not about me, minimum of 2 approvals reached.
            [FAKE_PRS.others]: 'others',
            [FAKE_PRS.purged]: 'to-do',
            // Approved on its latest version: nothing to do until the author pushes.
            [FAKE_PRS.waiting]: 'waiting',
        });
        expect(cardOf(body, FAKE_PRS.main)).toMatchObject({
            versionsCount: 6, lastReviewed: 2, newVersions: 4, approvals: 1, requiredApprovals: 2, newComments: 2,
            needsReview: true, designatedReviewer: true, followed: false, approvalHolds: false, build: expect.objectContaining({ state: 'failed' }), needsRebase: null,
        });
        // My approval counts towards the minimum, the author's could not.
        expect(cardOf(body, FAKE_PRS.main)?.head).toMatch(/^[0-9a-f]{12}$/);
        expect(cardOf(body, FAKE_PRS.long)).toMatchObject({ lastReviewed: 30, newVersions: 4, myApproval: true, approvals: 1, approvalHolds: false });
        expect(cardOf(body, FAKE_PRS.rebaseOnly)).toMatchObject({ lastReviewed: 1, newVersions: 1, newCodeVersions: 0 });
        expect(cardOf(body, FAKE_PRS.mine)).toMatchObject({ approvals: 1, needsReview: true, designatedReviewer: false, needsRebase: true });
        expect(cardOf(body, FAKE_PRS.neverReviewed)).toMatchObject({ lastReviewed: null, newVersions: 2 });
        expect(cardOf(body, FAKE_PRS.others)).toMatchObject({ versionsCount: null, lastReviewed: null, approvals: 2, needsReview: false, designatedReviewer: false });
    });

    it('needs approvals: 2 out of 2 is "others", 1 is "to-do", even for a PR that does not concern me', async () => {
        const { fake } = await setup();
        let { body } = await api<Home>('GET', '/api/home');
        expect(groupsOf(body)[FAKE_PRS.others]).toBe('others');
        expect(cardOf(body, FAKE_PRS.others)).toMatchObject({ approvals: 2, requiredApprovals: 2, needsReview: false, versionsCount: null });

        const bot = fake.data.prs.get(FAKE_PRS.others)?.pr.participants.find((p) => p.user?.uuid === '{ai}');
        Object.assign(bot!, { approved: false, state: null });
        ({ body } = await api<Home>('GET', '/api/home?fresh=1'));
        expect(groupsOf(body)[FAKE_PRS.others]).toBe('to-do');
        expect(cardOf(body, FAKE_PRS.others)).toMatchObject({ approvals: 1, needsReview: true, versionsCount: null });
    });

    it('designated reviewer: "to-do" until I approve, even once the minimum is reached', async () => {
        const { fake } = await setup();
        fake.data.prs.get(FAKE_PRS.neverReviewed)!.pr.participants.push(
            { user: { uuid: '{cam}', display_name: 'Camille Durand' }, role: 'PARTICIPANT', approved: true, state: 'approved' },
            { user: { uuid: '{ai}', display_name: 'review-bot' }, role: 'PARTICIPANT', approved: true, state: 'approved' },
        );
        const { body } = await api<Home>('GET', '/api/home');
        expect(groupsOf(body)[FAKE_PRS.neverReviewed]).toBe('to-do');
        expect(cardOf(body, FAKE_PRS.neverReviewed)).toMatchObject({ approvals: 2, needsReview: false, designatedReviewer: true });
    });

    it('opening a PR that does not concern me does not change its group', async () => {
        await setup();
        await detail(FAKE_PRS.others);
        const { body } = await api<Home>('GET', '/api/home');
        expect(body.groups.find((g) => g.key === 'others')?.prs.map((p) => p.id)).toEqual([FAKE_PRS.others]);
    });

    it('reviewed up to the latest version: "waiting", unless I am a designated reviewer who has not approved', async () => {
        await setup();
        await api('POST', `${prPath(FAKE_PRS.others)}/reviewed`, { version: 1 });
        await api('POST', `${prPath()}/reviewed`, { version: 6 });
        const { body } = await api<Home>('GET', '/api/home');
        expect(groupsOf(body)[FAKE_PRS.others]).toBe('waiting');
        expect(cardOf(body, FAKE_PRS.others)).toMatchObject({ lastReviewed: 1, newVersions: 0, newCodeVersions: 0 });
        expect(groupsOf(body)[FAKE_PRS.main]).toBe('to-do');
    });

    it('only rebases since my approval, which Bitbucket kept: "waiting", no re-approval', async () => {
        const { fake } = await setup();
        const me = fake.data.prs.get(FAKE_PRS.rebaseOnly)?.pr.participants.find((p) => p.user?.uuid === '{me}');
        expect(me).toBeTruthy();
        Object.assign(me!, { approved: true, state: 'approved' });
        await api('GET', `${prPath(FAKE_PRS.rebaseOnly)}/summary`);
        const { body } = await api<Home>('GET', '/api/home');
        expect(groupsOf(body)[FAKE_PRS.rebaseOnly]).toBe('waiting');
        expect(cardOf(body, FAKE_PRS.rebaseOnly)).toMatchObject({ myApproval: true, approvalHolds: true, designatedReviewer: true, newVersions: 1, newCodeVersions: 0 });
    });

    it('build state only for "to-do" and "mine" cards, needs-rebase only for mine', async () => {
        await setup();
        const { body } = await api<Home>('GET', '/api/home');
        expect(cardOf(body, 42)).toMatchObject({ build: expect.objectContaining({ state: 'failed' }), needsRebase: null });
        expect(cardOf(body, FAKE_PRS.mine)).toMatchObject({ build: { state: 'running', failed: 0, running: 1, total: 2 }, needsRebase: true });
        expect(cardOf(body, FAKE_PRS.rebaseOnly)).toMatchObject({ build: { state: 'none', total: 0 }, needsRebase: null });
        expect(cardOf(body, FAKE_PRS.others)).toMatchObject({ build: null, needsRebase: null });
    });

    it('mine: needs-rebase is false once master is back on the PR base', async () => {
        const { fake } = await setup();
        expect(cardOf((await api<Home>('GET', '/api/home')).body, FAKE_PRS.mine)?.needsRebase).toBe(true);
        const mineHead = fake.data.prs.get(FAKE_PRS.mine)?.pr.source?.commit?.hash ?? '';
        const baseKey = [...fake.data.mergeBases.keys()].find((k) => k.startsWith(mineHead));
        const base = baseKey ? fake.data.mergeBases.get(baseKey) : undefined;
        expect(base).toBeTruthy();
        fake.data.branchHeads.set('master', base ?? '');
        fake.data.mergeBases.set(`${mineHead}..${base}`, base ?? '');
        const { body } = await api<Home>('GET', '/api/home?fresh=1');
        expect(cardOf(body, FAKE_PRS.mine)?.needsRebase).toBe(false);
    });

    it('a statuses failure leaves build null and the home still loads', async () => {
        const { fake } = await setup();
        fake.data.statusesFailure = 403;
        const { status, body } = await api<Home>('GET', '/api/home');
        expect(status).toBe(200);
        expect(body.errors).toEqual([]);
        expect(body.groups.flatMap((g) => g.prs).every((p) => p.build === null)).toBe(true);
        expect(cardOf(body, FAKE_PRS.mine)?.needsRebase).toBe(true);
    });

    it('PR detail carries the build checks and needs-rebase (mine only)', async () => {
        await setup();
        const mine = await detail(FAKE_PRS.mine);
        expect(mine.needsRebase).toBe(true);
        expect(mine.build?.map((c) => c.state).sort()).toEqual(['running', 'success']);
        const failed = await detail(42);
        expect(failed.needsRebase).toBeNull();
        expect(failed.build?.map((c) => c.state).sort()).toEqual(['failed', 'success']);
        expect((await detail(FAKE_PRS.others)).build).toEqual([]);
    });

    it('M1: "needs rebase" only on an open PR: a merged PR of mine gets null, with no branch-head read', async () => {
        const { fake } = await setup();
        fake.data.prs.get(FAKE_PRS.mine)!.pr.state = 'MERGED';
        const body = await detail(FAKE_PRS.mine);
        expect(body.pr.state).toBe('MERGED');
        expect(body.needsRebase).toBeNull();
        expect(fake.requests.filter((r) => r.path.includes('/refs/branches/'))).toEqual([]);
        // The home asks for open PRs only; a closed one in the answer is not flagged either.
        expect(cardOf((await api<Home>('GET', '/api/home')).body, FAKE_PRS.mine)?.needsRebase).toBeNull();
    });

    it('PR detail: unreadable statuses give build null, unlike "no build" ([])', async () => {
        const { fake } = await setup();
        fake.data.statusesFailure = 403;
        const { status, body } = await api<PrDetail>('GET', prPath(FAKE_PRS.mine));
        expect(status).toBe(200);
        expect(body.build).toBeNull();
        expect(body.needsRebase).toBe(true);
    });

    it('cards of a followed author are marked followed, at once after the settings change', async () => {
        await setup();
        let { body } = await api<Home>('GET', '/api/home');
        expect(body.groups.flatMap((g) => g.prs).some((p) => p.followed)).toBe(false);
        const put = await api<Settings>('PUT', '/api/settings', { review: { followed: [{ uuid: '{yan}', displayName: 'Yann Bernard' }] } });
        expect(put.status).toBe(200);
        ({ body } = await api<Home>('GET', '/api/home'));
        const cards = body.groups.flatMap((g) => g.prs);
        expect(cards.filter((p) => p.followed).map((p) => p.id).sort()).toEqual(
            cards.filter((p) => p.author?.uuid === '{yan}').map((p) => p.id).sort(),
        );
        expect(cardOf(body, FAKE_PRS.neverReviewed)?.followed).toBe(true);
        expect(cardOf(body, FAKE_PRS.main)?.followed).toBe(false);
    });

    it('GET /api/settings/followed: the followed list alone, without Bitbucket', async () => {
        const { fake } = await setup();
        expect((await api<FollowedList>('GET', '/api/settings/followed')).body).toEqual({ followed: [] });
        await api('PUT', '/api/settings', { review: { followed: [{ uuid: '{yan}', displayName: 'Yann Bernard' }] } });
        await fake.close(); // Bitbucket unreachable: the list is local
        const { status, body } = await api<FollowedList>('GET', '/api/settings/followed');
        expect(status).toBe(200);
        expect(body).toEqual({ followed: [{ uuid: '{yan}', displayName: 'Yann Bernard' }] });
    });

    it('me unknown (token without read:user): every PR in "others", no history loaded, no error', async () => {
        const current = await setup();
        await restart(current);
        await fetch(`http://127.0.0.1:${current.fake.port}/__fail-next?status=403`);
        const { status, body } = await api<Home>('GET', '/api/home');
        expect(status).toBe(200);
        expect(body.me).toBeNull();
        expect(body.errors).toEqual([]);
        expect(new Set(Object.values(groupsOf(body)))).toEqual(new Set(['others']));
        expect(Object.keys(groupsOf(body))).toHaveLength(Object.keys(FAKE_PRS).length);
        expect(body.groups.flatMap((g) => g.prs).every((p) => p.versionsCount === null && !p.myApproval && !p.designatedReviewer)).toBe(true);
    });
});

describe('request budget', () => {
    const MINUTE_MS = 60_000;
    /** Default refresh interval of the background poll (review.refreshMinutes). */
    const INTERVAL_MS = 5 * MINUTE_MS;
    const ME = { uuid: '{me}', display_name: 'Thomas Girard', nickname: 'tgirard' };
    const MASTER_HEAD = (): string => env?.fake.data.branchHeads.get('master') ?? '';

    /**
     * "list", "user", "refs" or the PR sub-resource ("activity"...), with the PR id when there is one; the statuses of a
     * PR's head commit are "statuses #id".
     */
    function label({ path: route, page }: RecordedRequest): string {
        const rest = route.replace(/^\/2\.0\/repositories\/[^/]+\/[^/]+/, '');
        if (route === '/2.0/user') {
            return 'user';
        }
        if (rest === '/pullrequests') {
            return `list p${page}`;
        }
        const statuses = /^\/commit\/([0-9a-f]+)\/statuses$/.exec(rest);
        if (statuses) {
            const owner = [...env?.fake.data.prs.values() ?? []].find((p) => p.pr.source?.commit?.hash === statuses[1]);
            return `statuses #${owner?.pr.id ?? statuses[1]}`;
        }
        const pr = /^\/pullrequests\/(\d+)(?:\/([a-z-]+))?/.exec(rest);
        if (pr) {
            return `${pr[2] ?? 'pr'} #${pr[1]}${page > 1 ? ` p${page}` : ''}`;
        }
        return rest.split('/')[1] ?? rest;
    }

    /** Requests the fake Bitbucket answered while `run` ran. */
    async function requestsOf(run: () => Promise<unknown>): Promise<RecordedRequest[]> {
        const start = env?.fake.requests.length ?? 0;
        await run();
        return env?.fake.requests.slice(start) ?? [];
    }

    const labels = (list: RecordedRequest[]): string[] => list.map(label).sort();
    const home = async (route = '/api/home'): Promise<Home> => (await api<Home>('GET', route)).body;
    /** Time goes by (only Date is faked: the HTTP servers keep their real timers). */
    const elapse = (ms: number): void => {
        vi.setSystemTime(new Date(Date.now() + ms));
    };
    const fakeTime = (): void => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-11-10T09:00:00Z'));
    };

    it('(a) steady state within the interval: nothing changed, every 60 s TTL expired: one list request per repository page', async () => {
        fakeTime();
        await setup();
        const first = await home();
        // Beyond the 60 s live TTLs and the cross-window reuse (half the interval), within one refresh interval.
        elapse(3 * MINUTE_MS);
        let second: Home | null = null;
        const spent = await requestsOf(async () => {
            second = await home();
        });
        expect(labels(spent)).toEqual(['list p1']);
        expect(second).toEqual(first);
    });

    it('(a) steady state at the next interval: the lists, one branch head per repository with my PRs, the running build only', async () => {
        fakeTime();
        await setup();
        const first = await home();
        elapse(INTERVAL_MS + 1000);
        let second: Home | null = null;
        const spent = await requestsOf(async () => {
            second = await home();
        });
        // Old heads without any status (#43, #44, #46, #48) and the failed build (#42) are settled: not read again.
        expect(labels(spent)).toEqual(['list p1', 'refs', `statuses #${FAKE_PRS.mine}`]);
        expect(second).toEqual(first);
    });

    it('(b) after a push on one PR: only that PR\'s data is fetched again, plus the lists', async () => {
        fakeTime();
        const { fake } = await setup();
        await home();
        pushVersion(fake.data, FAKE_PRS.purged, {
            commit: 'purged:v4', from: 'purged:v3', base: 'purged:m0', changes: { 'src/Purged.ts': 'a\nb\nv2\nv3\nv4\n' }, date: '2026-10-22T09:00:00Z',
        });
        elapse(3 * MINUTE_MS);
        let after: Home | null = null;
        const spent = await requestsOf(async () => {
            after = await home();
        });
        const others = spent.filter((r) => !label(r).startsWith('list '));
        expect(others.length).toBeGreaterThan(0);
        expect(labels(others).filter((l) => !new RegExp(`#${FAKE_PRS.purged}( p\\d+)?$`).test(l))).toEqual([]);
        expect(labels(others)).toContain(`statuses #${FAKE_PRS.purged}`);
        expect(cardOf(after!, FAKE_PRS.purged)).toMatchObject({ versionsCount: 4, head: fake.data.prs.get(FAKE_PRS.purged)?.pr.source?.commit?.hash });
    });

    it('(c) builds: a running build (or none yet on a recent push) is re-read once per interval; failed, successful or none on an old push never again', async () => {
        fakeTime();
        const { fake } = await setup();
        const neverHead = [...fake.data.repo.commits.keys()].find((k) => k.startsWith(fake.data.prs.get(FAKE_PRS.neverReviewed)?.pr.source?.commit?.hash ?? '-')) ?? '';
        fake.data.statuses.set(FAKE_PRS.neverReviewed, [{ key: 'pipeline', name: 'Pipeline', state: 'SUCCESSFUL', commit: { hash: neverHead }, updated_on: '2026-10-21T09:00:00Z' }]);
        const first = await home();
        expect(cardOf(first, FAKE_PRS.neverReviewed)?.build?.state).toBe('success');
        elapse(INTERVAL_MS + 1000);
        const spent = labels(await requestsOf(home)).filter((l) => l.startsWith('statuses'));
        expect(spent).toContain(`statuses #${FAKE_PRS.mine}`);
        // No status at all on a head pushed more than an hour ago: settled as none.
        expect(spent).not.toContain(`statuses #${FAKE_PRS.long}`);
        expect(spent).not.toContain(`statuses #${FAKE_PRS.main}`);
        expect(spent).not.toContain(`statuses #${FAKE_PRS.neverReviewed}`);
        // Once the running check finished, the next cycle sees it; then it is settled for good.
        fake.data.statuses.set(FAKE_PRS.mine, (fake.data.statuses.get(FAKE_PRS.mine) ?? []).map((s) => ({ ...s, state: 'FAILED' as const })));
        elapse(INTERVAL_MS + 1000);
        expect(cardOf(await home(), FAKE_PRS.mine)?.build?.state).toBe('failed');
        elapse(INTERVAL_MS + 1000);
        expect(labels(await requestsOf(home))).not.toContain(`statuses #${FAKE_PRS.mine}`);
    });

    it('(d) two windows on one profile: the second reuses the home the first just computed, with no Bitbucket call', async () => {
        fakeTime();
        const current = await setup();
        const second = await startRevspan(current.dir, current.fake);
        try {
            const first = await home();
            elapse(MINUTE_MS + 1000);
            let reused: unknown = null;
            const spent = await requestsOf(async () => {
                reused = await (await fetch(`${second.url}/api/home`)).json();
            });
            expect(spent).toEqual([]);
            expect(reused).toEqual(first);
            // The explicit Refresh bypasses the shared home.
            const refreshed = await requestsOf(() => fetch(`${second.url}/api/home?fresh=1`).then((r) => r.json()));
            expect(labels(refreshed)).toContain('list p1');
        } finally {
            await second.close();
        }
    });

    it('(d) two windows computing at the same time: one of them computes, the other waits for its home', async () => {
        fakeTime();
        const current = await setup();
        await restart(current);
        const second = await startRevspan(current.dir, current.fake);
        try {
            const spent = await requestsOf(() => Promise.all([home(), fetch(`${second.url}/api/home`).then((r) => r.json())]));
            expect(labels(spent).filter((l) => l.startsWith('list '))).toEqual(['list p1']);
        } finally {
            await second.close();
        }
    });

    it('(e) several PRs of mine in one repository share a single branch-head read', async () => {
        fakeTime();
        const { fake } = await setup();
        for (const id of [FAKE_PRS.neverReviewed, FAKE_PRS.others, FAKE_PRS.waiting]) {
            fake.data.prs.get(id)!.pr.author = ME;
        }
        const first = await home();
        expect(first.groups.find((g) => g.key === 'mine')?.prs.length).toBeGreaterThanOrEqual(4);
        const refs = (list: RecordedRequest[]): number => list.filter((r) => r.path.includes('/refs/branches/')).length;
        expect(refs(fake.requests)).toBe(1);
        elapse(INTERVAL_MS + 1000);
        expect(refs(await requestsOf(home))).toBe(1);
    });

    it('explicit Refresh: lists, unsettled builds and branch heads only; it shows what changed', async () => {
        fakeTime();
        const { fake } = await setup();
        await home();
        fake.data.statuses.set(FAKE_PRS.mine, (fake.data.statuses.get(FAKE_PRS.mine) ?? []).map((s) => ({ ...s, state: 'FAILED' as const })));
        let refreshed: Home | null = null;
        const spent = labels(await requestsOf(async () => {
            refreshed = await home('/api/home?fresh=1');
        }));
        expect(cardOf(refreshed!, FAKE_PRS.mine)?.build?.state).toBe('failed');
        expect(spent.filter((l) => l.startsWith('activity') || l === 'merge-base')).toEqual([]);
        expect(spent).not.toContain(`statuses #${FAKE_PRS.main}`);
        expect(spent).toEqual(expect.arrayContaining(['list p1', 'refs', `statuses #${FAKE_PRS.mine}`]));
    });

    it('I2: explicit Refresh re-reads the settled checks of my PRs (a re-run on the same commit), not those of the others', async () => {
        fakeTime();
        const { fake } = await setup();
        const success = (fake.data.statuses.get(FAKE_PRS.mine) ?? []).map((s) => ({ ...s, state: 'SUCCESSFUL' as const }));
        fake.data.statuses.set(FAKE_PRS.mine, success);
        expect(cardOf(await home(), FAKE_PRS.mine)?.build?.state).toBe('success');
        // A re-run on the same (old) commit: the settled checks are kept by a normal computation.
        fake.data.statuses.set(FAKE_PRS.mine, success.map((s) => ({ ...s, state: 'INPROGRESS' as const })));
        elapse(INTERVAL_MS + 1000);
        expect(cardOf(await home(), FAKE_PRS.mine)?.build?.state).toBe('success');
        let refreshed: Home | null = null;
        const spent = labels(await requestsOf(async () => {
            refreshed = await home('/api/home?fresh=1');
        }));
        expect(cardOf(refreshed!, FAKE_PRS.mine)?.build?.state).toBe('running');
        expect(spent).not.toContain(`statuses #${FAKE_PRS.main}`);
    });

    it('a new push is seen by the next computation after the shared reuse, without Refresh', async () => {
        fakeTime();
        const { fake } = await setup();
        await home();
        pushVersion(fake.data, FAKE_PRS.purged, { commit: 'purged:v4', from: 'purged:v3', base: 'purged:m0', changes: {}, date: '2026-10-22T09:00:00Z' });
        elapse(INTERVAL_MS / 2 + 1000);
        expect(cardOf(await home(), FAKE_PRS.purged)?.versionsCount).toBe(4);
    });

    it('a write while a computation is in flight: its pre-write home is not shared, the next read computes again', async () => {
        fakeTime();
        const { fake, app } = await setup();
        await home();
        elapse(INTERVAL_MS + 1000);
        let release = (): void => undefined;
        fake.data.holdList = new Promise<void>((resolve) => {
            release = resolve;
        });
        const inFlight = home();
        await vi.waitFor(() => expect(fake.requests.filter((r) => r.path.endsWith('/pullrequests'))).toHaveLength(2));
        await api('DELETE', `${prPath(FAKE_PRS.waiting)}/approve`);
        delete fake.data.holdList;
        release();
        expect(cardOf(await inFlight, FAKE_PRS.waiting)?.myApproval).toBe(true);
        expect(app.store.homeSnapshot()).toBeNull();
        expect(cardOf(await home(), FAKE_PRS.waiting)?.myApproval).toBe(false);
    });

    it('an activity lagging behind the list (my approval missing) is not kept: the next computation reads it again', async () => {
        fakeTime();
        const { fake } = await setup();
        await home();
        const me = fake.data.prs.get(FAKE_PRS.neverReviewed)!.pr.participants.find((p) => p.user?.uuid === '{me}');
        Object.assign(me!, { approved: true, state: 'approved' });
        elapse(3 * MINUTE_MS);
        expect(labels(await requestsOf(home))).toContain(`activity #${FAKE_PRS.neverReviewed}`);
        // The replica caught up: the activity has the approval, it is kept.
        fake.data.prs.get(FAKE_PRS.neverReviewed)!.activity.push({ approval: { date: '2026-11-01T09:00:00Z', user: { uuid: '{me}' } } });
        elapse(3 * MINUTE_MS);
        expect(labels(await requestsOf(home))).toContain(`activity #${FAKE_PRS.neverReviewed}`);
        elapse(3 * MINUTE_MS);
        expect(labels(await requestsOf(home))).not.toContain(`activity #${FAKE_PRS.neverReviewed}`);
    });

    it('an activity that never matches the list is kept on its second read under the same list: one extra read at most', async () => {
        fakeTime();
        const { fake } = await setup();
        await home();
        const me = fake.data.prs.get(FAKE_PRS.neverReviewed)!.pr.participants.find((p) => p.user?.uuid === '{me}');
        Object.assign(me!, { approved: true, state: 'approved' });
        elapse(3 * MINUTE_MS);
        expect(labels(await requestsOf(home))).toContain(`activity #${FAKE_PRS.neverReviewed}`);
        elapse(3 * MINUTE_MS);
        expect(labels(await requestsOf(home))).toContain(`activity #${FAKE_PRS.neverReviewed}`);
        elapse(3 * MINUTE_MS);
        expect(labels(await requestsOf(home))).not.toContain(`activity #${FAKE_PRS.neverReviewed}`);
    });

    it('deleted comments count towards comment_count: such an activity is kept at once', async () => {
        fakeTime();
        const { fake } = await setup();
        const main = fake.data.prs.get(FAKE_PRS.main)!;
        const deleted = main.comments[0]!;
        deleted.deleted = true;
        main.pr.comment_count = main.comments.length;
        await home();
        elapse(3 * MINUTE_MS);
        expect(labels(await requestsOf(home))).not.toContain(`activity #${FAKE_PRS.main}`);
    });

    it('a home with an unreadable repository is computed once per poll: the tree refresh right after reuses it', async () => {
        fakeTime();
        await setup();
        await api('PUT', '/api/settings', { repos: [`${WS}/${REPO}`, `${WS}/missing-repo`] });
        expect((await home()).errors).toHaveLength(1);
        expect(await requestsOf(home)).toEqual([]);
    });

    it('one kept activity per PR: a new push replaces it', async () => {
        fakeTime();
        const { fake, dir } = await setup();
        await home();
        pushVersion(fake.data, FAKE_PRS.purged, { commit: 'purged:v4', from: 'purged:v3', base: 'purged:m0', changes: {}, date: '2026-10-22T09:00:00Z' });
        elapse(3 * MINUTE_MS);
        await home();
        const kept = new Cache(path.join(dir, 'cache')).get<{ key: string }>(`home-activity:2:${WS}/${REPO}#${FAKE_PRS.purged}`);
        expect(kept?.key).toContain(fake.data.prs.get(FAKE_PRS.purged)?.pr.source?.commit?.hash);
    });

    it('M6: a home with a repository error is shared with the other windows for 60 s only, then computed again', async () => {
        fakeTime();
        const current = await setup();
        await api('PUT', '/api/settings', { repos: [`${WS}/${REPO}`, `${WS}/missing-repo`] });
        const first = await home();
        expect(first.errors).toHaveLength(1);
        const second = await startRevspan(current.dir, current.fake);
        try {
            const other = async (): Promise<Home> => (await fetch(`${second.url}/api/home`)).json() as Promise<Home>;
            await (await fetch(`${second.url}/api/settings`)).json();
            elapse(50_000);
            let reused: Home | null = null;
            expect(await requestsOf(async () => {
                reused = await other();
            })).toEqual([]);
            expect(reused).toEqual(first);
            // Past 60 s the error is tried again, by any window, well before half an interval.
            elapse(11_000);
            expect(labels(await requestsOf(other))).toContain('list p1');
            elapse(1000);
            expect(await requestsOf(home)).toEqual([]);
        } finally {
            await second.close();
        }
    });

    it('a home without my profile is not shared with the other windows', async () => {
        fakeTime();
        const current = await setup();
        await restart(current);
        await fetch(`http://127.0.0.1:${current.fake.port}/__fail-next?status=403`);
        expect((await home()).me).toBeNull();
        expect(current.app.store.homeSnapshot()).toBeNull();
    });

    it('a write on a PR drops the shared home: the next read shows it at once', async () => {
        fakeTime();
        await setup();
        expect(cardOf(await home(), FAKE_PRS.waiting)?.myApproval).toBe(true);
        await api('DELETE', `${prPath(FAKE_PRS.waiting)}/approve`);
        expect(cardOf(await home(), FAKE_PRS.waiting)?.myApproval).toBe(false);
    });

    it('marking files viewed (frequent while reviewing) does not recompute the home; a "reviewed" mark does', async () => {
        fakeTime();
        await setup();
        await home();
        const viewed = await requestsOf(async () => {
            await api('POST', `${prPath()}/viewed`, { path: 'src/Action.ts', contentHash: 'abc', viewed: true });
            await home();
        });
        expect(viewed).toEqual([]);
        await api('POST', `${prPath(FAKE_PRS.others)}/reviewed`, { version: 1 });
        expect(cardOf(await home(), FAKE_PRS.others)?.lastReviewed).toBe(1);
    });

    it('a comment written from Revspan shows on the home at once, even if Bitbucket keeps updated_on', async () => {
        fakeTime();
        const { fake } = await setup();
        expect(cardOf(await home(), FAKE_PRS.neverReviewed)?.lastReviewed).toBeNull();
        const updatedOn = fake.data.prs.get(FAKE_PRS.neverReviewed)?.pr.updated_on;
        await api('POST', `${prPath(FAKE_PRS.neverReviewed)}/comments`, { raw: 'Looks good' });
        expect(fake.data.prs.get(FAKE_PRS.neverReviewed)?.pr.updated_on).toBe(updatedOn);
        expect(cardOf(await home(), FAKE_PRS.neverReviewed)?.lastReviewed).toBe(2);
    });

    it('PR summary, comparison and "reviewed" mark read no build status, branch head or rebase merge base', async () => {
        await setup();
        const spent = await requestsOf(async () => {
            await api('GET', `${prPath(FAKE_PRS.mine)}/summary`);
            await api('GET', `${prPath(FAKE_PRS.mine)}/compare?from=1&to=2`);
            await api('POST', `${prPath(FAKE_PRS.mine)}/reviewed`, { version: 2 });
        });
        expect(labels(spent).filter((l) => l.startsWith('statuses') || l === 'refs')).toEqual([]);
        expect(spent.filter((r) => r.path.endsWith(`..${MASTER_HEAD()}`))).toEqual([]);
        // The detail still carries them.
        const detailSpent = labels(await requestsOf(() => detail(FAKE_PRS.mine)));
        expect(detailSpent).toEqual(expect.arrayContaining([`statuses #${FAKE_PRS.mine}`, 'refs']));
    });

    it('settings: following someone keeps the session and its caches; a new token resets them', async () => {
        await setup();
        await home();
        const follow = await requestsOf(async () => {
            await api('PUT', '/api/settings', { review: { followed: [{ uuid: '{yan}', displayName: 'Yann Bernard' }] } });
            await home();
        });
        expect(labels(follow)).toEqual(['list p1']);
        const token = await requestsOf(() => api('PUT', '/api/settings', { token: FAKE_TOKEN }));
        expect(labels(token)).toContain('user');
    });
});
