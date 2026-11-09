// Page hébergée dans un panneau VS Code : échanges avec l'extension (src/shared/webview-protocol.ts).
// Hors de VS Code, isVsCode est faux et rien ici n'est utilisé.
import type { PrRef } from '../../shared/api.ts';
import { INITIAL_ROUTE_META, isPageRoute, type HostToWebview, type PanelState, type WebviewToHost } from '../../shared/webview-protocol.ts';

interface VsCodeApi {
    postMessage(message: WebviewToHost): void;
    setState(state: PanelState): void;
}

type HostGlobal = typeof globalThis & { acquireVsCodeApi?: () => VsCodeApi };

/** Réponse relayée par l'extension (statut HTTP et corps JSON). */
export interface HostResponse {
    status: number;
    body: unknown;
}

// Délai large : le premier calcul du résumé d'une longue PR peut prendre plusieurs secondes.
const REQUEST_TIMEOUT_MS = 120000;

// acquireVsCodeApi ne peut être appelé qu'une seule fois par page.
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

/** Écoute les messages de l'extension ; renvoie la fonction de désabonnement. */
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

/** Appel de l'API locale relayé par l'extension (path complet, ex. « /api/home »). Rejette si l'extension ne répond pas. */
export function hostRequest(method: string, path: string, body?: unknown): Promise<HostResponse> {
    if (!vscode) {
        return Promise.reject(new Error('Pas dans VS Code'));
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
            reject(new Error(`Pas de réponse de l'extension pour ${method} ${path}`));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, (response) => {
            clearTimeout(timer);
            resolve(response);
        });
        postToHost(body === undefined ? { type: 'request', id, method, path } : { type: 'request', id, method, path, body });
    });
}

/** Enregistre la route affichée : VS Code la rend à l'extension pour rouvrir le panneau au même endroit (« Recharger la fenêtre »). */
export function rememberRoute(route: string): void {
    vscode?.setState({ route });
}

/** Ouvre le fichier du dépôt cloné localement, à la ligne donnée (1-based) ou au début. */
export function openLocalFile(ref: PrRef, path: string, line: number | null): void {
    postToHost({ type: 'openFile', ref: { ...ref }, path, line });
}

/** Ouvre la comparaison du fichier dans l'éditeur de diff de VS Code (from = 0 : contre la base). */
export function openNativeDiff(ref: PrRef, from: number, to: number, path: string, oldPath: string | null): void {
    postToHost({ type: 'openDiff', ref: { ...ref }, from, to, path, oldPath });
}

/** Route initiale donnée par l'extension (<meta name="revspan-route" content="/pr/ws/repo/42">), ou null. */
export function readInitialRoute(doc: Document): string | null {
    const content = doc.querySelector(`meta[name="${INITIAL_ROUTE_META}"]`)?.getAttribute('content')?.trim();
    return isPageRoute(content) ? content : null;
}
