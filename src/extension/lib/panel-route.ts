// Route affichée par le panneau : titre de l'onglet, et écran déduit des lectures d'API de la page.

const PR_ROUTE = /^\/pr\/([^/]+)\/([^/]+)\/(\d+)/;

/** Lecture d'API propre à un écran (hors PR) → route de cet écran. */
const SCREENS = new Map([['/home', '/'], ['/settings', '/settings']]);

/** Titre de l'onglet pour une route de la page (même règle à l'ouverture et pendant la navigation). */
export function panelTitle(route: string): string {
    const match = PR_ROUTE.exec(route);
    if (match) {
        return `PR #${match[3]} · ${match[2]}`;
    }
    return route.startsWith('/settings') ? 'Revspan · Réglages' : 'Revspan';
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
