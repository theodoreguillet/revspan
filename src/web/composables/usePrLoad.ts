// PR page data: detail (always loaded), version summary, range diff (cached, presets prefetched), and writes shown at
// once then confirmed by a background refresh of the detail.
import { computed, ref, shallowRef, watch, type WatchStopHandle } from 'vue';
import type { Comparison, PrDetail, PrRef, Review, Summary } from '../../shared/api.ts';
import { purgedSinceDetail, summaryMap, versionsChanged } from '../lib/kinds.ts';
import { diffDisplay, SKELETON_DELAY_MS } from '../lib/loading.ts';
import { PREFETCH_CONTEXT, prefetchFileCount, prefetchQueue } from '../lib/prefetch.ts';
import { refreshNews, unplacedThreads, type RefreshNews } from '../lib/pulse.ts';
import type { Preset, Range } from '../lib/selection.ts';
import { t } from '../i18n/index.ts';
import { api, ApiError } from '../services/api.ts';
import { showError } from './useErrors.ts';
import { usePageVisible } from './usePageVisible.ts';

export interface CompareParams extends Range {
    context: number;
}

/** What the prefetch computes, read each time it picks the next range (the version list may have changed). */
export interface PrefetchPlan {
    presets: readonly Preset[];
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
    /** Start of the comparison the user is waiting for (null: none), and a clock ticked when the skeleton is due. */
    const compareSince = ref<number | null>(null);
    const now = ref(Date.now());
    let skeletonTimer: ReturnType<typeof setTimeout> | undefined;
    /** What the diff area shows: the diff, the diff with the progress bar, or the skeleton. */
    const diffMode = computed(() => diffDisplay({
        loading: compareLoading.value, since: compareSince.value, now: now.value, hasCompare: compare.value !== null,
    }));
    const cache = new Map<string, Comparison>();
    /** Comparisons being computed, by key: asking again for the same range waits for the same answer. */
    const inflight = new Map<string, Promise<Comparison>>();
    /** Latest diff request: only its answer is shown (fast range clicks, late answers). */
    let compareRequest = 0;
    /** Range of the latest diff request (the range shown, or about to be). */
    let shownParams: CompareParams | null = null;
    /** Bumped when the comparisons known so far go stale (new inline thread): an answer requested before is not kept. */
    let compareEpoch = 0;
    /** Latest summary request: only its response is kept. */
    let summaryRequest = 0;
    /** Versions a comparison found erased (410) that already triggered a detail reload: at most once each, no loop. */
    const reloadedForPurge = new Set<number>();

    const visible = usePageVisible();
    /** Prefetch source, null when not started or stopped (page left). */
    let prefetchPlan: (() => PrefetchPlan) | null = null;
    let stopVisibleWatch: WatchStopHandle | null = null;
    /** A prefetched range is being computed: one at a time. */
    let prefetchRunning = false;
    /** The prefetch starts once a first diff is shown: the page's own comparison goes first. */
    let compareShown = false;
    /** Keys the prefetch already asked for (landed, failed or dropped): never asked twice, its cost stays capped. */
    const prefetched = new Set<string>();

    /** Write action in progress (key of its button), during the write only; only one at a time. */
    const pendingAction = ref<string | null>(null);
    const acting = computed(() => pendingAction.value !== null);
    const busy = (key: string): boolean => pendingAction.value === key;
    /** Writes started so far: a detail read before the latest one would erase its local update. */
    let writes = 0;
    /** A refresh was dropped while a write was in progress: refresh when that write ends, even if it fails. */
    let refreshWanted = false;
    let running: Promise<boolean> | null = null;
    const refreshing = ref(false);
    /** Refreshes started so far (with `writes`: a check sent before one of them compares with an outdated detail). */
    let refreshes = 0;

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
        // the PR size the prefetch waits for
        pumpPrefetch();
        // A commit erased by Bitbucket after being cached only shows up when the summary is computed: the detail, loaded
        // before, still thinks the version is readable (and the range may start from it). It is reloaded once.
        if (purgedSinceDetail(detail.value.versions, result)) {
            await refreshDetail();
        }
    }

    /**
     * Reads the detail; a read during which a write started is dropped, and read again unless a write is still in
     * progress. Returns true if a fresh detail is shown.
     */
    async function readDetail(): Promise<boolean> {
        for (;;) {
            const started = writes;
            let fresh: PrDetail;
            try {
                fresh = await api.pr(prRef, { fresh: true });
            } catch (error) {
                showError(error);
                return false;
            }
            if (started === writes && pendingAction.value === null) {
                const before = detail.value.versions;
                detail.value = fresh;
                if (versionsChanged(before, fresh.versions)) {
                    void loadSummary();
                }
                return true;
            }
            if (pendingAction.value !== null) {
                // the write in progress refreshes when it ends
                refreshWanted = true;
                return false;
            }
            // a write started and ended during the read: read again
        }
    }

    /**
     * Reloads the detail in the background, and the summary if the version list changed (version pushed while
     * reading). A read that started before a write is dropped, so it never erases the write's local update.
     * Calls during a refresh share it. Resolves to true if a fresh detail is shown.
     */
    function refreshDetail(): Promise<boolean> {
        if (running) {
            return running;
        }
        refreshWanted = false;
        refreshes++;
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
            const started: Promise<Comparison> = api.compare(prRef, params.from, params.to, params.context).finally(() => {
                // a stale request (see evictCompare) may have been replaced by a newer one for the same key
                if (inflight.get(key) === started) {
                    inflight.delete(key);
                }
            });
            request = started;
            inflight.set(key, request);
        }
        return request;
    }

    /**
     * Computes a comparison into the cache, without touching the shown diff. Returns the cached entry, or null when
     * the comparisons went stale while it was computed (it is then not kept).
     */
    async function fetchIntoCache(params: CompareParams): Promise<Comparison | null> {
        const key = keyOf(params);
        const epoch = compareEpoch;
        const result = await fetchCompare(params, key);
        if (epoch !== compareEpoch) {
            return null;
        }
        // a second wait for the same answer keeps the entry stored (and maybe patched) by the first one
        if (!cache.has(key)) {
            cache.set(key, result);
        }
        return cache.get(key) ?? result;
    }

    /** The skeleton timer starts with the first request of a wait: a second click while waiting does not restart it. */
    function setCompareLoading(on: boolean): void {
        compareLoading.value = on;
        if (!on) {
            compareSince.value = null;
            clearTimeout(skeletonTimer);
            return;
        }
        if (compareSince.value === null) {
            compareSince.value = Date.now();
            now.value = compareSince.value;
            skeletonTimer = setTimeout(() => {
                now.value = Date.now();
            }, SKELETON_DELAY_MS);
        }
    }

    function showCompare(result: Comparison): void {
        compare.value = result;
        compareError.value = null;
        compareShown = true;
    }

    async function loadCompare(params: CompareParams): Promise<void> {
        const request = ++compareRequest;
        shownParams = params;
        const key = keyOf(params);
        const cached = cache.get(key);
        if (cached) {
            showCompare(cached);
            setCompareLoading(false);
            pumpPrefetch();
            return;
        }
        setCompareLoading(true);
        try {
            const result = await fetchIntoCache(params);
            if (result === null) {
                // computed before a new inline thread: the range still selected is computed again
                if (request === compareRequest) {
                    await loadCompare(params);
                }
                return;
            }
            if (request === compareRequest) {
                showCompare(result);
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
            setCompareLoading(false);
            pumpPrefetch();
        }
    }

    /**
     * Computes the next preset range not cached yet, in the background, into the cache only (never the shown diff):
     * while the page is visible, once a first diff is shown, never while the user waits for a diff (theirs goes first,
     * the prefetch resumes after it), one range at a time, and only for a PR of at most PREFETCH_MAX_FILES files.
     */
    function pumpPrefetch(): void {
        if (!prefetchPlan || prefetchRunning || !compareShown || compareLoading.value || !visible.value) {
            return;
        }
        const { presets, context } = prefetchPlan();
        if (context !== PREFETCH_CONTEXT) {
            return;
        }
        const rangeKey = (r: Range): string => keyOf({ ...r, context });
        const skip = new Set([...cache.keys(), ...inflight.keys(), ...prefetched]);
        const last = Math.max(0, ...presets.map((p) => p.to));
        const next = prefetchQueue(presets, skip, rangeKey, prefetchFileCount(summary.value, cache.values(), last))[0];
        if (!next) {
            return;
        }
        const key = rangeKey(next);
        prefetched.add(key);
        prefetchRunning = true;
        // a failure stays silent: a click on that preset asks again and shows the error
        void fetchIntoCache({ ...next, context }).then((result) => {
            if (result === null) {
                // dropped because the comparisons went stale (new inline thread): it may be prefetched again
                prefetched.delete(key);
            }
        }, () => undefined).finally(() => {
            prefetchRunning = false;
            pumpPrefetch();
        });
    }

    /** Starts the prefetch of the presets; it pauses while the page is hidden and resumes when it shows again. */
    function startPrefetch(plan: () => PrefetchPlan): void {
        prefetchPlan = plan;
        stopVisibleWatch?.();
        stopVisibleWatch = watch(visible, (isVisible) => {
            if (isVisible) {
                pumpPrefetch();
            }
        });
        pumpPrefetch();
    }

    /** Page left: no more background comparison (one in flight may still land in the cache) nor timer. */
    function stopPrefetch(): void {
        prefetchPlan = null;
        stopVisibleWatch?.();
        stopVisibleWatch = null;
        clearTimeout(skeletonTimer);
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
            onDone?.();
        } catch (error) {
            // an error of onDone comes after a successful write: nothing to roll back
            if (!ok) {
                rollback?.();
            }
            showError(error);
        } finally {
            pendingAction.value = null;
        }
        if (ok || refreshWanted) {
            void refreshDetail();
        }
        return ok;
    }

    /** Writes and refreshes started so far: changes when the detail shown may no longer match Bitbucket's PR. */
    const syncSeq = (): number => writes + refreshes;

    /**
     * Computes the shown range again into the cache, the current diff staying on screen meanwhile (no skeleton), and
     * shows it unless another range was asked for in between.
     */
    async function recomputeShown(params: CompareParams): Promise<void> {
        const request = compareRequest;
        let result: Comparison | null;
        try {
            result = await fetchIntoCache(params);
        } catch (error) {
            if (request === compareRequest) {
                showError(error);
            }
            return;
        }
        if (result && request === compareRequest) {
            showCompare(result);
        }
    }

    /**
     * User refresh (↻): reads a fresh detail and says what it brought (null if it was not read: failure, write in
     * progress). New versions: the summary (see readDetail) and the shown range are computed again. Otherwise the diff
     * stays, unless it lacks a thread placed on one of its files: the ranges concerned are computed again, once.
     */
    async function refresh(): Promise<RefreshNews | null> {
        const before = detail.value;
        if (!(await refreshDetail())) {
            return null;
        }
        const after = detail.value;
        const params = shownParams;
        if (params) {
            if (versionsChanged(before.versions, after.versions)) {
                evictCompare(() => true);
                await recomputeShown(params);
            } else if (compare.value && unplacedThreads(compare.value, after.threads).length) {
                evictCompare((c) => unplacedThreads(c, after.threads).length > 0);
                await recomputeShown(params);
            }
        }
        return refreshNews(before, after);
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

    /**
     * Forgets the cached comparisons `pred` selects, and marks every comparison being computed as stale (not kept when
     * it lands): after a new inline thread, the server places it in ranges the page cannot place it in itself.
     */
    function evictCompare(pred: (c: Comparison) => boolean): void {
        compareEpoch++;
        inflight.clear();
        for (const [key, cmp] of cache) {
            if (pred(cmp)) {
                cache.delete(key);
            }
        }
    }

    /** Local (optimistic) update of the review state. */
    function patchReview(review: Review): void {
        detail.value = { ...detail.value, review };
    }

    return {
        detail, summary, sums, compare, compareLoading, compareError, diffMode, pendingAction, acting, busy, refreshing,
        loadSummary, loadCompare, fetchIntoCache, startPrefetch, stopPrefetch, refreshDetail, refresh, syncSeq, act, patchDetail,
        patchCompare, evictCompare, patchReview,
    };
}

export type PrLoad = ReturnType<typeof usePrLoad>;
