// Which message to show for an API error, chosen from its code and parameters. The page and the VS Code extension
// each render the chosen message in their own language. null means the server's own (English) message is shown:
// unknown code, or a rare error without the parameters the translation needs.
import type { ErrorCode, ErrorParams } from './api.ts';

/** Contract codes, plus errors seen only by a client (server unreachable, response without an error body). */
export type ClientErrorCode = ErrorCode | 'NETWORK' | `HTTP_${number}`;

export interface ClientErrorParams extends ErrorParams {
    /** NETWORK: the VS Code extension did not answer (instead of the local server). */
    via?: 'extension';
}

export interface ErrorLike {
    code: ClientErrorCode;
    message: string;
    params?: ClientErrorParams;
}

/** A translatable error message and the values it shows (Bitbucket's own text, path, status, version). */
export type ErrorMessage =
    | { id: 'network' | 'networkExtension' | 'noToken' | 'unauthorized' | 'forbidden' | 'profileUnreadable' | 'noVersions' | 'invalidEmail' | 'emailRequired' | 'refused' | 'reloadWindow' }
    | { id: 'forbiddenDetail' | 'unreachable' | 'internal'; detail: string }
    | { id: 'notFound'; path: string }
    | { id: 'bitbucket'; status: number; path: string }
    | { id: 'bitbucketDetail'; status: number; path: string; detail: string }
    | { id: 'versionUnavailable'; version: number }
    | { id: 'http'; status: string };

const HTTP_CODE = /^HTTP_(\d+)$/;

function bitbucketMessage({ code, params = {} }: ErrorLike): ErrorMessage | null {
    const { reason, path, status, detail } = params;
    switch (code) {
        case 'BB_UNAUTHORIZED':
            return { id: 'unauthorized' };
        case 'BB_FORBIDDEN':
            if (reason === 'profile-unreadable') {
                return { id: 'profileUnreadable' };
            }
            return detail ? { id: 'forbiddenDetail', detail } : { id: 'forbidden' };
        case 'BB_NOT_FOUND':
            if (reason === 'no-versions') {
                return { id: 'noVersions' };
            }
            return path ? { id: 'notFound', path } : null;
        case 'BB_UNREACHABLE':
            return detail ? { id: 'unreachable', detail } : null;
        default:
            if (status == null || !path) {
                return null;
            }
            return detail ? { id: 'bitbucketDetail', status, path, detail } : { id: 'bitbucket', status, path };
    }
}

export function errorMessageOf(error: ErrorLike): ErrorMessage | null {
    const { code, params = {} } = error;
    switch (code) {
        case 'NETWORK':
            return { id: params.via === 'extension' ? 'networkExtension' : 'network' };
        case 'NO_TOKEN':
            return { id: 'noToken' };
        case 'BB_UNAUTHORIZED':
        case 'BB_FORBIDDEN':
        case 'BB_NOT_FOUND':
        case 'BB_UNREACHABLE':
        case 'BB_ERROR':
            return bitbucketMessage(error);
        case 'VERSION_UNAVAILABLE':
            return params.version == null ? null : { id: 'versionUnavailable', version: params.version };
        case 'BAD_REQUEST':
            if (params.reason === 'invalid-email') {
                return { id: 'invalidEmail' };
            }
            return params.reason === 'email-required' ? { id: 'emailRequired' } : null;
        case 'FORBIDDEN':
            return { id: 'refused' };
        case 'INTERNAL':
            return params.detail == null ? null : { id: 'internal', detail: params.detail };
        case 'SETTING_UNREGISTERED':
            return { id: 'reloadWindow' };
        default: {
            const status = HTTP_CODE.exec(code)?.[1];
            return status ? { id: 'http', status } : null;
        }
    }
}
