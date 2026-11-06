// Plage de versions comparées, synchronisée avec ?from=&to= (retour arrière et liens directs).
import { computed, ref, watch, type Ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { PrDetail, PrRef } from '../../shared/api.ts';
import { clickSelection, defaultSelection, isValidSelection, parseRangeQuery, singleVersion, type Range } from '../lib/selection.ts';

export function useRangeSelection(prRef: PrRef, detail: Ref<PrDetail>) {
    const route = useRoute();
    const router = useRouter();
    const n = computed(() => detail.value.versions.length);

    const rangeQuery = (r: Range): Record<string, string> => ({ from: String(r.from), to: String(r.to) });

    /** Plage de l'URL si elle est valide, sinon la plage par défaut (écrite dans l'URL sans nouvelle entrée d'historique). */
    function rangeFromRoute(): Range | null {
        const q = parseRangeQuery(route.query);
        return isValidSelection(n.value, q.from, q.to) && q.from != null && q.to != null ? { from: q.from, to: q.to } : null;
    }

    const start = rangeFromRoute() ?? defaultSelection(n.value, detail.value.review.lastReviewed);
    const from = ref(start.from);
    const to = ref(start.to);
    if (!rangeFromRoute()) {
        void router.replace({ query: rangeQuery(start) });
    }

    function select(newFrom: number, newTo: number): void {
        if (!isValidSelection(n.value, newFrom, newTo) || (newFrom === from.value && newTo === to.value)) {
            return;
        }
        from.value = newFrom;
        to.value = newTo;
        void router.push({ query: rangeQuery({ from: newFrom, to: newTo }) });
    }

    function clickVersion(i: number, shift: boolean): void {
        const next = clickSelection({ from: from.value, to: to.value }, i, shift);
        select(next.from, next.to);
    }

    /** [ et ] : version seule précédente / suivante. */
    function stepVersion(dir: 1 | -1): boolean {
        const target = to.value + dir;
        if (target < 1 || target > n.value) {
            return false;
        }
        const r = singleVersion(n.value, target);
        select(r.from, r.to);
        return true;
    }

    const isThisPr = (): boolean => route.params.ws === prRef.workspace && route.params.repo === prRef.repo && Number(route.params.id) === prRef.id;

    // retour arrière / lien direct : l'URL fait foi
    watch(() => [route.query.from, route.query.to], () => {
        if (!isThisPr()) {
            return; // navigation vers une autre PR : cette page va être démontée
        }
        const r = rangeFromRoute();
        if (r) {
            from.value = r.from;
            to.value = r.to;
        } else {
            void router.replace({ query: rangeQuery({ from: from.value, to: to.value }) });
        }
    });

    return { n, from, to, select, clickVersion, stepVersion };
}
