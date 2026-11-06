// Données de la page PR : détail (toujours chargé), résumé des versions, diff de la plage (avec cache),
// et écritures suivies d'un rechargement.
import { computed, ref, shallowRef } from 'vue';
import type { Comparison, PrDetail, PrRef, Review, Summary } from '../../shared/api.ts';
import { summaryMap } from '../lib/kinds.ts';
import type { Range } from '../lib/selection.ts';
import { api } from '../services/api.ts';
import { showError } from './useErrors.ts';

export interface CompareParams extends Range {
    context: number;
}

export interface ActOptions {
    /** Après une écriture réussie, avant le rechargement (fermer un composeur, oublier un brouillon…). */
    onDone?: () => void;
    /** Recharger aussi le diff (nouveau fil en ligne : son placement vient du diff). */
    reloadCompare?: boolean;
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

    async function loadSummary(): Promise<void> {
        try {
            summary.value = await api.summary(prRef);
        } catch (error) {
            showError(error);
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
        compareLoading.value = true;
        try {
            const result = await api.compare(prRef, params.from, params.to, params.context);
            cache.set(key, result);
            if (current && keyOf(current) === key) {
                compare.value = result;
                compareError.value = null;
            }
        } catch (error) {
            if (current && keyOf(current) === key) {
                compare.value = null;
                compareError.value = error;
                showError(error);
            }
        }
        if (current && keyOf(current) === key) {
            compareLoading.value = false;
        }
    }

    async function reload({ reloadCompare = false } = {}): Promise<void> {
        try {
            detail.value = await api.pr(prRef);
        } catch (error) {
            showError(error);
        }
        if (reloadCompare && current) {
            cache.clear();
            await loadCompare(current, { force: true });
        }
    }

    /** Exécute une écriture puis recharge la PR. Renvoie true si l'écriture a réussi. */
    async function act(write: () => Promise<unknown>, { onDone, reloadCompare = false }: ActOptions = {}): Promise<boolean> {
        try {
            await write();
        } catch (error) {
            showError(error);
            return false;
        }
        onDone?.();
        await reload({ reloadCompare });
        return true;
    }

    /** Mise à jour locale (optimiste) de l'état de relecture. */
    function patchReview(review: Review): void {
        detail.value = { ...detail.value, review };
    }

    return { detail, summary, sums, compare, compareLoading, compareError, loadSummary, loadCompare, act, patchReview };
}

export type PrLoad = ReturnType<typeof usePrLoad>;
