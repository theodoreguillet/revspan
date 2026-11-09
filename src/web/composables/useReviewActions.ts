// Relecture : approuver, demander des modifs, marquer une version relue, marquer un fichier vu (optimiste).
import { nextTick } from 'vue';
import type { FileDiff, PrRef } from '../../shared/api.ts';
import { api } from '../services/api.ts';
import type { DiffOptions } from './useDiffOptions.ts';
import { showError } from './useErrors.ts';
import type { PrLoad } from './usePrLoad.ts';

/** Clés des boutons de relecture (indicateur de chargement). */
export const ACTION_KEYS = { approve: 'approve', requestChanges: 'request-changes', markReviewed: 'mark-reviewed' } as const;

export function useReviewActions(prRef: PrRef, load: PrLoad, options: DiffOptions, keepFileInView: (path: string) => void) {
    const setApproved = (approved: boolean): Promise<boolean> => load.act(() => api.approve(prRef, approved), { key: ACTION_KEYS.approve });
    const toggleRequestChanges = (on: boolean): Promise<boolean> => load.act(() => api.requestChanges(prRef, on), { key: ACTION_KEYS.requestChanges });
    const markReviewed = (version: number): Promise<boolean> => load.act(() => api.reviewed(prRef, version), { key: ACTION_KEYS.markReviewed });

    /** Coche « Vu » : mise à jour immédiate (le fichier se replie), annulée si le serveur refuse. */
    async function setViewed(file: FileDiff, viewed: boolean): Promise<void> {
        const previous = load.detail.value.review;
        const next = { ...previous.viewed };
        if (viewed) {
            next[file.path] = file.contentHash;
        } else {
            delete next[file.path];
        }
        load.patchReview({ ...previous, viewed: next });
        options.collapsed.delete(file.path);
        await nextTick();
        keepFileInView(file.path);
        try {
            await api.viewed(prRef, { path: file.path, contentHash: file.contentHash, viewed });
        } catch (error) {
            load.patchReview({ ...load.detail.value.review, viewed: previous.viewed });
            showError(error);
        }
    }

    return { setApproved, toggleRequestChanges, markReviewed, setViewed };
}
