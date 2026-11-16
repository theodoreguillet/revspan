// PR page data: detail (always loaded), version summary, range diff (cached), and writes shown at once then
// confirmed by a background refresh of the detail.
import { computed, ref, shallowRef } from 'vue';
import type { Comparison, PrDetail, PrRef, Review, Summary } from '../../shared/api.ts';
import { purgedSinceDetail, summaryMap, versionsChanged } from '../lib/kinds.ts';
import type { Range } from '../lib/selection.ts';
import { t } from '../i18n/index.ts';
import { api, ApiError } from '../services/api.ts';
import { showError } from './useErrors.ts';

export interface CompareParams extends Range {
    context: number;
}

export interface ActOptions {
    /** After a successful write, before the background refresh (replace a pending comment, forget a draft...). */
    onDone?: () => void;
    /** Button that started the action (loading indicator on that button). */
    key?: string;
    /** Local update shown before the write is sent. */
    optimistic?: () => void;
    /** Undoes `optimistic` when the write fails. */
    rollback?: () => void;
}

export function usePrLoad(prRef: PrRef, initial: PrDetail) {
    const detail = shallowRef<PrDetail>(initial);
    const summary = shallowRef<Summary | null>(null);
    const sums = computed(() => summaryMap(summary.value));
    const compare = shallowRef<Comparison | null>(null);
    const compareLoading = ref(false);
    const compareError = shallowRef<unknown>(null);
    const cache = new Map<string, Comparison>();
    /** Comparisons being computed, by key: asking again for the same range waits for the same answer. */
    const inflight = new Map<string, Promise<Comparison>>();
    /** Latest diff request: only its answer is shown (fast range clicks, late answers). */
    let compareRequest = 0;
    /** Latest summary request: only its response is kept. */
    let summaryRequest = 0;
    /** Versions a comparison found erased (410) that already triggered a detail reload: at most once each, no loop. */
    const reloadedForPurge = new Set<number>();

    /** Write action in progress (key of its button), during the write only; only one at a time. */
    const pendingAction = ref<string | null>(null);
    const acting = computed(() => pendingAction.value !== null);
    const busy = (key: string): boolean => pendingAction.value === key;
    /** Writes started so far: a detail read before the latest one would erase its local update. */
    let writes = 0;
    /** A refresh was dropped while a write was in progress: refresh when that write ends, even if it fails. */
    let refreshWanted = false;
    let running: Promise<void> | null = null;
    const refreshing = ref(false);

    async function loadSummary(): Promise<void> {
        const request = ++summaryRequest;
        let result: Summary;
        try {
            result = await api.summary(prRef);
        } catch (error) {
            if (request === summaryRequest) {
                showError(error);
            }
            return;
        }
        if (request !== summaryRequest) {
            return;
        }
        summary.value = result;
        // A commit erased by Bitbucket after being cached only shows up when the summary is computed: the detail, loaded
        // before, still thinks the version is readable (and the range may start from it). It is reloaded once.
        if (purgedSinceDetail(detail.value.versions, result)) {
            await refreshDetail();
        }
    }

    /** Reads the detail; a read during which a write started is dropped, and read again unless a write is still in progress. */
    async function readDetail(): Promise<void> {
        for (;;) {
            const started = writes;
            let fresh: PrDetail;
            try {
                fresh = await api.pr(prRef);
            } catch (error) {
                showError(error);
                return;
            }
            if (started === writes && pendingAction.value === null) {
                const before = detail.value.versions;
                detail.value = fresh;
                if (versionsChanged(before, fresh.versions)) {
                    void loadSummary();
                }
                return;
            }
            if (pendingAction.value !== null) {
                // the write in progress refreshes when it ends
                refreshWanted = true;
                return;
            }
            // a write started and ended during the read: read again
        }
    }

    /**
     * Reloads the detail in the background, and the summary if the version list changed (version pushed while
     * reading). A read that started before a write is dropped, so it never erases the write's local update.
     * Calls during a refresh share it.
     */
    function refreshDetail(): Promise<void> {
        if (running) {
            return running;
        }
        refreshWanted = false;
        refreshing.value = true;
        running = readDetail().finally(() => {
            running = null;
            refreshing.value = false;
        });
        return running;
    }

    const keyOf = (p: CompareParams): string => `${p.from}-${p.to}-${p.context}`;

    function fetchCompare(params: CompareParams, key: string): Promise<Comparison> {
        let request = inflight.get(key);
        if (!request) {
            request = api.compare(prRef, params.from, params.to, params.context).finally(() => inflight.delete(key));
            inflight.set(key, request);
        }
        return request;
    }

    async function loadCompare(params: CompareParams): Promise<void> {
        const request = ++compareRequest;
        const key = keyOf(params);
        const cached = cache.get(key);
        if (cached) {
            compare.value = cached;
            compareError.value = null;
            compareLoading.value = false;
            return;
        }
        compareLoading.value = true;
        try {
            const result = await fetchCompare(params, key);
            // a second wait for the same answer keeps the entry stored (and maybe patched) by the first one
            if (!cache.has(key)) {
                cache.set(key, result);
            }
            if (request === compareRequest) {
                compare.value = cache.get(key) ?? result;
                compareError.value = null;
            }
        } catch (error) {
            if (request === compareRequest) {
                compare.value = null;
                compareError.value = error;
                showError(error);
            }
            // A bound erased by Bitbucket since the detail was loaded: the reloaded detail marks it unavailable, the
            // range moves to a readable version and the diff of the new range is loaded.
            const purged = error instanceof ApiError && error.code === 'VERSION_UNAVAILABLE' ? error.params.version : undefined;
            if (purged !== undefined && !reloadedForPurge.has(purged)) {
                reloadedForPurge.add(purged);
                await refreshDetail();
            }
        }
        if (request === compareRequest) {
            compareLoading.value = false;
        }
    }

    /**
     * Runs a write: `optimistic` first, `rollback` if the write fails, `onDone` once it succeeded, then a background
     * refresh of the detail (not awaited). Returns true if the write succeeded; false if it failed, or if another is in
     * progress (message shown, nothing is sent or forgotten: the draft stays).
     */
    async function act(write: () => Promise<unknown>, { onDone, key = 'action', optimistic, rollback }: ActOptions = {}): Promise<boolean> {
        if (pendingAction.value !== null) {
            // a write launched (⌘/Ctrl+Enter…) while another one is in progress
            showError(new Error(t('error.busy')));
            return false;
        }
        pendingAction.value = key;
        writes++;
        let ok = false;
        try {
            optimistic?.();
            await write();
            ok = true;
        } catch (error) {
            rollback?.();
            showError(error);
        } finally {
            pendingAction.value = null;
        }
        if (ok) {
            onDone?.();
        }
        if (ok || refreshWanted) {
            void refreshDetail();
        }
        return ok;
    }

    /** Local update of the detail (optimistic write, comment returned by the server). */
    function patchDetail(fn: (d: PrDetail) => PrDetail): void {
        detail.value = fn(detail.value);
    }

    /**
     * Local update of the shown comparison and of the cached ones (`fn` returns its argument unchanged for a comparison
     * it does not concern): a thread placed on the last version belongs to every cached range that ends there.
     */
    function patchCompare(fn: (c: Comparison) => Comparison): void {
        const patched = new Map<Comparison, Comparison>();
        const apply = (c: Comparison): Comparison => {
            let next = patched.get(c);
            if (!next) {
                next = fn(c);
                patched.set(c, next);
            }
            return next;
        };
        for (const [key, cmp] of cache) {
            cache.set(key, apply(cmp));
        }
        if (compare.value) {
            compare.value = apply(compare.value);
        }
    }

    /** Local (optimistic) update of the review state. */
    function patchReview(review: Review): void {
        detail.value = { ...detail.value, review };
    }

    return {
        detail, summary, sums, compare, compareLoading, compareError, pendingAction, acting, busy, refreshing,
        loadSummary, loadCompare, refreshDetail, act, patchDetail, patchCompare, patchReview,
    };
}

export type PrLoad = ReturnType<typeof usePrLoad>;
