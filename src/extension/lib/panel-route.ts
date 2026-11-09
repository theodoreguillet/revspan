// Route affichée par le panneau : titre de l'onglet, écran déduit des lectures d'API de la page,
// route sur laquelle VS Code rouvre le panneau après « Recharger la fenêtre ».
import { isPageRoute, type PanelState } from '../../shared/webview-protocol.ts';
import type { Translate } from './l10n.ts';

/** Type du panneau webview (createWebviewPanel, sérialiseur, événement d'activation onWebviewPanel:revspan). */
export const PANEL_VIEW_TYPE = 'revspan';

const HOME_ROUTE = '/';

const PR_ROUTE = /^\/pr\/([^/]+)\/([^/]+)\/(\d+)/;

/** Lecture d'API propre à un écran (hors PR) → route de cet écran. */
const SCREENS = new Map([['/home', HOME_ROUTE], ['/settings', '/settings']]);

/** Titre de l'onglet pour une route de la page (même règle à l'ouverture et pendant la navigation). */
export function panelTitle(t: Translate, route: string): string {
    const match = PR_ROUTE.exec(route);
    if (match) {
        return `PR #${match[3]} · ${match[2]}`;
    }
    return route.startsWith('/settings') ? t('Revspan · Settings') : 'Revspan';
}

/**
 * Écran de la page qui fait cette lecture d'API (ex. GET /api/home → « / »), pour garder le titre à jour quand
 * on navigue dans la page ; null pour une écriture ou une autre lecture. Chaque écran lit sa propre route d'API.
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

/** Route enregistrée par la page dans l'état du panneau (PanelState) ; l'accueil si l'état est absent ou invalide. */
export function restoredRoute(state: unknown): string {
    const route = typeof state === 'object' && state !== null ? (state as Partial<Record<keyof PanelState, unknown>>).route : undefined;
    return isPageRoute(route) ? route : HOME_ROUTE;
}
