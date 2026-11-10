// Extension bridge: the in-memory HTTP application (as in VS Code) wired to the fake Bitbucket,
// and the panel that serves it to the page (VS Code simulated by test/support/fake-vscode.ts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import type * as vscode from 'vscode';
import type { PrDetail, Settings } from '../../src/shared/api.ts';
import { createHttpApp } from '../../src/server/http/app.ts';
import { Cache } from '../../src/server/infra/cache.ts';
import { Store } from '../../src/server/infra/config.ts';
import { createSecretStore } from '../../src/server/infra/secrets.ts';
import { createServices, type Services } from '../../src/server/services/index.ts';
import { vscodeReviewSource } from '../../src/extension/app-context.ts';
import { IN_MEMORY_HOST, callApi, isSuccessfulWrite } from '../../src/extension/lib/bridge.ts';
import type { DiffDocuments } from '../../src/extension/diff-documents.ts';
import { HomeTreeProvider } from '../../src/extension/home-tree-provider.ts';
import { RevspanPanel } from '../../src/extension/panel.ts';
import { FAKE_EMAIL, FAKE_PRS, FAKE_TOKEN, REPO, WS, startFakeBitbucket, type FakeBitbucket } from '../support/fake-bitbucket.ts';
import { ConfigurationTarget, FakeWebviewPanel, Uri, env, recorded, resetFakeVscode, workspace } from '../support/fake-vscode.ts';

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

    beforeEach(() => {
        resetFakeVscode();
        subscriptions = [];
        fs.mkdirSync(path.join(dir, 'ext', 'dist', 'web'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'ext', 'dist', 'web', 'index.html'), '<!doctype html><html><head></head><body></body></html>');
    });

    function create(): RevspanPanel {
        const context = { extensionUri: Uri.file(path.join(dir, 'ext')), subscriptions } as unknown as vscode.ExtensionContext;
        return new RevspanPanel({ context, app: { services, http, store: new Store(dir) }, diffs: { open: vi.fn() } as unknown as DiffDocuments, onWrite: () => undefined });
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
        await vi.waitFor(() => expect(panel.posted).toHaveLength(1));
        expect(panel.posted[0]).toMatchObject({ type: 'response', id: 7, status: 200 });
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

    it('tab title: that of the screen, also when the page goes back to the home page or the settings', async () => {
        const prTitle = `PR #${FAKE_PRS.main} · ${REPO}`;
        const { panel } = open(`/pr/${WS}/${REPO}/${FAKE_PRS.main}`);
        expect(panel.title).toBe(prTitle);
        panel.receive({ type: 'request', id: 1, method: 'GET', path: '/api/settings' });
        await vi.waitFor(() => expect(panel.title).toBe('Revspan · Settings'));
        panel.receive({ type: 'request', id: 2, method: 'GET', path: '/api/home' });
        await vi.waitFor(() => expect(panel.title).toBe('Revspan'));
        panel.receive({ type: 'request', id: 3, method: 'GET', path: `/api/pr/${WS}/${REPO}/${FAKE_PRS.main}` });
        await vi.waitFor(() => expect(panel.title).toBe(prTitle));
        await vi.waitFor(() => expect(panel.posted).toHaveLength(3), { timeout: 5000 });
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
        await vi.waitFor(() => expect(restored.posted).toEqual([expect.objectContaining({ type: 'response', id: 1, status: 200 })]));
        revspan.show('/settings');
        expect(recorded.panels).toEqual([]);
        expect(restored.posted.at(-1)).toEqual({ type: 'navigate', route: '/settings' });
        const duplicate = new FakeWebviewPanel('revspan', 'Revspan');
        revspan.restore(duplicate as unknown as vscode.WebviewPanel, '/');
        expect(duplicate.disposed).toBe(true);
        expect(restored.disposed).toBe(false);
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

    it('"My PRs" view: emitter released with the extension', () => {
        const tree = new HomeTreeProvider(services.home, () => 'repository');
        const listener = vi.fn();
        tree.onDidChangeTreeData(listener);
        tree.refresh();
        tree.dispose();
        tree.refresh();
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
