// Route shown by the panel: tab title, screen deduced from the page's API reads,
// route on which VS Code reopens the panel after "Reload Window".
import { isPageRoute, type PanelState } from '../../shared/webview-protocol.ts';
import type { Translate } from './l10n.ts';

/** Webview panel type (createWebviewPanel, serializer, onWebviewPanel:revspan activation event). */
export const PANEL_VIEW_TYPE = 'revspan';

const HOME_ROUTE = '/';

const PR_ROUTE = /^\/pr\/([^/]+)\/([^/]+)\/(\d+)/;

/** API read specific to a screen (outside PRs) -> route of that screen. */
const SCREENS = new Map([['/home', HOME_ROUTE], ['/settings', '/settings']]);

/** Tab title for a page route (same rule on opening and during navigation). */
export function panelTitle(t: Translate, route: string): string {
    const match = PR_ROUTE.exec(route);
    if (match) {
        return `PR #${match[3]} · ${match[2]}`;
    }
    return route.startsWith('/settings') ? t('Revspan · Settings') : 'Revspan';
}

/**
 * Page screen that makes this API read (e.g. GET /api/home -> "/"), to keep the title up to date when
 * navigating in the page; null for a write or another read. Each screen reads its own API route.
 */
export function routeOfApiRead(method: string, apiPath: string): string | null {
    if (method !== 'GET') {
        return null;
    }
    const pagePath = apiPath.replace(/^\/api(?=\/)/, '');
    const pr = PR_ROUTE.exec(pagePath);
    if (pr) {
        return pr[0];
    }
    return SCREENS.get(pagePath.split('?')[0] ?? '') ?? null;
}

/** Route saved by the page in the panel state (PanelState); the home page if the state is missing or invalid. */
export function restoredRoute(state: unknown): string {
    const route = typeof state === 'object' && state !== null ? (state as Partial<Record<keyof PanelState, unknown>>).route : undefined;
    return isPageRoute(route) ? route : HOME_ROUTE;
}
