import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebview, WebviewToHost } from '../../src/shared/webview-protocol.ts';

// host.ts reads acquireVsCodeApi on import: each test reloads the modules after setting (or not) the fake.
const ref = { workspace: 'acme', repo: 'demo-repo', id: 42 };
const reply = (message: HostToWebview | Record<string, unknown>): void => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
};

describe('in a VS Code panel', () => {
    let posted: WebviewToHost[];
    let states: unknown[];
    let acquire: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.resetModules();
        posted = [];
        states = [];
        acquire = vi.fn(() => ({ postMessage: (message: WebviewToHost) => posted.push(message), setState: (state: unknown) => states.push(state) }));
        vi.stubGlobal('acquireVsCodeApi', acquire);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('detects VS Code and calls acquireVsCodeApi only once', async () => {
        const host = await import('../../src/web/services/host.ts');
        await import('../../src/web/services/api.ts');
        expect(host.isVsCode).toBe(true);
        expect(acquire).toHaveBeenCalledTimes(1);
    });

    it('read: "request" message posted, resolved by the response with the same id', async () => {
        const { api } = await import('../../src/web/services/api.ts');
        const home = api.home();
        expect(posted).toEqual([{ type: 'request', id: 1, method: 'GET', path: '/api/home' }]);
        const body = { me: null, groups: [], errors: [] };
        reply({ type: 'response', id: 1, status: 200, body });
        await expect(home).resolves.toEqual(body);
    });

    it('I3: the home read fresh (the Refresh button) asks /api/home?fresh=1; a plain read does not', async () => {
        const { api } = await import('../../src/web/services/api.ts');
        void api.home({ fresh: true });
        void api.home();
        expect(posted.map((m) => (m.type === 'request' ? m.path : m.type))).toEqual(['/api/home?fresh=1', '/api/home']);
    });

    it('writes: JSON body (cloneable copy), {} when there is none', async () => {
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

    it('out-of-order responses: each request gets its own', async () => {
        const { api } = await import('../../src/web/services/api.ts');
        const settings = api.settings();
        const home = api.home();
        reply({ type: 'response', id: 2, status: 200, body: 'home' });
        reply({ type: 'response', id: 1, status: 200, body: 'settings' });
        await expect(settings).resolves.toBe('settings');
        await expect(home).resolves.toBe('home');
    });

    it('error response: ApiError with the server\'s code and message', async () => {
        const { api, ApiError } = await import('../../src/web/services/api.ts');
        const home = api.home();
        reply({ type: 'response', id: 1, status: 409, body: { error: { code: 'NO_TOKEN', message: 'Aucun jeton.' } } });
        await expect(home).rejects.toBeInstanceOf(ApiError);
        await expect(home).rejects.toMatchObject({ status: 409, code: 'NO_TOKEN', message: 'Aucun jeton.' });
        const pr = api.pr(ref);
        reply({ type: 'response', id: 2, status: 502, body: null });
        await expect(pr).rejects.toMatchObject({ status: 502, code: 'HTTP_502' });
    });

    it('no response from the extension: ApiError NETWORK after the timeout', async () => {
        vi.useFakeTimers();
        const { api } = await import('../../src/web/services/api.ts');
        const home = api.home();
        const settled = expect(home).rejects.toMatchObject({ code: 'NETWORK', message: expect.stringContaining('extension') });
        await vi.advanceTimersByTimeAsync(120000);
        await settled;
    });

    it('extension messages: navigate forwarded, unknown messages ignored, unsubscribe', async () => {
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

    it('displayed route saved in the panel state (reopened on it after "Reload Window")', async () => {
        const { rememberRoute } = await import('../../src/web/services/host.ts');
        rememberRoute('/pr/acme/demo-repo/42?from=2&to=6');
        rememberRoute('/settings');
        expect(states).toEqual([{ route: '/pr/acme/demo-repo/42?from=2&to=6' }, { route: '/settings' }]);
    });

    it('open a local file or the native diff', async () => {
        const { openLocalFile, openNativeDiff } = await import('../../src/web/services/host.ts');
        openLocalFile(ref, 'src/Action.ts', 7);
        openNativeDiff(ref, 2, 6, 'src/Action.ts', null);
        expect(posted).toEqual([
            { type: 'openFile', ref, path: 'src/Action.ts', line: 7 },
            { type: 'openDiff', ref, from: 2, to: 6, path: 'src/Action.ts', oldPath: null },
        ]);
    });
});

describe('outside VS Code', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('HTTP requests, X-Revspan header on writes only', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const { isVsCode } = await import('../../src/web/services/host.ts');
        const { api } = await import('../../src/web/services/api.ts');
        expect(isVsCode).toBe(false);
        await api.approve(ref, true);
        await api.home();
        expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/pr/acme/demo-repo/42/approve', expect.objectContaining({
            method: 'POST', body: '{}', headers: expect.objectContaining({ 'X-Revspan': '1', 'Content-Type': 'application/json' }),
        }));
        const [, homeInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
        expect(homeInit.headers).not.toHaveProperty('X-Revspan');
        expect(homeInit.body).toBeUndefined();
    });

    it('server unreachable: ApiError NETWORK', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new TypeError('Failed to fetch');
        }));
        const { api } = await import('../../src/web/services/api.ts');
        await expect(api.home()).rejects.toMatchObject({ status: 0, code: 'NETWORK', message: expect.stringContaining('Revspan server') });
    });

    it('panel state: nothing to save', async () => {
        const { rememberRoute } = await import('../../src/web/services/host.ts');
        expect(() => rememberRoute('/settings')).not.toThrow();
    });

    it('relaying through the extension refuses to start', async () => {
        const { hostRequest } = await import('../../src/web/services/host.ts');
        await expect(hostRequest('GET', '/api/home')).rejects.toThrow('Not in VS Code');
    });
});

describe('readInitialRoute', () => {
    const doc = (head: string): Document => new DOMParser().parseFromString(`<html><head>${head}</head><body></body></html>`, 'text/html');

    it('route from the <meta name="revspan-route"> tag', async () => {
        const { readInitialRoute } = await import('../../src/web/services/host.ts');
        expect(readInitialRoute(doc('<meta name="revspan-route" content="/pr/acme/demo-repo/42">'))).toBe('/pr/acme/demo-repo/42');
        expect(readInitialRoute(doc('<meta name="revspan-route" content="  /settings ">'))).toBe('/settings');
    });

    it('missing, empty or not a page path: null', async () => {
        const { readInitialRoute } = await import('../../src/web/services/host.ts');
        expect(readInitialRoute(doc(''))).toBeNull();
        expect(readInitialRoute(doc('<meta name="revspan-route" content="">'))).toBeNull();
        expect(readInitialRoute(doc('<meta name="revspan-route" content="https://evil.example/">'))).toBeNull();
        expect(readInitialRoute(doc('<meta name="revspan-route" content="//evil.example/x">'))).toBeNull();
        expect(readInitialRoute(doc('<meta name="revspan-route" content="settings">'))).toBeNull();
    });
});
