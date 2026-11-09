// Messages exchanged between the page (in a VS Code panel) and the extension.
// Outside VS Code, the page talks to the server over HTTP; inside VS Code, it uses these messages.
import type { PrRef } from './api.ts';

/** Page -> extension. */
export type WebviewToHost =
    /** Call to the local API (same path and same body as over HTTP, e.g. "/api/pr/ws/repo/42"). */
    | { type: 'request'; id: number; method: string; path: string; body?: unknown }
    /** Open the file of the locally cloned repository, at a line (1-based) or at the start. */
    | { type: 'openFile'; ref: PrRef; path: string; line: number | null }
    /** Open a file's comparison in VS Code's diff editor (from = 0: against the base). */
    | { type: 'openDiff'; ref: PrRef; from: number; to: number; path: string; oldPath: string | null };

/** Extension -> page. */
export type HostToWebview =
    /** Response to a request (HTTP status, JSON body or null). */
    | { type: 'response'; id: number; status: number; body: unknown }
    /** Show a page route (e.g. "/pr/ws/repo/42", "/settings"). */
    | { type: 'navigate'; route: string };

/** <meta> tag through which the extension gives the initial route to the page. */
export const INITIAL_ROUTE_META = 'revspan-route';

/** <meta> tag through which the extension imposes the page language (VS Code display language, e.g. "fr", "en-us"). */
export const INITIAL_LOCALE_META = 'revspan-locale';

/** Panel state saved by the page (vscode.setState), restored by VS Code when it reopens the panel. */
export interface PanelState {
    /** Route shown (e.g. "/pr/ws/repo/42?from=2&to=6"). */
    route: string;
}

/** Page path ("/..."), never an address from another origin ("//host/...", "https:..."). */
export const isPageRoute = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');
