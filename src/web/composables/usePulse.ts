// Light check for news on Bitbucket while the PR page is seen (one GET per refresh interval), and the user refresh (↻).
// The page never changes by itself: news shows a banner whose button runs the refresh.
import { onScopeDispose, shallowRef, watch } from 'vue';
import type { PrDetail, PrRef } from '../../shared/api.ts';
import { hasNews, pulseIntervalMs, pulseNews, REFRESH_STATUS_MS, sameNews, type PulseNews, type RefreshNews } from '../lib/pulse.ts';
import { api } from '../services/api.ts';
import { usePageVisible } from './usePageVisible.ts';

/** What the check reads from the PR page (reactive). */
export interface PulsePage {
    ref: PrRef;
    detail: PrDetail;
    /** A write is in progress. */
    acting: boolean;
    /** The detail is being read again. */
    refreshing: boolean;
    /** Writes and refreshes started so far. */
    syncSeq(): number;
    refresh(): Promise<RefreshNews | null>;
}

/** The check as the components read it (reactive). */
export interface PulseView {
    readonly news: PulseNews | null;
    readonly status: RefreshNews | null;
    refresh(): Promise<void>;
    dismiss(): void;
}

export function usePulse(page: PulsePage) {
    const visible = usePageVisible();
    /** News found by the last check, compared to the detail shown (null: none, or dismissed). */
    const news = shallowRef<PulseNews | null>(null);
    /** What the last user refresh brought, for a few seconds. */
    const status = shallowRef<RefreshNews | null>(null);
    /** News the user hid: not shown again until a check finds something else. */
    let dismissed: PulseNews | null = null;
    const startedAt = Date.now();
    /** When the last check was sent. */
    let lastCheck = 0;
    let checking = false;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let statusTimer: ReturnType<typeof setTimeout> | undefined;

    /** Last time the page knew Bitbucket's state: the detail's read (a cached detail keeps its time) or the last check. */
    function knownAt(): number {
        const loaded = Date.parse(page.detail.freshness.loadedAt);
        return Math.max(lastCheck, Number.isNaN(loaded) ? startedAt : Math.min(loaded, Date.now()));
    }

    /** Next check an interval after knownAt(), at once if overdue; none while hidden or while the detail changes. */
    function schedule(): void {
        clearTimeout(timer);
        if (disposed || checking || !visible.value || page.acting || page.refreshing) {
            return;
        }
        const wait = Math.max(0, knownAt() + pulseIntervalMs(page.detail.freshness.refreshMinutes) - Date.now());
        timer = setTimeout(() => void check(), wait);
    }

    async function check(): Promise<void> {
        checking = true;
        lastCheck = Date.now();
        const seq = page.syncSeq();
        try {
            const now = await api.pulse(page.ref);
            // A write or a refresh started since the request: the detail shown may not include what Bitbucket counted
            // (my own comment...). The next check compares with the detail it leaves.
            if (seq === page.syncSeq() && !page.acting && !page.refreshing) {
                const found = pulseNews(page.detail.pulse, now);
                news.value = hasNews(found) && !(dismissed && sameNews(found, dismissed)) ? found : null;
            }
        } catch {
            // silent: a background check failing (network, session) tries again at the next interval
        } finally {
            checking = false;
            schedule();
        }
    }

    watch(() => [visible.value, page.acting, page.refreshing, page.detail.freshness.loadedAt, page.detail.freshness.refreshMinutes], schedule);
    // any refresh (mine, or after a write) shows Bitbucket's state: the news are outdated
    watch(() => page.refreshing, (on) => {
        if (on) {
            news.value = null;
            dismissed = null;
        }
    });
    schedule();

    onScopeDispose(() => {
        disposed = true;
        clearTimeout(timer);
        clearTimeout(statusTimer);
    });

    /** User refresh (↻ or the banner's button): what it brought shows for a few seconds. */
    async function refresh(): Promise<void> {
        news.value = null;
        const result = await page.refresh();
        if (disposed) {
            return;
        }
        clearTimeout(statusTimer);
        status.value = result;
        if (result) {
            statusTimer = setTimeout(() => {
                status.value = null;
            }, REFRESH_STATUS_MS);
        }
    }

    function dismiss(): void {
        dismissed = news.value;
        news.value = null;
    }

    return { news, status, refresh, dismiss };
}
