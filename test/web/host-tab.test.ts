import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { WebviewToHost } from '../../src/shared/webview-protocol.ts';

const PR = '/pr/acme/demo-repo/42';
const Blank = { render: () => null };
let posted: WebviewToHost[];
let unbind: (() => void) | null = null;

const reply = (data: unknown): void => {
    window.dispatchEvent(new MessageEvent('message', { data }));
};

/** The page's routes (blank screens) in a VS Code tab opened by the extension on `initial`. */
async function openTab(initial: string) {
    vi.resetModules();
    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: (message: WebviewToHost) => posted.push(message), setState: () => undefined }));
    const { bindRouterToHost } = await import('../../src/web/services/host-tab.ts');
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: '/', component: Blank },
            { path: '/pr/:ws/:repo/:id(\\d+)', component: Blank },
            { path: '/settings', component: Blank },
            { path: '/:pathMatch(.*)*', redirect: '/' },
        ],
    });
    unbind = bindRouterToHost(router, initial);
    await router.push(initial);
    const path = (): string => router.currentRoute.value.fullPath;
    return { router, path };
}

beforeEach(() => {
    posted = [];
});

afterEach(() => {
    unbind?.();
    unbind = null;
    vi.unstubAllGlobals();
});

describe('one PR per VS Code tab (page side)', () => {
    it('PR tab: range changes stay in the tab, every other screen is asked to the extension', async () => {
        const { router, path } = await openTab(PR);
        await router.push(`${PR}?from=1&to=3`);
        expect(path()).toBe(`${PR}?from=1&to=3`);
        await router.push('/settings');
        await router.push('/');
        await router.push('/pr/acme/demo-repo/45');
        expect(path()).toBe(`${PR}?from=1&to=3`);
        expect(posted).toEqual([
            { type: 'openRoute', route: '/settings' },
            { type: 'openRoute', route: '/' },
            { type: 'openRoute', route: '/pr/acme/demo-repo/45' },
        ]);
    });

    it('Revspan tab: home and settings stay in the tab, a PR opens in its own tab', async () => {
        const { router, path } = await openTab('/');
        await router.push('/settings');
        expect(path()).toBe('/settings');
        await router.push(`${PR}?from=2&to=6`);
        expect(path()).toBe('/settings');
        expect(posted).toEqual([{ type: 'openRoute', route: `${PR}?from=2&to=6` }]);
    });

    it('the extension makes the tab navigate within its role', async () => {
        const { path } = await openTab('/');
        reply({ type: 'navigate', route: '/settings' });
        await vi.waitFor(() => expect(path()).toBe('/settings'));
        expect(posted).toEqual([]);
    });

    it('the tab\'s visibility given by the extension pauses the page\'s background work', async () => {
        await openTab(PR);
        const { usePageVisible } = await import('../../src/web/composables/usePageVisible.ts');
        const visible = usePageVisible();
        expect(visible.value).toBe(true);
        reply({ type: 'visibility', visible: false });
        expect(visible.value).toBe(false);
        reply({ type: 'visibility', visible: true });
        expect(visible.value).toBe(true);
    });
});
