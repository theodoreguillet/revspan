// Extension bridge: the in-memory HTTP application (as in VS Code) wired to the fake Bitbucket,
// and the panel that serves it to the page (VS Code simulated by test/support/fake-vscode.ts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import type * as vscode from 'vscode';
import type { ApiErrorBody, PrDetail, Settings } from '../../src/shared/api.ts';
import { createHttpApp } from '../../src/server/http/app.ts';
import { Cache } from '../../src/server/infra/cache.ts';
import { Store } from '../../src/server/infra/config.ts';
import { createSecretStore } from '../../src/server/infra/secrets.ts';
import { createServices, type Services } from '../../src/server/services/index.ts';
import { vscodeReviewSource } from '../../src/extension/app-context.ts';
import { IN_MEMORY_HOST, callApi, isSuccessfulWrite } from '../../src/extension/lib/bridge.ts';
import type { DiffDocuments } from '../../src/extension/diff-documents.ts';
import { HomeTreeProvider, showLoading } from '../../src/extension/home-tree-provider.ts';
import { RevspanPanel } from '../../src/extension/panel.ts';
import { FAKE_EMAIL, FAKE_PRS, FAKE_TOKEN, REPO, WS, startFakeBitbucket, type FakeBitbucket } from '../support/fake-bitbucket.ts';
import { ConfigurationTarget, FakeWebviewPanel, Uri, dormantTab, env, recorded, resetFakeVscode, settingWrites, unregisteredSettings, window, workspace } from '../support/fake-vscode.ts';

vi.mock('vscode', () => import('../support/fake-vscode.ts'));

let fake: FakeBitbucket;
let dir: string;
let services: Services;
let http: Hono;

beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revspan-ext-'));
    fake = await startFakeBitbucket();
    const store = new Store(dir);
    const secrets = await createSecretStore({ dir, env: { REVSPAN_TOKEN_STORE: 'file' } });
    services = createServices({ store, secrets, cache: new Cache(path.join(dir, 'cache')), baseUrl: fake.url });
    await services.settings.update({ email: FAKE_EMAIL, token: FAKE_TOKEN, repos: [`${WS}/${REPO}`] });
    http = createHttpApp({ version: 'test', settings: services.settings, home: services.home, prs: services.prs, allowedHosts: () => [IN_MEMORY_HOST] });
});

afterEach(async () => {
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const PR = `/api/pr/${WS}/${REPO}/${FAKE_PRS.main}`;

describe('extension bridge (in-memory HTTP application)', () => {
    it('read: same response as over HTTP', async () => {
        const result = await callApi(http, { method: 'GET', path: PR });
        expect(result.status).toBe(200);
        expect((result.body as PrDetail).versions).toHaveLength(6);
    });

    it('write: the mutation header is added by the bridge, the call reaches Bitbucket', async () => {
        const thread = ((await callApi(http, { method: 'GET', path: PR })).body as PrDetail).threads[0];
        const call = { method: 'POST', path: `${PR}/comments`, body: { raw: 'Depuis VS Code', parentId: thread?.id } };
        const result = await callApi(http, call);
        expect(result.status).toBe(200);
        expect(isSuccessfulWrite(call, result)).toBe(true);
        expect(fake.calls.at(-1)?.body).toEqual({ content: { raw: 'Depuis VS Code' }, parent: { id: thread?.id } });
    });

    it('errors: validation (400) and path outside the API rejected', async () => {
        const invalid = await callApi(http, { method: 'POST', path: `${PR}/comments`, body: { raw: ' ' } });
        expect(invalid.status).toBe(400);
        expect(isSuccessfulWrite({ method: 'POST', path: '' }, invalid)).toBe(false);
        expect((await callApi(http, { method: 'GET', path: '/index.html' })).status).toBe(400);
        expect((await callApi(http, { method: 'PATCH', path: PR })).status).toBe(400);
    });

    it('the host check stays active for any other host', async () => {
        const response = await http.request(`http://evil.example${PR}`, { method: 'GET' });
        expect(response.status).toBe(403);
    });

    it('sides of a file for the diff editor (replayed across the rebase)', async () => {
        const sides = await services.prs.fileSides({ workspace: WS, repo: REPO, id: FAKE_PRS.main }, 2, 4, { path: 'package-lock.json', oldPath: null });
        expect(sides.oldText).toContain('1.0.0-rc.1');
        expect(sides.newText).toContain('1.0.0-rc.2');
    });
});

describe('review settings in the VS Code configuration', () => {
    const settings = (): vscode.WorkspaceConfiguration => workspace.getConfiguration('revspan') as unknown as vscode.WorkspaceConfiguration;

    /** The same assembly as the extension's, on the fake VS Code settings. */
    async function bridge(): Promise<{ http: Hono; store: Store }> {
        const store = new Store(path.join(dir, 'vscode-store'), { reviewSource: vscodeReviewSource() });
        const wired = createServices({ store, secrets: await createSecretStore({ dir, env: { REVSPAN_TOKEN_STORE: 'file' } }), cache: new Cache(path.join(dir, 'vscode-cache')), baseUrl: fake.url });
        return { store, http: createHttpApp({ version: 'test', settings: wired.settings, home: wired.home, prs: wired.prs, allowedHosts: () => [IN_MEMORY_HOST] }) };
    }

    beforeEach(() => resetFakeVscode());

    it('read from the settings (manifest defaults when untouched), invalid values normalized', async () => {
        const { http: app, store } = await bridge();
        expect(store.config.review).toMatchObject({ requiredApprovals: 2, refreshMinutes: 5, notifications: { newPullRequest: true, newVersion: true, buildFailed: false } });
        await settings().update('review.requiredApprovals', 0, ConfigurationTarget.Global);
        await settings().update('review.requiredApprovalsByRepository', { 'acme/records-api': 3, 'acme/bad': -1 }, ConfigurationTarget.Global);
        await settings().update('review.followedContributors', [{ uuid: '{cam}', displayName: 'Camille Durand' }, { uuid: '{cam}', displayName: 'Dup' }], ConfigurationTarget.Global);
        await settings().update('refreshIntervalMinutes', 15, ConfigurationTarget.Global);
        const result = await callApi(app, { method: 'GET', path: '/api/settings' });
        expect((result.body as Settings).review).toMatchObject({
            requiredApprovals: 2,
            requiredApprovalsByRepo: { 'acme/records-api': 3 },
            followed: [{ uuid: '{cam}', displayName: 'Camille Durand' }],
            refreshMinutes: 15,
        });
    });

    it('written to the settings, at the level that gives the effective value, only what changed', async () => {
        const { http: app } = await bridge();
        await settings().update('review.requiredApprovals', 4, ConfigurationTarget.Workspace);
        const put = await callApi(app, {
            method: 'PUT',
            path: '/api/settings',
            body: { review: { requiredApprovalsByRepo: { 'acme/records-api': 1 }, notifications: { buildFailed: true } } },
        });
        expect(put.status).toBe(200);
        expect((put.body as Settings).review).toMatchObject({ requiredApprovals: 4, requiredApprovalsByRepo: { 'acme/records-api': 1 }, notifications: { buildFailed: true, newVersion: true } });
        expect(settings().inspect('review.requiredApprovalsByRepository')?.globalValue).toEqual({ 'acme/records-api': 1 });
        expect(settings().inspect('notifications.buildFailed')?.globalValue).toBe(true);
        // Untouched settings are not written, and the workspace value was left alone.
        expect(settings().inspect('notifications.newVersion')?.globalValue).toBeUndefined();
        expect(settings().inspect('review.requiredApprovals')).toMatchObject({ workspaceValue: 4, globalValue: undefined });

        await callApi(app, { method: 'PUT', path: '/api/settings', body: { review: { requiredApprovals: 3 } } });
        expect(settings().inspect('review.requiredApprovals')).toMatchObject({ workspaceValue: 3, globalValue: undefined });
    });

    it('hideUnfollowed: on by default (manifest), read from and written to revspan.review.hideUnfollowed', async () => {
        const { http: app, store } = await bridge();
        expect(store.config.review.hideUnfollowed).toBe(true);
        const put = await callApi(app, { method: 'PUT', path: '/api/settings', body: { review: { hideUnfollowed: false } } });
        expect(put.status).toBe(200);
        expect((put.body as Settings).review.hideUnfollowed).toBe(false);
        expect(settings().inspect('review.hideUnfollowed')?.globalValue).toBe(false);
    });

    it('a setting VS Code does not know yet (updated, window not reloaded): SETTING_UNREGISTERED, not an internal error', async () => {
        const { http: app } = await bridge();
        unregisteredSettings.add('revspan.review.hideUnfollowed');
        const put = await callApi(app, { method: 'PUT', path: '/api/settings', body: { review: { hideUnfollowed: false } } });
        expect(put.status).toBe(409);
        expect((put.body as ApiErrorBody).error).toMatchObject({
            code: 'SETTING_UNREGISTERED',
            message: expect.stringContaining('reload the VS Code window') as string,
            params: { setting: 'revspan.review.hideUnfollowed' },
        });
    });

    it('a window not reloaded yet: saving other review settings works, the unknown setting counts as its default', async () => {
        const { http: app, store } = await bridge();
        unregisteredSettings.add('revspan.review.hideUnfollowed');
        expect(store.config.review.hideUnfollowed).toBe(true);
        const followed = [{ uuid: '{cam}', displayName: 'Camille Durand' }];
        const put = await callApi(app, { method: 'PUT', path: '/api/settings', body: { review: { followed } } });
        expect(put.status).toBe(200);
        expect((put.body as Settings).review.followed).toEqual(followed);
        expect(settings().inspect('review.followedContributors')?.globalValue).toEqual(followed);
        expect(settings().inspect('review.hideUnfollowed')?.globalValue).toBeUndefined();
    });

    it('a save touching an unknown setting writes nothing at all (all or nothing)', async () => {
        const { http: app } = await bridge();
        unregisteredSettings.add('revspan.review.hideUnfollowed');
        const put = await callApi(app, {
            method: 'PUT',
            path: '/api/settings',
            body: { review: { requiredApprovals: 3, followed: [{ uuid: '{cam}', displayName: 'Camille Durand' }], hideUnfollowed: false, refreshMinutes: 10 } },
        });
        expect(put.status).toBe(409);
        expect((put.body as ApiErrorBody).error).toMatchObject({ code: 'SETTING_UNREGISTERED', params: { setting: 'revspan.review.hideUnfollowed' } });
        for (const key of ['review.requiredApprovals', 'review.followedContributors', 'review.hideUnfollowed', 'refreshIntervalMinutes']) {
            expect(settings().inspect(key)?.globalValue, key).toBeUndefined();
        }
    });

    it('any other write failure stays an internal error with VS Code\'s text', async () => {
        const { http: app } = await bridge();
        settingWrites.failure = new Error('Unable to write into user settings. Please open the user settings to correct errors/warnings in it and try again.');
        const put = await callApi(app, { method: 'PUT', path: '/api/settings', body: { review: { requiredApprovals: 3 } } });
        expect(put.status).toBe(500);
        expect((put.body as ApiErrorBody).error).toMatchObject({ code: 'INTERNAL', params: { detail: expect.stringContaining('Unable to write into user settings') as string } });
    });

    it('untrusted workspace: written at the user level', async () => {
        const { http: app } = await bridge();
        await settings().update('refreshIntervalMinutes', 30, ConfigurationTarget.Workspace);
        workspace.isTrusted = false;
        await callApi(app, { method: 'PUT', path: '/api/settings', body: { review: { refreshMinutes: 10 } } });
        expect(settings().inspect('refreshIntervalMinutes')).toMatchObject({ workspaceValue: 30, globalValue: 10 });
    });
});

describe('extension panel (simulated VS Code)', () => {
    const ref = { workspace: WS, repo: REPO, id: FAKE_PRS.main };
    let subscriptions: { dispose(): unknown }[];
    /** Messages of one type posted to a page. */
    const sent = (panel: FakeWebviewPanel, type: string): unknown[] => panel.posted.filter((message) => (message as { type: string }).type === type);

    beforeEach(() => {
        resetFakeVscode();
        subscriptions = [];
        fs.mkdirSync(path.join(dir, 'ext', 'dist', 'web'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'ext', 'dist', 'web', 'index.html'), '<!doctype html><html><head></head><body></body></html>');
    });

    function create(onWrite: () => void = () => undefined): RevspanPanel {
        const context = { extensionUri: Uri.file(path.join(dir, 'ext')), subscriptions } as unknown as vscode.ExtensionContext;
        return new RevspanPanel({ context, app: { services, http, store: new Store(dir) }, diffs: { open: vi.fn() } as unknown as DiffDocuments, onWrite });
    }

    /** Opens the panel on a route; returns the fake VS Code panel. */
    function open(route: string): { revspan: RevspanPanel; panel: FakeWebviewPanel } {
        const revspan = create();
        revspan.show(route);
        const panel = recorded.panels.at(-1);
        if (!panel) {
            throw new Error('panel not created');
        }
        return { revspan, panel };
    }

    it('malformed page messages ignored, no exception or response', async () => {
        const { panel } = open('/');
        for (const data of [null, 42, { type: 'request', id: 'x', method: 'GET', path: '/api/health' }, { type: 'openFile', ref: { ...ref, workspace: '..' }, path: 'a', line: 1 }]) {
            panel.receive(data);
        }
        panel.receive({ type: 'request', id: 7, method: 'GET', path: '/api/health' });
        await vi.waitFor(() => expect(sent(panel, 'response')).toHaveLength(1));
        expect(sent(panel, 'response')[0]).toMatchObject({ type: 'response', id: 7, status: 200 });
        expect([...recorded.errors, ...recorded.warnings]).toEqual([]);
    });

    it('"Open file" rejects an absolute path or one leaving the local repository', async () => {
        const root = path.join(dir, 'workspace');
        fs.mkdirSync(path.join(root, REPO, '.git'), { recursive: true });
        fs.writeFileSync(path.join(root, REPO, '.git', 'HEAD'), 'ref: refs/heads/master\n');
        fs.writeFileSync(path.join(root, REPO, 'README.md'), '# demo\n');
        fs.writeFileSync(path.join(root, 'secret.txt'), 'secret\n');
        workspace.workspaceFolders = [{ uri: Uri.file(root) }];
        const { panel } = open('/');
        panel.receive({ type: 'openFile', ref, path: '../secret.txt', line: 1 });
        panel.receive({ type: 'openFile', ref, path: path.join(root, 'secret.txt'), line: 1 });
        await vi.waitFor(() => expect(recorded.warnings).toHaveLength(2));
        expect(recorded.opened).toEqual([]);
        panel.receive({ type: 'openFile', ref, path: 'README.md', line: null });
        await vi.waitFor(() => expect(recorded.opened).toEqual([path.join(root, REPO, 'README.md')]));
    });

    it('tab title: that of the screen in the Revspan tab; a PR tab keeps its PR\'s title', async () => {
        const { panel: home } = open('/');
        expect(home.title).toBe('Revspan');
        home.receive({ type: 'request', id: 1, method: 'GET', path: '/api/settings' });
        await vi.waitFor(() => expect(home.title).toBe('Revspan · Settings'));
        home.receive({ type: 'request', id: 2, method: 'GET', path: '/api/home' });
        await vi.waitFor(() => expect(home.title).toBe('Revspan'));
        await vi.waitFor(() => expect(sent(home, 'response')).toHaveLength(2), { timeout: 5000 });

        const prTitle = `PR #${FAKE_PRS.main} · ${REPO}`;
        const { panel: pr } = open(`/pr/${WS}/${REPO}/${FAKE_PRS.main}`);
        expect(pr.title).toBe(prTitle);
        pr.receive({ type: 'request', id: 1, method: 'GET', path: '/api/settings' });
        pr.receive({ type: 'request', id: 2, method: 'GET', path: '/api/home' });
        await vi.waitFor(() => expect(sent(pr, 'response')).toHaveLength(2), { timeout: 5000 });
        expect(pr.title).toBe(prTitle);
    });

    it('follows VS Code\'s display language: page language passed to the page, tab title and warnings', async () => {
        const english = open('/settings').panel;
        expect(english.webview.html).toContain('<meta name="revspan-locale" content="en">');
        expect(english.title).toBe('Revspan · Settings');
        english.dispose();

        env.language = 'fr';
        const { panel } = open('/settings');
        expect(panel.webview.html).toContain('<meta name="revspan-locale" content="fr">');
        expect(panel.title).toBe('Revspan · Réglages');
        panel.receive({ type: 'openFile', ref, path: 'README.md', line: null });
        await vi.waitFor(() => expect(recorded.warnings).toEqual([`Dépôt « ${WS}/${REPO} » introuvable dans l'espace de travail (ni remote Bitbucket, ni dossier ${REPO}, ni worktree).`]));
    });

    it('reopened by VS Code after a reload: same construction as show(), on the saved route', async () => {
        const route = `/pr/${WS}/${REPO}/${FAKE_PRS.main}?from=2&to=6`;
        const restored = new FakeWebviewPanel('revspan', 'Revspan');
        const revspan = create();
        revspan.restore(restored as unknown as vscode.WebviewPanel, route);
        expect(restored.title).toBe(`PR #${FAKE_PRS.main} · ${REPO}`);
        expect(restored.webview.options).toMatchObject({ enableScripts: true });
        expect(restored.webview.html).toContain(`<meta name="revspan-route" content="/pr/${WS}/${REPO}/${FAKE_PRS.main}?from=2&#38;to=6">`);
        restored.receive({ type: 'request', id: 1, method: 'GET', path: '/api/health' });
        await vi.waitFor(() => expect(sent(restored, 'response')).toEqual([expect.objectContaining({ type: 'response', id: 1, status: 200 })]));
    });

    it('panel-specific listeners, released when it closes; a new panel afterwards', () => {
        const { revspan, panel } = open('/');
        expect(subscriptions).toEqual([]);
        expect(panel.listenerCount).toBeGreaterThan(0);
        panel.dispose();
        expect(panel.listenerCount).toBe(0);
        revspan.show('/settings');
        expect(recorded.panels).toHaveLength(2);
        expect(subscriptions).toEqual([]);
    });

    describe('one tab per PR', () => {
        const prRoute = (id: number): string => `/pr/${WS}/${REPO}/${id}`;
        const prTitle = (id: number): string => `PR #${id} · ${REPO}`;
        const navigations = (panel: FakeWebviewPanel): unknown[] => panel.posted.filter((message) => (message as { type: string }).type === 'navigate');

        it('opens two PRs in two panels, the home page in a third one', () => {
            const revspan = create();
            revspan.show(prRoute(FAKE_PRS.main));
            revspan.show(prRoute(FAKE_PRS.mine));
            revspan.show('/');
            expect(recorded.panels.map((panel) => panel.title)).toEqual([prTitle(FAKE_PRS.main), prTitle(FAKE_PRS.mine), 'Revspan']);
            expect(recorded.panels[1]?.webview.html).toContain(`<meta name="revspan-route" content="${prRoute(FAKE_PRS.mine)}">`);
        });

        it('reveals the existing panel of an open PR, on its range unless one is asked', () => {
            const revspan = create();
            revspan.show(prRoute(FAKE_PRS.main));
            revspan.show(prRoute(FAKE_PRS.mine));
            revspan.show(prRoute(FAKE_PRS.main));
            expect(recorded.panels).toHaveLength(2);
            const [first, second] = recorded.panels;
            expect(first?.revealed).toBe(1);
            expect(second?.revealed).toBe(0);
            expect(first && navigations(first)).toEqual([]);
            revspan.show(`${prRoute(FAKE_PRS.main)}?from=2&to=6`);
            expect(recorded.panels).toHaveLength(2);
            expect(first && navigations(first)).toEqual([{ type: 'navigate', route: `${prRoute(FAKE_PRS.main)}?from=2&to=6` }]);
        });

        it('restores a PR panel and drops a duplicate', () => {
            const revspan = create();
            const pr = new FakeWebviewPanel('revspan', 'Revspan');
            revspan.restore(pr as unknown as vscode.WebviewPanel, `${prRoute(FAKE_PRS.main)}?from=2&to=6`);
            const duplicate = new FakeWebviewPanel('revspan', 'Revspan');
            revspan.restore(duplicate as unknown as vscode.WebviewPanel, prRoute(FAKE_PRS.main));
            expect(duplicate.disposed).toBe(true);
            expect(pr.disposed).toBe(false);
            const home = new FakeWebviewPanel('revspan', 'Revspan');
            revspan.restore(home as unknown as vscode.WebviewPanel, '/settings');
            expect(home.title).toBe('Revspan · Settings');
            const homeDuplicate = new FakeWebviewPanel('revspan', 'Revspan');
            revspan.restore(homeDuplicate as unknown as vscode.WebviewPanel, '/');
            expect(homeDuplicate.disposed).toBe(true);
            // The restored tabs are reused: no new panel, the PR keeps its range, the home page goes back home.
            revspan.show(prRoute(FAKE_PRS.main));
            revspan.show('/');
            expect(recorded.panels).toEqual([]);
            expect(pr.revealed).toBe(1);
            expect(navigations(pr)).toEqual([]);
            expect(navigations(home)).toEqual([{ type: 'navigate', route: '/' }]);
            expect(home.title).toBe('Revspan');
        });

        it('openRoute from a PR panel to settings reveals the home panel, reopened if it was closed', async () => {
            const revspan = create();
            revspan.show('/');
            revspan.show(prRoute(FAKE_PRS.main));
            const [home, pr] = recorded.panels;
            if (!home || !pr) {
                throw new Error('panels not created');
            }
            pr.receive({ type: 'openRoute', route: '/settings' });
            await vi.waitFor(() => expect(navigations(home)).toEqual([{ type: 'navigate', route: '/settings' }]));
            expect(home.revealed).toBe(1);
            expect(home.title).toBe('Revspan · Settings');
            expect(pr.posted).toEqual([{ type: 'visibility', visible: true }]);
            expect(pr.title).toBe(prTitle(FAKE_PRS.main));

            // The user closes the Revspan tab, then clicks "Revspan" in the PR tab: it reopens on the home page.
            home.dispose();
            pr.receive({ type: 'openRoute', route: '/' });
            await vi.waitFor(() => expect(recorded.panels).toHaveLength(3));
            expect(recorded.panels[2]?.title).toBe('Revspan');
            expect(recorded.panels[2]?.webview.html).toContain('<meta name="revspan-route" content="/">');
            // Only a page route is accepted.
            pr.receive({ type: 'openRoute', route: '//evil.example/x' });
            pr.receive({ type: 'openRoute', route: 'https://evil.example/' });
            expect(recorded.panels).toHaveLength(3);
        });

        it('openRoute from the home panel opens the PR in its own tab, the home page stays', async () => {
            const revspan = create();
            revspan.show('/');
            const home = recorded.panels[0];
            home?.receive({ type: 'openRoute', route: prRoute(FAKE_PRS.mine) });
            await vi.waitFor(() => expect(recorded.panels).toHaveLength(2));
            expect(recorded.panels[1]?.title).toBe(prTitle(FAKE_PRS.mine));
            expect(home?.posted).toEqual([{ type: 'visibility', visible: true }]);
        });

        it('tells each page whether its tab is on screen; visible while any tab is', () => {
            const revspan = create();
            revspan.show('/');
            revspan.show(prRoute(FAKE_PRS.main));
            const [home, pr] = recorded.panels;
            if (!home || !pr) {
                throw new Error('panels not created');
            }
            // Told when the tab opens (a tab revived in the background starts paused), then on every change.
            expect(pr.posted).toEqual([{ type: 'visibility', visible: true }]);
            pr.setVisible(false);
            expect(pr.posted.at(-1)).toEqual({ type: 'visibility', visible: false });
            expect(revspan.visible).toBe(true);
            home.setVisible(false);
            expect(home.posted.at(-1)).toEqual({ type: 'visibility', visible: false });
            expect(revspan.visible).toBe(false);
            revspan.show(prRoute(FAKE_PRS.main));
            expect(pr.posted.at(-1)).toEqual({ type: 'visibility', visible: true });
            expect(revspan.visible).toBe(true);
        });

        /** Labels of the tabs, per editor group (column). */
        const tabLabels = (): Record<number, string[]> => Object.fromEntries(window.tabGroups.all.map((group) => [group.viewColumn, group.tabs.map((tab) => tab.label)]));

        it('after a reload, a "Revspan" tab not revived yet is replaced in its place, not duplicated', async () => {
            // The PR tab was in front (revived), the "Revspan" tab waits in the background of the second group.
            const background = dormantTab('Revspan', 2);
            const revspan = create();
            revspan.show(prRoute(FAKE_PRS.main));
            recorded.panels[0]?.receive({ type: 'openRoute', route: '/settings' });
            await vi.waitFor(() => expect(recorded.panels).toHaveLength(2));
            expect(recorded.closedTabs).toEqual([background]);
            expect(recorded.panels[1]?.viewColumn).toBe(2);
            expect(tabLabels()).toEqual({ 1: [prTitle(FAKE_PRS.main)], 2: ['Revspan · Settings'] });
        });

        it('after a reload, a PR whose tab is not revived yet opens in that tab\'s place', () => {
            const background = dormantTab(prTitle(FAKE_PRS.mine));
            dormantTab('Revspan');
            const revspan = create();
            revspan.show(prRoute(FAKE_PRS.mine));
            expect(recorded.closedTabs).toEqual([background]);
            expect(tabLabels()).toEqual({ 1: ['Revspan', prTitle(FAKE_PRS.mine)] });
        });

        it('a live tab with the same title, or another extension\'s webview, is never closed', () => {
            const revspan = create();
            revspan.show(prRoute(FAKE_PRS.main));
            dormantTab('Revspan', 1, 'mainThreadWebview-other');
            // Same PR number and repository name in another workspace: same title, another tab.
            revspan.show(`/pr/other-ws/${REPO}/${FAKE_PRS.main}`);
            revspan.show('/');
            expect(recorded.closedTabs).toEqual([]);
            expect(recorded.panels).toHaveLength(3);
        });

        it('a tab closed while its request runs: the response is dropped, the write still refreshes "My PRs"', async () => {
            const onWrite = vi.fn();
            const revspan = create(onWrite);
            revspan.show(prRoute(FAKE_PRS.main));
            const pr = recorded.panels[0];
            const thread = ((await callApi(http, { method: 'GET', path: PR })).body as PrDetail).threads[0];
            pr?.receive({ type: 'request', id: 1, method: 'POST', path: `${PR}/comments`, body: { raw: 'Closed meanwhile', parentId: thread?.id } });
            pr?.dispose();
            await vi.waitFor(() => expect(onWrite).toHaveBeenCalledTimes(1));
            expect(pr?.posted.filter((message) => (message as { type: string }).type === 'response')).toEqual([]);
            expect(recorded.errors).toEqual([]);
        });

        it('a write from a PR tab refreshes "My PRs"', async () => {
            const onWrite = vi.fn();
            const revspan = create(onWrite);
            revspan.show(prRoute(FAKE_PRS.main));
            recorded.panels[0]?.receive({ type: 'request', id: 1, method: 'POST', path: `${PR}/approve`, body: {} });
            await vi.waitFor(() => expect(onWrite).toHaveBeenCalledTimes(1));
        });

        it('a PR read from the "Revspan" tab (prefetch) does not retitle it', async () => {
            const { panel: home } = open('/');
            home.receive({ type: 'request', id: 1, method: 'GET', path: PR });
            await vi.waitFor(() => expect(sent(home, 'response')).toHaveLength(1), { timeout: 5000 });
            expect(home.title).toBe('Revspan');
        });

        it('a 3.3 panel restored on a PR route while the "Revspan" tab is open becomes that PR\'s tab', () => {
            const revspan = create();
            revspan.show('/');
            const home = recorded.panels[0];
            const legacy = new FakeWebviewPanel('revspan', 'Revspan');
            revspan.restore(legacy as unknown as vscode.WebviewPanel, `${prRoute(FAKE_PRS.main)}?from=2&to=6`);
            expect(legacy.disposed).toBe(false);
            expect(legacy.title).toBe(prTitle(FAKE_PRS.main));
            expect(home?.title).toBe('Revspan');
            expect(home && navigations(home)).toEqual([]);
            revspan.show(prRoute(FAKE_PRS.main));
            expect(recorded.panels).toHaveLength(1);
            expect(legacy.revealed).toBe(1);
        });

        it('a closed PR tab releases its listeners; the PR opens again in a new tab', () => {
            const revspan = create();
            revspan.show('/');
            revspan.show(prRoute(FAKE_PRS.main));
            const [home, pr] = recorded.panels;
            pr?.dispose();
            expect(pr?.listenerCount).toBe(0);
            expect(home?.listenerCount).toBeGreaterThan(0);
            revspan.show(prRoute(FAKE_PRS.main));
            expect(recorded.panels).toHaveLength(3);
            expect(home?.revealed).toBe(0);
        });
    });

    it('"My PRs" view: a line tells how many PRs are hidden, and opens the settings', async () => {
        await services.settings.update({ review: { followed: [{ uuid: '{cam}', displayName: 'Camille Durand' }] } });
        const tree = new HomeTreeProvider(services.home, () => 'repository');
        const roots = await tree.getChildren();
        expect(roots[0]).toEqual({ kind: 'message', text: '1 PR hidden (a contributor you don’t follow)', icon: 'eye-closed', command: 'revspan.openSettings' });
        await services.settings.update({ review: { hideUnfollowed: false } });
        expect((await tree.getChildren()).filter((node) => node.kind === 'message')).toEqual([]);
        tree.dispose();
    });

    it('"My PRs" view: emitter released with the extension', () => {
        const tree = new HomeTreeProvider(services.home, () => 'repository');
        const listener = vi.fn();
        tree.onDidChangeTreeData(listener);
        tree.refresh();
        tree.dispose();
        tree.refresh();
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('"My PRs" view: shows a loading message until the first home arrives', async () => {
        const tree = new HomeTreeProvider(services.home, () => 'repository');
        const view: { message: string | undefined } = { message: undefined };
        showLoading(tree, view, window as never);
        const roots = tree.getChildren();
        expect(view.message).toBe('Loading…');
        await roots;
        expect(view.message).toBeUndefined();
        await tree.getChildren();
        expect(view.message).toBeUndefined();
        tree.dispose();
    });

    it('"My PRs" view: shows progress without clearing the tree on refresh', async () => {
        const tree = new HomeTreeProvider(services.home, () => 'repository');
        const view: { message: string | undefined } = { message: undefined };
        showLoading(tree, view, window as never);
        await tree.getChildren();
        recorded.progress.length = 0;
        const roots = tree.getChildren();
        expect(view.message).toBeUndefined();
        expect(recorded.progress).toEqual([{ options: { location: { viewId: 'revspan.home' } }, done: false }]);
        expect((await roots).length).toBeGreaterThan(0);
        expect(recorded.progress[0]?.done).toBe(true);
        tree.dispose();
    });
});
