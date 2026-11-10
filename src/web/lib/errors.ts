// Error messages shown by the page, translated from the error code and its parameters. The server's own message
// (English) is the fallback: unknown code, or a rare error without the parameters the translation needs.
// The choice of message is shared with the VS Code extension (src/shared/error-text.ts).
import { errorMessageOf, type ErrorLike, type ErrorMessage } from '../../shared/error-text.ts';
import type { Translator } from '../i18n/index.ts';

export type { ClientErrorCode as ApiErrorCode, ClientErrorParams as PageErrorParams, ErrorLike } from '../../shared/error-text.ts';

function messageText(tr: Translator, message: ErrorMessage): string {
    switch (message.id) {
        case 'network':
            return tr.t('error.network');
        case 'networkExtension':
            return tr.t('error.networkExtension');
        case 'http':
            return tr.t('error.http', { status: message.status });
        case 'noToken':
            return tr.t('error.noToken');
        case 'unauthorized':
            return tr.t('error.unauthorized');
        case 'forbidden':
            return tr.t('error.forbidden');
        case 'forbiddenDetail':
            return tr.t('error.forbiddenDetail', { detail: message.detail });
        case 'profileUnreadable':
            return tr.t('error.profileUnreadable');
        case 'notFound':
            return tr.t('error.notFound', { path: message.path });
        case 'noVersions':
            return tr.t('error.noVersions');
        case 'unreachable':
            return tr.t('error.unreachable', { detail: message.detail });
        case 'bitbucket':
            return tr.t('error.bitbucket', { status: message.status, path: message.path });
        case 'bitbucketDetail':
            return tr.t('error.bitbucketDetail', { status: message.status, path: message.path, detail: message.detail });
        case 'versionUnavailable':
            return tr.t('error.versionUnavailable', { version: message.version });
        case 'invalidEmail':
            return tr.t('error.invalidEmail');
        case 'emailRequired':
            return tr.t('error.emailRequired');
        case 'refused':
            return tr.t('error.refused');
        case 'internal':
            return tr.t('error.internal', { detail: message.detail });
        case 'reloadWindow':
            return tr.t('error.reloadWindow');
    }
}

export function errorText(tr: Translator, error: ErrorLike): string {
    const message = errorMessageOf(error);
    return message === null ? error.message : messageText(tr, message);
}
