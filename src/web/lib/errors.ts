// Error messages shown by the page, translated from the error code and its parameters. The server's own message
// (English) is the fallback: unknown code, or a rare error without the parameters the translation needs.
import type { ErrorCode, ErrorParams } from '../../shared/api.ts';
import type { Translator } from '../i18n/index.ts';

/** Contract codes, plus errors seen only by the page (server unreachable, response without an error body). */
export type ApiErrorCode = ErrorCode | 'NETWORK' | `HTTP_${number}`;

export interface PageErrorParams extends ErrorParams {
    /** NETWORK: the VS Code extension did not answer (instead of the local server). */
    via?: 'extension';
}

export interface ErrorLike {
    code: ApiErrorCode;
    message: string;
    params?: PageErrorParams;
}

const HTTP_CODE = /^HTTP_(\d+)$/;

function bitbucketText(tr: Translator, { code, message, params = {} }: ErrorLike): string {
    const { reason, path, status, detail } = params;
    switch (code) {
        case 'BB_UNAUTHORIZED':
            return tr.t('error.unauthorized');
        case 'BB_FORBIDDEN':
            if (reason === 'profile-unreadable') {
                return tr.t('error.profileUnreadable');
            }
            return detail ? tr.t('error.forbiddenDetail', { detail }) : tr.t('error.forbidden');
        case 'BB_NOT_FOUND':
            if (reason === 'no-versions') {
                return tr.t('error.noVersions');
            }
            return path ? tr.t('error.notFound', { path }) : message;
        case 'BB_UNREACHABLE':
            return detail ? tr.t('error.unreachable', { detail }) : message;
        default:
            if (status == null || !path) {
                return message;
            }
            return detail ? tr.t('error.bitbucketDetail', { status, path, detail }) : tr.t('error.bitbucket', { status, path });
    }
}

export function errorText(tr: Translator, error: ErrorLike): string {
    const { code, message, params = {} } = error;
    switch (code) {
        case 'NETWORK':
            return params.via === 'extension' ? tr.t('error.networkExtension') : tr.t('error.network');
        case 'NO_TOKEN':
            return tr.t('error.noToken');
        case 'BB_UNAUTHORIZED':
        case 'BB_FORBIDDEN':
        case 'BB_NOT_FOUND':
        case 'BB_UNREACHABLE':
        case 'BB_ERROR':
            return bitbucketText(tr, error);
        case 'VERSION_UNAVAILABLE':
            return params.version == null ? message : tr.t('error.versionUnavailable', { version: params.version });
        case 'BAD_REQUEST':
            if (params.reason === 'invalid-email') {
                return tr.t('error.invalidEmail');
            }
            return params.reason === 'email-required' ? tr.t('error.emailRequired') : message;
        case 'FORBIDDEN':
            return tr.t('error.refused');
        case 'INTERNAL':
            return params.detail == null ? message : tr.t('error.internal', { detail: params.detail });
        default: {
            const status = HTTP_CODE.exec(code)?.[1];
            return status ? tr.t('error.http', { status }) : message;
        }
    }
}
