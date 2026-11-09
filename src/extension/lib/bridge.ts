// Page -> API bridge: a request received as a message is handled by the in-memory HTTP application (no open port),
// with the same validation, the same errors and the same checks as the local server.
import { MUTATION_HEADER } from '../../shared/api.ts';

/** Fictitious host of in-memory calls (must be one of the hosts accepted by the HTTP application). */
export const IN_MEMORY_HOST = 'revspan.vscode';

/** What the bridge needs from the Hono application. */
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

/** A successful write can change the home page (approval, comment, token...). */
export const isSuccessfulWrite = ({ method }: ApiCall, { status }: ApiResult): boolean => method !== 'GET' && status < 400;
