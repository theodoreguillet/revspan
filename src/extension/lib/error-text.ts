// Error messages shown by the extension (tree, notifications), with the same texts as the page (src/web/i18n).
import { errorMessageOf, type ErrorLike } from '../../shared/error-text.ts';
import type { Translate } from './l10n.ts';

export function errorText(t: Translate, error: ErrorLike): string {
    const message = errorMessageOf(error);
    if (message === null) {
        return error.message;
    }
    switch (message.id) {
        case 'network':
        case 'networkExtension':
        case 'http':
            // Seen only by the page (no answer from the server or the extension): never raised in the extension.
            return error.message;
        case 'noToken':
            return t('No Bitbucket token is configured. Open the settings to add one.');
        case 'unauthorized':
            return t('Bitbucket rejected the token (invalid or expired). Renew it in the settings.');
        case 'forbidden':
            return t('Missing Bitbucket permission for this action.');
        case 'forbiddenDetail':
            return t('Missing Bitbucket permission for this action: {detail}', { detail: message.detail });
        case 'profileUnreadable':
            return t('Connected, but the profile can’t be read: add the read:user:bitbucket scope to the token.');
        case 'notFound':
            return t('Not found on Bitbucket: {path}', { path: message.path });
        case 'noVersions':
            return t('No version found for this PR.');
        case 'unreachable':
            return t('Bitbucket can’t be reached ({detail})', { detail: message.detail });
        case 'bitbucket':
            return t('Bitbucket error {status} on {path}', { status: message.status, path: message.path });
        case 'bitbucketDetail':
            return t('Bitbucket error {status} on {path}: {detail}', { status: message.status, path: message.path, detail: message.detail });
        case 'versionUnavailable':
            return t('Version v{version} is no longer available: Bitbucket deleted its commit (version overwritten by a force-push).', { version: message.version });
        case 'invalidEmail':
            return t('Invalid email address.');
        case 'emailRequired':
            return t('Enter the Atlassian account email first.');
        case 'refused':
            return t('Request refused.');
        case 'internal':
            return t('Revspan internal error: {detail}', { detail: message.detail });
        case 'reloadWindow':
            return t('Revspan was just updated: reload the VS Code window (Developer: Reload Window) to save settings.');
    }
}
