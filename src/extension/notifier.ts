// Background refresh of "My PRs" and the VS Code notifications it raises (rules in lib/notifications.ts).
import * as vscode from 'vscode';
import type { Store } from '../server/infra/config.ts';
import type { HomeService } from '../server/services/home-service.ts';
import type { BitbucketSession } from '../server/services/session.ts';
import { planNotifications, type PendingNotification } from './lib/notifications.ts';

/** First poll after activation: late enough not to slow VS Code's startup. */
const STARTUP_DELAY_MS = 10_000;
const MINUTE_MS = 60_000;

function messageOf(notification: PendingNotification): string {
    const { title, author } = notification;
    switch (notification.kind) {
        case 'newPullRequest':
            return author
                ? vscode.l10n.t('New PR to review from {author}: {title}', { author, title })
                : vscode.l10n.t('New PR to review: {title}', { title });
        case 'newVersion':
            return vscode.l10n.t('New version to review: {title}', { title });
        case 'buildFailed':
            return vscode.l10n.t('Build failed on your PR: {title}', { title });
    }
}

export class Notifier implements vscode.Disposable {
    private readonly store: Store;
    private readonly session: BitbucketSession;
    private readonly home: HomeService;
    private readonly onPolled: () => void;
    private startup: NodeJS.Timeout | undefined;
    private interval: NodeJS.Timeout | undefined;
    private polling = false;
    private disposed = false;

    /** onPolled: called after each completed poll (the home was just read, the tree can show it). */
    constructor({ store, session, home, onPolled }: { store: Store; session: BitbucketSession; home: HomeService; onPolled: () => void }) {
        this.store = store;
        this.session = session;
        this.home = home;
        this.onPolled = onPolled;
    }

    /** One poll shortly after startup, then one every revspan.refreshIntervalMinutes. */
    start(startupDelayMs = STARTUP_DELAY_MS): void {
        this.startup = setTimeout(() => void this.poll(), startupDelayMs);
        this.rearm();
    }

    /** Restarts the interval from the current setting (called when it changes). */
    rearm(): void {
        clearInterval(this.interval);
        if (!this.disposed) {
            this.interval = setInterval(() => void this.poll(), this.store.config.review.refreshMinutes * MINUTE_MS);
        }
    }

    /**
     * Refreshes the home and shows what is new. Skipped without a token, without repositories or when the profile
     * (me) is unknown; never throws (a timer has nobody to report to).
     */
    async poll(): Promise<void> {
        if (this.polling || this.disposed) {
            return;
        }
        this.polling = true;
        try {
            const pending = await this.collect();
            if (pending === null || this.disposed) {
                return;
            }
            this.onPolled();
            for (const notification of pending) {
                this.show(notification).catch((error: unknown) => console.warn(`revspan: notification failed (${(error as Error).message})`));
            }
        } catch (error) {
            console.warn(`revspan: background refresh failed (${(error as Error).message})`);
        } finally {
            this.polling = false;
        }
    }

    dispose(): void {
        this.disposed = true;
        clearTimeout(this.startup);
        clearInterval(this.interval);
    }

    /** Notifications this window must show; null when the cycle is skipped. */
    private async collect(): Promise<PendingNotification[] | null> {
        if (this.store.config.repos.length === 0 || !await this.session.hasToken()) {
            return null;
        }
        // Not fresh: the TTL caches of the home, PR lists, activities and statuses keep each poll cheap on the
        // Bitbucket API; only the explicit "Refresh" command bypasses them.
        const home = await this.home.get();
        if (!home.me) {
            return null;
        }
        const prefs = this.store.config.review.notifications;
        let pending: PendingNotification[] = [];
        // Planned on the state re-read from disk inside the update: a PR head another window already recorded (and
        // notified) is no longer new here, so each notification is shown by one window only.
        this.store.updateNotified((state) => {
            const plan = planNotifications(home, prefs, state);
            state.initialized = plan.next.initialized;
            state.seen = plan.next.seen;
            pending = plan.notifications;
        });
        return pending;
    }

    private async show(notification: PendingNotification): Promise<void> {
        const open = vscode.l10n.t('Open');
        const message = messageOf(notification);
        const choice = notification.kind === 'buildFailed'
            ? await vscode.window.showWarningMessage(message, open)
            : await vscode.window.showInformationMessage(message, open);
        if (choice === open) {
            await vscode.commands.executeCommand('revspan.openPr', notification.ref);
        }
    }
}
