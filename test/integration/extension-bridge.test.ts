// Pont de l'extension : l'application HTTP en mémoire (comme dans VS Code) branchée sur le faux Bitbucket,
// et le panneau qui la sert à la page (VS Code simulé par test/support/fake-vscode.ts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import type * as vscode from 'vscode';
import type { PrDetail } from '../../src/shared/api.ts';
import { createHttpApp } from '../../src/server/http/app.ts';
import { Cache } from '../../src/server/infra/cache.ts';
import { Store } from '../../src/server/infra/config.ts';
import { createSecretStore } from '../../src/server/infra/secrets.ts';
import { createServices, type Services } from '../../src/server/services/index.ts';
import { IN_MEMORY_HOST, callApi, isSuccessfulWrite } from '../../src/extension/lib/bridge.ts';
import type { DiffDocuments } from '../../src/extension/diff-documents.ts';
import { HomeTreeProvider } from '../../src/extension/home-tree-provider.ts';
import { RevspanPanel } from '../../src/extension/panel.ts';
import { FAKE_EMAIL, FAKE_PRS, FAKE_TOKEN, REPO, WS, startFakeBitbucket, type FakeBitbucket } from '../support/fake-bitbucket.ts';
import { Uri, recorded, resetFakeVscode, workspace, type FakeWebviewPanel } from '../support/fake-vscode.ts';

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

describe('panneau de l\'extension (VS Code simulé)', () => {
    const ref = { workspace: WS, repo: REPO, id: FAKE_PRS.main };
    let subscriptions: { dispose(): unknown }[];

    beforeEach(() => {
        resetFakeVscode();
        subscriptions = [];
        fs.mkdirSync(path.join(dir, 'ext', 'dist', 'web'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'ext', 'dist', 'web', 'index.html'), '<!doctype html><html><head></head><body></body></html>');
    });

    /** Ouvre le panneau sur une route ; renvoie le faux panneau VS Code. */
    function open(route: string): { revspan: RevspanPanel; panel: FakeWebviewPanel } {
        const context = { extensionUri: Uri.file(path.join(dir, 'ext')), subscriptions } as unknown as vscode.ExtensionContext;
        const revspan = new RevspanPanel({ context, app: { services, http }, diffs: { open: vi.fn() } as unknown as DiffDocuments, onWrite: () => undefined });
        revspan.show(route);
        const panel = recorded.panels.at(-1);
        if (!panel) {
            throw new Error('panneau non créé');
        }
        return { revspan, panel };
    }

    it('messages mal formés de la page ignorés, sans exception ni réponse', async () => {
        const { panel } = open('/');
        for (const data of [null, 42, { type: 'request', id: 'x', method: 'GET', path: '/api/health' }, { type: 'openFile', ref: { ...ref, workspace: '..' }, path: 'a', line: 1 }]) {
            panel.receive(data);
        }
        panel.receive({ type: 'request', id: 7, method: 'GET', path: '/api/health' });
        await vi.waitFor(() => expect(panel.posted).toHaveLength(1));
        expect(panel.posted[0]).toMatchObject({ type: 'response', id: 7, status: 200 });
        expect([...recorded.errors, ...recorded.warnings]).toEqual([]);
    });

    it('« Ouvrir le fichier » refuse un chemin absolu ou qui sort du dépôt local', async () => {
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

    it('écouteurs propres au panneau, libérés à sa fermeture ; un nouveau panneau ensuite', () => {
        const { revspan, panel } = open('/');
        expect(subscriptions).toEqual([]);
        expect(panel.listenerCount).toBeGreaterThan(0);
        panel.dispose();
        expect(panel.listenerCount).toBe(0);
        revspan.show('/settings');
        expect(recorded.panels).toHaveLength(2);
        expect(subscriptions).toEqual([]);
    });

    it('vue « Mes PR » : émetteur libéré avec l\'extension', () => {
        const tree = new HomeTreeProvider(services.home);
        const listener = vi.fn();
        tree.onDidChangeTreeData(listener);
        tree.refresh();
        tree.dispose();
        tree.refresh();
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
