// Plage de versions comparées, synchronisée avec ?from=&to= (retour arrière et liens directs).
// Les versions indisponibles (commit effacé par Bitbucket) ne sont jamais des bornes.
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

    /** Plage de l'URL si elle est valide, sinon la plage par défaut (écrite dans l'URL sans nouvelle entrée d'historique). */
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

    /** Ce que la version i a changé, comme un clic dans la frise : depuis la dernière version lisible avant elle (ou la base). */
    function selectVersion(i: number): void {
        const r = singleVersion(n.value, i, unavailable.value);
        select(r.from, r.to);
    }

    /** [ et ] : version seule précédente / suivante (les versions indisponibles sont sautées). */
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

    // détail rechargé : une version découverte effacée depuis ne reste pas une borne (sans nouvelle entrée d'historique)
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
