// Typed client of the local API: HTTP to the server, or messages to the extension in a VS Code panel.
// Every non-GET request carries the X-Revspan: 1 header (added by the extension in VS Code) and a JSON body.
import {
    MUTATION_HEADER,
    type ApiErrorBody,
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
import { tr } from '../i18n/index.ts';
import { errorText, type ApiErrorCode, type PageErrorParams } from '../lib/errors.ts';
import { hostRequest, isVsCode, type HostResponse } from './host.ts';

export type { ApiErrorCode } from '../lib/errors.ts';

/** Error of the local API: `message` is the server's (English) message, translated for display by errorInfo(). */
export class ApiError extends Error {
    readonly status: number;
    readonly code: ApiErrorCode;
    readonly params: PageErrorParams;

    constructor(status: number, code: ApiErrorCode, message: string, params: PageErrorParams = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.params = params;
    }
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** HTTP to the local server (web version). */
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

/** Messages to the extension, which calls the API and adds the X-Revspan header itself (VS Code panel). */
function vsCodeTransport(method: Method, path: string, body: unknown): Promise<HostResponse> {
    // JSON copy: same content as over HTTP, and cloneable by postMessage (no reactive object)
    return hostRequest(method, path, body === undefined ? undefined : JSON.parse(JSON.stringify(body)));
}

async function request<T>(method: Method, path: string, payload?: unknown): Promise<T> {
    // every non-GET request carries a JSON body
    const body = method === 'GET' ? undefined : payload ?? {};
    let response: HostResponse;
    try {
        response = await (isVsCode ? vsCodeTransport : httpTransport)(method, `/api${path}`, body);
    } catch {
        throw isVsCode
            ? new ApiError(0, 'NETWORK', 'The Revspan extension is not responding.', { via: 'extension' })
            : new ApiError(0, 'NETWORK', 'The Revspan server cannot be reached.');
    }
    if (response.status < 200 || response.status >= 300) {
        const err = (response.body as Partial<ApiErrorBody> | null)?.error;
        throw new ApiError(response.status, err?.code ?? `HTTP_${response.status}`, err?.message ?? `Error ${response.status}`, err?.params);
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

/** Token errors: we offer to open the settings. */
export const AUTH_CODES: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>(['NO_TOKEN', 'BB_UNAUTHORIZED']);

/** Message to show (translated in the current locale) and error code. */
export function errorInfo(error: unknown): { message: string; code: ApiErrorCode | null } {
    if (error instanceof ApiError) {
        return { message: errorText(tr(), error), code: error.code };
    }
    return { message: error instanceof Error ? error.message : String(error), code: null };
}
