import type { PendingNotification } from './notifications.ts';
import { plainMessageText } from './plain-text.ts';

/** `vscode.l10n.t` shape: the message is the l10n key, the arguments fill its placeholders. */
export type Translate = (message: string, args: Record<string, string>) => string;

/** The toast text of a notification. The PR title and author come from Bitbucket: they never reach the toast as a link. */
export function notificationMessage(t: Translate, notification: Pick<PendingNotification, 'kind' | 'title' | 'author'>): string {
    const title = plainMessageText(notification.title);
    const author = notification.author === null ? null : plainMessageText(notification.author);
    switch (notification.kind) {
        case 'newPullRequest':
            return author
                ? t('New PR to review from {author}: {title}', { author, title })
                : t('New PR to review: {title}', { title });
        case 'newVersion':
            return t('New version to review: {title}', { title });
        case 'buildFailed':
            return t('Build failed on your PR: {title}', { title });
    }
}
