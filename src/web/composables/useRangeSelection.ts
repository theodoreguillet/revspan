// Range of compared versions, synchronized with ?from=&to= (back button and direct links).
// Unavailable versions (commit erased by Bitbucket) are never bounds.
import { computed, ref, watch, type Ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { PrDetail, PrRef } from '../../shared/api.ts';
import {
    clickSelection, defaultSelection, isValidSelection, parseRangeQuery, repairSelection, singleVersion, unavailableVersions, type Range,
} from '../lib/selection.ts';

export function useRangeSelection(prRef: PrRef, detail: Ref<PrDetail>) {
    const route = useRoute();
    const router = useRouter();
    const n = computed(() => detail.value.versions.length);
    const unavailable = computed(() => unavailableVersions(detail.value.versions));

    const rangeQuery = (r: Range): Record<string, string> => ({ from: String(r.from), to: String(r.to) });

    /** Range from the URL if valid, otherwise the default range (written to the URL without a new history entry). */
    function rangeFromRoute(): Range | null {
        const q = parseRangeQuery(route.query);
        return isValidSelection(n.value, q.from, q.to, unavailable.value) && q.from != null && q.to != null ? { from: q.from, to: q.to } : null;
    }

    const start = rangeFromRoute() ?? defaultSelection(n.value, detail.value.review.lastReviewed, unavailable.value);
    const from = ref(start.from);
    const to = ref(start.to);
    if (!rangeFromRoute()) {
        void router.replace({ query: rangeQuery(start) });
    }

    function select(newFrom: number, newTo: number): void {
        if (!isValidSelection(n.value, newFrom, newTo, unavailable.value) || (newFrom === from.value && newTo === to.value)) {
            return;
        }
        from.value = newFrom;
        to.value = newTo;
        void router.push({ query: rangeQuery({ from: newFrom, to: newTo }) });
    }

    function clickVersion(i: number, shift: boolean): void {
        const next = clickSelection({ from: from.value, to: to.value }, i, shift, unavailable.value);
        select(next.from, next.to);
    }

    /** What version i changed, like a click in the timeline: since the last readable version before it (or the base). */
    function selectVersion(i: number): void {
        const r = singleVersion(n.value, i, unavailable.value);
        select(r.from, r.to);
    }

    /** [ and ]: single previous / next version (unavailable versions are skipped). */
    function stepVersion(dir: 1 | -1): boolean {
        let target = to.value + dir;
        while (unavailable.value.has(target)) {
            target += dir;
        }
        if (target < 1 || target > n.value) {
            return false;
        }
        selectVersion(target);
        return true;
    }

    const isThisPr = (): boolean => route.params.ws === prRef.workspace && route.params.repo === prRef.repo && Number(route.params.id) === prRef.id;

    // back button / direct link: the URL is authoritative
    watch(() => [route.query.from, route.query.to], () => {
        if (!isThisPr()) {
            return; // navigation to another PR: this page is about to be unmounted
        }
        const r = rangeFromRoute();
        if (r) {
            from.value = r.from;
            to.value = r.to;
        } else {
            void router.replace({ query: rangeQuery({ from: from.value, to: to.value }) });
        }
    });

    // detail reloaded: a version since discovered erased does not stay a bound (no new history entry)
    watch(unavailable, () => {
        const r = repairSelection(n.value, { from: from.value, to: to.value }, detail.value.review.lastReviewed, unavailable.value);
        if (r.from !== from.value || r.to !== to.value) {
            from.value = r.from;
            to.value = r.to;
            void router.replace({ query: rangeQuery(r) });
        }
    });

    return { n, unavailable, from, to, select, selectVersion, clickVersion, stepVersion };
}
