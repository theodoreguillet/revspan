// Client typé de l'API locale : HTTP vers le serveur, ou messages à l'extension dans un panneau VS Code.
// Toute requête non-GET porte l'en-tête X-Revspan: 1 (ajouté par l'extension dans VS Code) et un corps JSON.
import {
    MUTATION_HEADER,
    type ApiErrorBody,
    type ErrorCode,
    type Comment,
    type Comparison,
    type ConnectionTest,
    type Home,
    type NewComment,
    type Ok,
    type PrDetail,
    type PrRef,
    type Settings,
    type SettingsUpdate,
    type Summary,
    type ViewedRequest,
} from '../../shared/api.ts';
import { hostRequest, isVsCode, type HostResponse } from './host.ts';

/** Codes du contrat, plus les erreurs vues seulement par la page (serveur injoignable, réponse sans corps d'erreur). */
export type ApiErrorCode = ErrorCode | 'NETWORK' | `HTTP_${number}`;

export class ApiError extends Error {
    readonly status: number;
    readonly code: ApiErrorCode;

    constructor(status: number, code: ApiErrorCode, message: string) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
    }
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** HTTP vers le serveur local (version web). */
async function httpTransport(method: Method, path: string, body: unknown): Promise<HostResponse> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const init: RequestInit = { method, headers, credentials: 'same-origin' };
    if (body !== undefined) {
        headers[MUTATION_HEADER] = '1';
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    const res = await fetch(path, init);
    const text = await res.text();
    let data: unknown = null;
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            data = null;
        }
    }
    return { status: res.status, body: data };
}

/** Messages à l'extension, qui appelle l'API et ajoute elle-même l'en-tête X-Revspan (panneau VS Code). */
function vsCodeTransport(method: Method, path: string, body: unknown): Promise<HostResponse> {
    // copie JSON : même contenu qu'en HTTP, et clonable par postMessage (pas d'objet réactif)
    return hostRequest(method, path, body === undefined ? undefined : JSON.parse(JSON.stringify(body)));
}

async function request<T>(method: Method, path: string, payload?: unknown): Promise<T> {
    // toute requête non-GET porte un corps JSON
    const body = method === 'GET' ? undefined : payload ?? {};
    let response: HostResponse;
    try {
        response = await (isVsCode ? vsCodeTransport : httpTransport)(method, `/api${path}`, body);
    } catch {
        throw new ApiError(0, 'NETWORK', isVsCode
            ? 'L\'extension Revspan ne répond pas. Rouvrir le panneau peut aider.'
            : 'Serveur Revspan injoignable. Est-il toujours lancé ?');
    }
    if (response.status < 200 || response.status >= 300) {
        const err = (response.body as Partial<ApiErrorBody> | null)?.error;
        throw new ApiError(response.status, err?.code ?? `HTTP_${response.status}`, err?.message ?? `Erreur ${response.status}`);
    }
    return response.body as T;
}

const prPath = (ref: PrRef): string => `/pr/${encodeURIComponent(ref.workspace)}/${encodeURIComponent(ref.repo)}/${ref.id}`;

export const api = {
    settings: () => request<Settings>('GET', '/settings'),
    saveSettings: (update: SettingsUpdate) => request<Settings>('PUT', '/settings', update),
    testConnection: () => request<ConnectionTest>('POST', '/settings/test', {}),
    home: () => request<Home>('GET', '/home'),

    pr: (ref: PrRef) => request<PrDetail>('GET', prPath(ref)),
    summary: (ref: PrRef) => request<Summary>('GET', `${prPath(ref)}/summary`),
    compare: (ref: PrRef, from: number, to: number, context: number) =>
        request<Comparison>('GET', `${prPath(ref)}/compare?from=${from}&to=${to}&context=${context}`),

    comment: (ref: PrRef, body: NewComment) => request<Comment>('POST', `${prPath(ref)}/comments`, body),
    deleteComment: (ref: PrRef, id: number) => request<Ok>('DELETE', `${prPath(ref)}/comments/${id}`),
    resolve: (ref: PrRef, threadId: number, resolved: boolean) =>
        request<Ok>(resolved ? 'POST' : 'DELETE', `${prPath(ref)}/comments/${threadId}/resolve`),
    approve: (ref: PrRef, approved: boolean) => request<Ok>(approved ? 'POST' : 'DELETE', `${prPath(ref)}/approve`),
    requestChanges: (ref: PrRef, on: boolean) => request<Ok>(on ? 'POST' : 'DELETE', `${prPath(ref)}/request-changes`),
    reviewed: (ref: PrRef, version: number) => request<Ok>('POST', `${prPath(ref)}/reviewed`, { version }),
    viewed: (ref: PrRef, body: ViewedRequest) => request<Ok>('POST', `${prPath(ref)}/viewed`, body),
};

/** Erreurs de jeton : on propose d'ouvrir les réglages. */
export const AUTH_CODES: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>(['NO_TOKEN', 'BB_UNAUTHORIZED']);

export function errorInfo(error: unknown): { message: string; code: ApiErrorCode | null } {
    if (error instanceof ApiError) {
        return { message: error.message, code: error.code };
    }
    return { message: error instanceof Error ? error.message : String(error), code: null };
}
