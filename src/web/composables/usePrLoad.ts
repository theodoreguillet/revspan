// PR page data: detail (always loaded), version summary, range diff (cached),
// and writes followed by a reload.
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
    /** After a successful write, before the reload (close a composer, forget a draft...). */
    onDone?: () => void;
    /** Also reload the diff (new inline thread: its placement comes from the diff). */
    reloadCompare?: boolean;
    /** Button that started the action (loading indicator on that button). */
    key?: string;
}

export function usePrLoad(prRef: PrRef, initial: PrDetail) {
    const detail = shallowRef<PrDetail>(initial);
    const summary = shallowRef<Summary | null>(null);
    const sums = computed(() => summaryMap(summary.value));
    const compare = shallowRef<Comparison | null>(null);
    const compareLoading = ref(false);
    const compareError = shallowRef<unknown>(null);
    const cache = new Map<string, Comparison>();
    let current: CompareParams | null = null;
    /** Latest summary request: only its response is kept. */
    let summaryRequest = 0;
    /** Incremented by each forced diff reload: an earlier response writes neither the cache nor the diff. */
    let generation = 0;
    /** Versions a comparison found erased (410) that already triggered a detail reload: at most once each, no loop. */
    const reloadedForPurge = new Set<number>();

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
            await reloadDetail();
        }
    }

    /** Reloads the detail, and the summary if the version list changed (version pushed while reading). */
    async function reloadDetail(): Promise<void> {
        const before = detail.value.versions;
        try {
            detail.value = await api.pr(prRef);
        } catch (error) {
            showError(error);
            return;
        }
        if (versionsChanged(before, detail.value.versions)) {
            void loadSummary();
        }
    }

    const keyOf = (p: CompareParams): string => `${p.from}-${p.to}-${p.context}`;

    async function loadCompare(params: CompareParams, { force = false } = {}): Promise<void> {
        current = params;
        const key = keyOf(params);
        const cached = cache.get(key);
        if (cached && !force) {
            compare.value = cached;
            compareError.value = null;
            compareLoading.value = false;
            return;
        }
        const requested = generation;
        compareLoading.value = true;
        try {
            const result = await api.compare(prRef, params.from, params.to, params.context);
            if (requested !== generation) {
                return;
            }
            cache.set(key, result);
            if (current && keyOf(current) === key) {
                compare.value = result;
                compareError.value = null;
            }
        } catch (error) {
            if (requested !== generation) {
                return;
            }
            if (current && keyOf(current) === key) {
                compare.value = null;
                compareError.value = error;
                showError(error);
            }
            // A bound erased by Bitbucket since the detail was loaded: the reloaded detail marks it unavailable, the
            // range moves to a readable version and the diff of the new range is loaded.
            const purged = error instanceof ApiError && error.code === 'VERSION_UNAVAILABLE' ? error.params.version : undefined;
            if (purged !== undefined && !reloadedForPurge.has(purged)) {
                reloadedForPurge.add(purged);
                await reloadDetail();
            }
        }
        if (current && keyOf(current) === key) {
            compareLoading.value = false;
        }
    }

    async function reload({ reloadCompare = false } = {}): Promise<void> {
        await reloadDetail();
        if (reloadCompare && current) {
            generation++;
            cache.clear();
            await loadCompare(current, { force: true });
        }
    }

    /** Write action in progress (key of its button), until the reload ends; only one at a time. */
    const pendingAction = ref<string | null>(null);
    const acting = computed(() => pendingAction.value !== null);
    const busy = (key: string): boolean => pendingAction.value === key;

    /**
     * Runs a write then reloads the PR. Returns true if the write succeeded; false if it failed, or if another
     * is in progress (message shown, nothing is sent or forgotten: the draft stays).
     */
    async function act(write: () => Promise<unknown>, { onDone, reloadCompare = false, key = 'action' }: ActOptions = {}): Promise<boolean> {
        if (pendingAction.value !== null) {
            // a write launched (⌘/Ctrl+Enter…) while another one is finishing
            showError(new Error(t('error.busy')));
            return false;
        }
        pendingAction.value = key;
        try {
            await write();
            onDone?.();
            await reload({ reloadCompare });
            return true;
        } catch (error) {
            showError(error);
            return false;
        } finally {
            pendingAction.value = null;
        }
    }

    /** Local (optimistic) update of the review state. */
    function patchReview(review: Review): void {
        detail.value = { ...detail.value, review };
    }

    return {
        detail, summary, sums, compare, compareLoading, compareError, pendingAction, acting, busy,
        loadSummary, loadCompare, act, patchReview,
    };
}

export type PrLoad = ReturnType<typeof usePrLoad>;
