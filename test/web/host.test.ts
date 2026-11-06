import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebview, WebviewToHost } from '../../src/shared/webview-protocol.ts';

// host.ts lit acquireVsCodeApi à l'import : chaque test recharge les modules après avoir posé (ou non) le faux.
const ref = { workspace: 'acme', repo: 'demo-repo', id: 42 };
const reply = (message: HostToWebview | Record<string, unknown>): void => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
};

describe('dans un panneau VS Code', () => {
    let posted: WebviewToHost[];
    let acquire: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.resetModules();
        posted = [];
        acquire = vi.fn(() => ({ postMessage: (message: WebviewToHost) => posted.push(message) }));
        vi.stubGlobal('acquireVsCodeApi', acquire);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('détecte VS Code et n\'appelle acquireVsCodeApi qu\'une fois', async () => {
        const host = await import('../../src/web/services/host.ts');
        await import('../../src/web/services/api.ts');
        expect(host.isVsCode).toBe(true);
        expect(acquire).toHaveBeenCalledTimes(1);
    });

    it('lecture : message « request » posté, résolue par la réponse de même id', async () => {
        const { api } = await import('../../src/web/services/api.ts');
        const home = api.home();
        expect(posted).toEqual([{ type: 'request', id: 1, method: 'GET', path: '/api/home' }]);
        const body = { me: null, groups: [], errors: [] };
        reply({ type: 'response', id: 1, status: 200, body });
        await expect(home).resolves.toEqual(body);
    });

    it('écritures : corps JSON (copie clonable), {} quand il n\'y en a pas', async () => {
        const { api } = await import('../../src/web/services/api.ts');
        void api.comment(ref, { raw: 'Merci', parentId: 7 });
        void api.approve(ref, true);
        void api.resolve(ref, 7, false);
        expect(posted).toEqual([
            { type: 'request', id: 1, method: 'POST', path: '/api/pr/acme/demo-repo/42/comments', body: { raw: 'Merci', parentId: 7 } },
            { type: 'request', id: 2, method: 'POST', path: '/api/pr/acme/demo-repo/42/approve', body: {} },
            { type: 'request', id: 3, method: 'DELETE', path: '/api/pr/acme/demo-repo/42/comments/7/resolve', body: {} },
        ]);
    });

    it('réponses dans le désordre : chaque requête reçoit la sienne', async () => {
        const { api } = await import('../../src/web/services/api.ts');
        const settings = api.settings();
        const home = api.home();
        reply({ type: 'response', id: 2, status: 200, body: 'home' });
        reply({ type: 'response', id: 1, status: 200, body: 'settings' });
        await expect(settings).resolves.toBe('settings');
        await expect(home).resolves.toBe('home');
    });

    it('réponse d\'erreur : ApiError avec le code et le message du serveur', async () => {
        const { api, ApiError } = await import('../../src/web/services/api.ts');
        const home = api.home();
        reply({ type: 'response', id: 1, status: 409, body: { error: { code: 'NO_TOKEN', message: 'Aucun jeton.' } } });
        await expect(home).rejects.toBeInstanceOf(ApiError);
        await expect(home).rejects.toMatchObject({ status: 409, code: 'NO_TOKEN', message: 'Aucun jeton.' });
        const pr = api.pr(ref);
        reply({ type: 'response', id: 2, status: 502, body: null });
        await expect(pr).rejects.toMatchObject({ status: 502, code: 'HTTP_502' });
    });

    it('pas de réponse de l\'extension : ApiError NETWORK après le délai', async () => {
        vi.useFakeTimers();
        const { api } = await import('../../src/web/services/api.ts');
        const home = api.home();
        const settled = expect(home).rejects.toMatchObject({ code: 'NETWORK', message: expect.stringContaining('extension') });
        await vi.advanceTimersByTimeAsync(120000);
        await settled;
    });

    it('messages de l\'extension : navigate transmis, messages inconnus ignorés, désabonnement', async () => {
        const { onHostMessage } = await import('../../src/web/services/host.ts');
        const handler = vi.fn();
        const stop = onHostMessage(handler);
        reply({ type: 'navigate', route: '/pr/acme/demo-repo/43' });
        reply({ type: 'navigate', route: 42 });
        reply({ type: 'other' });
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith({ type: 'navigate', route: '/pr/acme/demo-repo/43' });
        stop();
        reply({ type: 'navigate', route: '/settings' });
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('ouvrir un fichier local ou le diff natif', async () => {
        const { openLocalFile, openNativeDiff } = await import('../../src/web/services/host.ts');
        openLocalFile(ref, 'src/Action.ts', 7);
        openNativeDiff(ref, 2, 6, 'src/Action.ts', null);
        expect(posted).toEqual([
            { type: 'openFile', ref, path: 'src/Action.ts', line: 7 },
            { type: 'openDiff', ref, from: 2, to: 6, path: 'src/Action.ts', oldPath: null },
        ]);
    });
});

describe('hors VS Code', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('requêtes HTTP, en-tête X-Strata sur les écritures seulement', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const { isVsCode } = await import('../../src/web/services/host.ts');
        const { api } = await import('../../src/web/services/api.ts');
        expect(isVsCode).toBe(false);
        await api.approve(ref, true);
        await api.home();
        expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/pr/acme/demo-repo/42/approve', expect.objectContaining({
            method: 'POST', body: '{}', headers: expect.objectContaining({ 'X-Strata': '1', 'Content-Type': 'application/json' }),
        }));
        const [, homeInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
        expect(homeInit.headers).not.toHaveProperty('X-Strata');
        expect(homeInit.body).toBeUndefined();
    });

    it('serveur injoignable : ApiError NETWORK', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new TypeError('Failed to fetch');
        }));
        const { api } = await import('../../src/web/services/api.ts');
        await expect(api.home()).rejects.toMatchObject({ status: 0, code: 'NETWORK', message: expect.stringContaining('Serveur Strata') });
    });

    it('le relais par l\'extension refuse de partir', async () => {
        const { hostRequest } = await import('../../src/web/services/host.ts');
        await expect(hostRequest('GET', '/api/home')).rejects.toThrow('Pas dans VS Code');
    });
});

describe('readInitialRoute', () => {
    const doc = (head: string): Document => new DOMParser().parseFromString(`<html><head>${head}</head><body></body></html>`, 'text/html');

    it('route de la balise <meta name="strata-route">', async () => {
        const { readInitialRoute } = await import('../../src/web/services/host.ts');
        expect(readInitialRoute(doc('<meta name="strata-route" content="/pr/acme/demo-repo/42">'))).toBe('/pr/acme/demo-repo/42');
        expect(readInitialRoute(doc('<meta name="strata-route" content="  /settings ">'))).toBe('/settings');
    });

    it('absente, vide ou qui n\'est pas un chemin de la page : null', async () => {
        const { readInitialRoute } = await import('../../src/web/services/host.ts');
        expect(readInitialRoute(doc(''))).toBeNull();
        expect(readInitialRoute(doc('<meta name="strata-route" content="">'))).toBeNull();
        expect(readInitialRoute(doc('<meta name="strata-route" content="https://evil.example/">'))).toBeNull();
        expect(readInitialRoute(doc('<meta name="strata-route" content="//evil.example/x">'))).toBeNull();
        expect(readInitialRoute(doc('<meta name="strata-route" content="settings">'))).toBeNull();
    });
});
