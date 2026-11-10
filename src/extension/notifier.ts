// Background refresh of "My PRs" and the VS Code notifications it raises (rules in lib/notifications.ts).
import * as vscode from 'vscode';
import type { Home } from '../shared/api.ts';
import { prKeyOf, type Store } from '../server/infra/config.ts';
import type { HomeService } from '../server/services/home-service.ts';
import type { PrService } from '../server/services/pr-service.ts';
import type { BitbucketSession } from '../server/services/session.ts';
import { hostL10n } from './host-l10n.ts';
import {
    capNotifications, codeChangedSince, planNotifications, versionCandidates, type CodeChanges, type PendingNotification, type VersionCandidate,
} from './lib/notifications.ts';

/** First poll after activation: late enough not to slow VS Code's startup. */
const STARTUP_DELAY_MS = 10_000;
const MINUTE_MS = 60_000;
/** Toasts shown one by one per poll; the rest are gathered in one summary toast. */
const MAX_TOASTS = 3;
/** Version summaries computed at the same time to tell code from rebases. */
const SUMMARY_CONCURRENCY = 2;
/** Command VS Code generates to focus the "My PRs" view. */
const FOCUS_VIEW_COMMAND = 'revspan.home.focus';

/** Runs `task` on every item, at most `limit` at a time. */
async function eachLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
    const queue = [...items];
    const worker = async (): Promise<void> => {
        for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
            await task(item);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}

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
    private readonly prs: Pick<PrService, 'versionKinds'>;
    private readonly onPolled: () => void;
    private readonly isVisible: () => boolean;
    private startup: NodeJS.Timeout | undefined;
    private interval: NodeJS.Timeout | undefined;
    private polling = false;
    private disposed = false;

    /**
     * onPolled: called after each completed poll (the home was just read, the tree can show it).
     * isVisible: whether a Revspan view or panel is on screen (with every notification off, nothing else needs a poll).
     */
    constructor({ store, session, home, prs, onPolled, isVisible = () => false }: {
        store: Store;
        session: BitbucketSession;
        home: HomeService;
        prs: Pick<PrService, 'versionKinds'>;
        onPolled: () => void;
        isVisible?: () => boolean;
    }) {
        this.store = store;
        this.session = session;
        this.home = home;
        this.prs = prs;
        this.onPolled = onPolled;
        this.isVisible = isVisible;
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
            const { shown, overflow } = capNotifications(pending, MAX_TOASTS);
            const failed = (error: unknown): void => console.warn(`revspan: notification failed (${(error as Error).message})`);
            for (const notification of shown) {
                this.show(notification).catch(failed);
            }
            if (overflow.length > 0) {
                this.showSummary(overflow.length).catch(failed);
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
        const prefs = this.store.config.review.notifications;
        if (!prefs.newPullRequest && !prefs.newVersion && !prefs.buildFailed && !this.isVisible()) {
            // Nobody to tell and nothing on screen: no request. The heads are no longer recorded, so the next poll with a
            // notification on records a new baseline instead of showing what happened meanwhile.
            this.store.updateNotified((state) => {
                state.initialized = false;
            });
            return null;
        }
        if (this.store.config.repos.length === 0 || !await this.session.hasToken()) {
            return null;
        }
        // The profile first (read once per session): without it nothing is mine, so no PR list is fetched.
        if (!await this.session.me()) {
            return null;
        }
        // Not fresh: the home shared by the windows and the caches kept per head keep each poll down to the PR lists;
        // only the explicit "Refresh" command bypasses them.
        const home = await this.home.get();
        if (!home.me) {
            return null;
        }
        const codeChanged = prefs.newVersion ? await this.codeChanges(home) : {};
        let pending: PendingNotification[] = [];
        // Planned on the state re-read from disk inside the update: a PR head another window already recorded (and
        // notified) is no longer new here, so each notification is shown by one window only.
        this.store.updateNotified((state) => {
            const plan = planNotifications(home, prefs, state, codeChanged);
            state.initialized = plan.next.initialized;
            state.seen = plan.next.seen;
            pending = plan.notifications;
        });
        return pending;
    }

    /**
     * Code check of the PRs with a new head (a version summary each, cached per version once computed). Candidates are
     * taken from the state on disk, so heads another window already recorded are not checked again.
     */
    private async codeChanges(home: Home): Promise<CodeChanges> {
        const changes: Record<string, boolean | null> = {};
        await eachLimited(versionCandidates(home, this.store.notified()), SUMMARY_CONCURRENCY, async ({ ref, previousHead }: VersionCandidate) => {
            try {
                changes[prKeyOf(ref)] = codeChangedSince(await this.prs.versionKinds(ref, previousHead), previousHead);
            } catch (error) {
                // Unknown counts as code: better a notification too many than a missed new version.
                console.warn(`revspan: versions of ${prKeyOf(ref)} unreadable (${(error as Error).message})`);
                changes[prKeyOf(ref)] = null;
            }
        });
        return changes;
    }

    /** One toast for the notifications beyond the cap; "Show" focuses the "My PRs" view. */
    private async showSummary(count: number): Promise<void> {
        const { t, isSingular } = hostL10n();
        const show = t('Show');
        const message = isSingular(count)
            ? t('{count} more pull request needs your attention', { count })
            : t('{count} more pull requests need your attention', { count });
        if (await vscode.window.showInformationMessage(message, show) === show) {
            await vscode.commands.executeCommand(FOCUS_VIEW_COMMAND);
        }
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
