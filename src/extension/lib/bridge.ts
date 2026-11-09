// Pont page → API : une requête reçue par message est traitée par l'application HTTP en mémoire (sans port ouvert),
// avec la même validation, les mêmes erreurs et les mêmes contrôles que le serveur local.
import { MUTATION_HEADER } from '../../shared/api.ts';

/** Hôte fictif des appels en mémoire (doit faire partie des hôtes acceptés par l'application HTTP). */
export const IN_MEMORY_HOST = 'revspan.vscode';

/** Ce dont le pont a besoin de l'application Hono. */
export interface InMemoryApp {
    request(input: string, init: RequestInit): Response | Promise<Response>;
}

export interface ApiCall {
    method: string;
    path: string;
    body?: unknown;
}

export interface ApiResult {
    status: number;
    body: unknown;
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

export async function callApi(app: InMemoryApp, { method, path, body }: ApiCall): Promise<ApiResult> {
    if (!METHODS.has(method) || !path.startsWith('/api/')) {
        return { status: 400, body: { error: { code: 'BAD_REQUEST', message: `Request refused: ${method} ${path}` } } };
    }
    const init: RequestInit = { method, headers: { 'Content-Type': 'application/json', [MUTATION_HEADER]: '1' } };
    if (method !== 'GET') {
        init.body = JSON.stringify(body ?? {});
    }
    const response = await app.request(`http://${IN_MEMORY_HOST}${path}`, init);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) as unknown : null };
}

/** Une écriture réussie peut changer l'accueil (approbation, commentaire, jeton…). */
export const isSuccessfulWrite = ({ method }: ApiCall, { status }: ApiResult): boolean => method !== 'GET' && status < 400;
