// Données de la page PR : détail (toujours chargé), résumé des versions, diff de la plage (avec cache),
// et écritures suivies d'un rechargement.
import { computed, ref, shallowRef } from 'vue';
import type { Comparison, PrDetail, PrRef, Review, Summary } from '../../shared/api.ts';
import { purgedSinceDetail, summaryMap, versionsChanged } from '../lib/kinds.ts';
import type { Range } from '../lib/selection.ts';
import { t } from '../i18n/index.ts';
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
    /** Bouton à l'origine de l'action (indicateur de chargement sur ce bouton). */
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
    /** Dernière demande de résumé : seule sa réponse est gardée. */
    let summaryRequest = 0;
    /** Incrémenté par chaque rechargement forcé du diff : une réponse d'avant n'écrit ni le cache ni le diff. */
    let generation = 0;

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
        // Un commit effacé par Bitbucket après sa mise en cache ne se révèle qu'au calcul du résumé : le détail, chargé
        // avant, croit encore la version lisible (et la plage peut partir d'elle). Il est rechargé une fois.
        if (purgedSinceDetail(detail.value.versions, result)) {
            await reloadDetail();
        }
    }

    /** Recharge le détail, et le résumé si la liste des versions a changé (version poussée pendant la lecture). */
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

    /** Action d'écriture en cours (clé de son bouton), jusqu'à la fin du rechargement ; une seule à la fois. */
    const pendingAction = ref<string | null>(null);
    const acting = computed(() => pendingAction.value !== null);
    const busy = (key: string): boolean => pendingAction.value === key;

    /**
     * Exécute une écriture puis recharge la PR. Renvoie true si l'écriture a réussi ; false si elle a échoué, ou si une autre
     * est en cours (message affiché, rien n'est envoyé ni oublié : le brouillon reste).
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

    /** Mise à jour locale (optimiste) de l'état de relecture. */
    function patchReview(review: Review): void {
        detail.value = { ...detail.value, review };
    }

    return {
        detail, summary, sums, compare, compareLoading, compareError, pendingAction, acting, busy,
        loadSummary, loadCompare, act, patchReview,
    };
}

export type PrLoad = ReturnType<typeof usePrLoad>;
