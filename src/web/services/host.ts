// Page hosted in a VS Code panel: exchanges with the extension (src/shared/webview-protocol.ts).
// Outside VS Code, isVsCode is false and nothing here is used.
import type { PrRef } from '../../shared/api.ts';
import { INITIAL_LOCALE_META, INITIAL_ROUTE_META, isPageRoute, type HostToWebview, type PanelState, type WebviewToHost } from '../../shared/webview-protocol.ts';

interface VsCodeApi {
    postMessage(message: WebviewToHost): void;
    setState(state: PanelState): void;
}

type HostGlobal = typeof globalThis & { acquireVsCodeApi?: () => VsCodeApi };

/** Response relayed by the extension (HTTP status and JSON body). */
export interface HostResponse {
    status: number;
    body: unknown;
}

// Generous timeout: the first summary computation of a long PR can take several seconds.
const REQUEST_TIMEOUT_MS = 120000;

// acquireVsCodeApi can only be called once per page.
const acquire = (globalThis as HostGlobal).acquireVsCodeApi;
const vscode: VsCodeApi | null = typeof acquire === 'function' ? acquire() : null;

export const isVsCode = vscode !== null;

export function postToHost(message: WebviewToHost): void {
    vscode?.postMessage(message);
}

function isHostMessage(data: unknown): data is HostToWebview {
    if (typeof data !== 'object' || data === null) {
        return false;
    }
    const msg = data as Partial<Record<'type' | 'id' | 'status' | 'route', unknown>>;
    return (msg.type === 'response' && typeof msg.id === 'number' && typeof msg.status === 'number')
        || (msg.type === 'navigate' && typeof msg.route === 'string');
}

/** Listens to the extension's messages; returns the unsubscribe function. */
export function onHostMessage(handler: (message: HostToWebview) => void): () => void {
    const listener = (event: MessageEvent): void => {
        if (isHostMessage(event.data)) {
            handler(event.data);
        }
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
}

const pending = new Map<number, (response: HostResponse) => void>();
let nextId = 1;
let listening = false;

/** Local API call relayed by the extension (full path, e.g. "/api/home"). Rejects if the extension does not answer. */
export function hostRequest(method: string, path: string, body?: unknown): Promise<HostResponse> {
    if (!vscode) {
        return Promise.reject(new Error('Not in VS Code'));
    }
    if (!listening) {
        listening = true;
        onHostMessage((message) => {
            if (message.type === 'response') {
                pending.get(message.id)?.({ status: message.status, body: message.body });
                pending.delete(message.id);
            }
        });
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`No response from the extension for ${method} ${path}`));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, (response) => {
            clearTimeout(timer);
            resolve(response);
        });
        postToHost(body === undefined ? { type: 'request', id, method, path } : { type: 'request', id, method, path, body });
    });
}

/** Saves the displayed route: VS Code gives it back to the extension to reopen the panel at the same place ("Reload Window"). */
export function rememberRoute(route: string): void {
    vscode?.setState({ route });
}

/** Opens the file of the locally cloned repository, at the given line (1-based) or at the start. */
export function openLocalFile(ref: PrRef, path: string, line: number | null): void {
    postToHost({ type: 'openFile', ref: { ...ref }, path, line });
}

/** Opens the file's comparison in VS Code's diff editor (from = 0: against the base). */
export function openNativeDiff(ref: PrRef, from: number, to: number, path: string, oldPath: string | null): void {
    postToHost({ type: 'openDiff', ref: { ...ref }, from, to, path, oldPath });
}

/** Route initially given by the extension (<meta name="revspan-route" content="/pr/ws/repo/42">), or null. */
export function readInitialRoute(doc: Document): string | null {
    const content = doc.querySelector(`meta[name="${INITIAL_ROUTE_META}"]`)?.getAttribute('content')?.trim();
    return isPageRoute(content) ? content : null;
}

/** Language imposed by the host (<meta name="revspan-locale" content="fr">), or null: the browser language applies. */
export function readInitialLocale(doc: Document): string | null {
    return doc.querySelector(`meta[name="${INITIAL_LOCALE_META}"]`)?.getAttribute('content')?.trim() || null;
}
