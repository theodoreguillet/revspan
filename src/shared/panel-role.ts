// Role of a Revspan tab in VS Code, fixed when the tab opens: the "Revspan" tab (home page and settings) or the tab
// of one PR. The page asks the extension for any route of another role, which shows it in that role's tab.

/** "home" or "pr:<workspace>/<repo>/<id>" (decoded segments). */
export type PanelRole = 'home' | `pr:${string}`;

/** PR page route (as the page's router matches it: number id, optional trailing slash, then query or end). */
export const PR_ROUTE = /^\/pr\/([^/?#]+)\/([^/?#]+)\/(\d+)\/?(?=[?#]|$)/;

function decoded(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

/** "/pr/ws/repo/42?from=1&to=3" -> "pr:ws/repo/42"; any other route (home, settings, unknown) -> "home". */
export function roleOfRoute(route: string): PanelRole {
    const match = PR_ROUTE.exec(route);
    return match ? `pr:${decoded(match[1] ?? '')}/${decoded(match[2] ?? '')}/${match[3] ?? ''}` : 'home';
}
