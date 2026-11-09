// Review: approve, request changes, mark a version reviewed, mark a file seen (optimistic).
import { nextTick } from 'vue';
import type { FileDiff, PrRef } from '../../shared/api.ts';
import { api } from '../services/api.ts';
import type { DiffOptions } from './useDiffOptions.ts';
import { showError } from './useErrors.ts';
import type { PrLoad } from './usePrLoad.ts';

/** Keys of the review buttons (loading indicator). */
export const ACTION_KEYS = { approve: 'approve', requestChanges: 'request-changes', markReviewed: 'mark-reviewed' } as const;

export function useReviewActions(prRef: PrRef, load: PrLoad, options: DiffOptions, keepFileInView: (path: string) => void) {
    const setApproved = (approved: boolean): Promise<boolean> => load.act(() => api.approve(prRef, approved), { key: ACTION_KEYS.approve });
    const toggleRequestChanges = (on: boolean): Promise<boolean> => load.act(() => api.requestChanges(prRef, on), { key: ACTION_KEYS.requestChanges });
    const markReviewed = (version: number): Promise<boolean> => load.act(() => api.reviewed(prRef, version), { key: ACTION_KEYS.markReviewed });

    /** Ticks "Seen" for a file in the local state (fingerprint, or undefined = not seen), without touching other files. */
    function patchViewed(path: string, contentHash: string | undefined): void {
        const review = load.detail.value.review;
        const viewed = { ...review.viewed };
        if (contentHash === undefined) {
            delete viewed[path];
        } else {
            viewed[path] = contentHash;
        }
        load.patchReview({ ...review, viewed });
    }

    /**
     * Ticks "Seen": immediate update (the file collapses), rolled back if the server refuses. Only this file is
     * rolled back: ticks set meanwhile on other files stay.
     */
    async function setViewed(file: FileDiff, viewed: boolean): Promise<void> {
        const previous = load.detail.value.review.viewed[file.path];
        patchViewed(file.path, viewed ? file.contentHash : undefined);
        options.collapsed.delete(file.path);
        await nextTick();
        keepFileInView(file.path);
        try {
            await api.viewed(prRef, { path: file.path, contentHash: file.contentHash, viewed });
        } catch (error) {
            patchViewed(file.path, previous);
            showError(error);
        }
    }

    return { setApproved, toggleRequestChanges, markReviewed, setViewed };
}
