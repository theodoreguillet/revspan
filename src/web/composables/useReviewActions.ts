// Review: approve, request changes, mark a version reviewed, mark a file seen; each shown at once (optimistic).
import { nextTick } from 'vue';
import type { FileDiff, PrDetail, PrRef } from '../../shared/api.ts';
import { withMyReview, withReviewedMark } from '../lib/optimistic.ts';
import { api } from '../services/api.ts';
import type { DiffOptions } from './useDiffOptions.ts';
import { showError } from './useErrors.ts';
import type { PrLoad } from './usePrLoad.ts';

/** Keys of the review buttons (loading indicator). */
export const ACTION_KEYS = { approve: 'approve', requestChanges: 'request-changes', markReviewed: 'mark-reviewed' } as const;

export function useReviewActions(prRef: PrRef, load: PrLoad, options: DiffOptions, keepFileInView: (path: string) => void) {
    /**
     * A review write shown at once (`change` of the detail: participants, review, pulse), put back as it was if it fails
     * (files ticked meanwhile stay ticked). The buttons then act on the new state: a second click undoes the first.
     */
    function reviewAct(write: () => Promise<unknown>, key: string, change: (d: PrDetail) => PrDetail): Promise<boolean> {
        let before: Pick<PrDetail, 'participants' | 'review' | 'pulse'> | null = null;
        return load.act(write, {
            key,
            optimistic: () => {
                const { participants, review, pulse } = load.detail.value;
                before = { participants, review, pulse };
                load.patchDetail(change);
            },
            rollback: () => {
                const saved = before;
                if (saved) {
                    load.patchDetail((d) => ({ ...d, ...saved, review: { ...saved.review, viewed: d.review.viewed } }));
                }
            },
        });
    }

    const now = (): string => new Date().toISOString();
    const setApproved = (approved: boolean): Promise<boolean> => reviewAct(() => api.approve(prRef, approved), ACTION_KEYS.approve,
        (d) => withMyReview(d, { approved, state: approved ? 'approved' : null }, now()));
    const toggleRequestChanges = (on: boolean): Promise<boolean> => reviewAct(() => api.requestChanges(prRef, on), ACTION_KEYS.requestChanges,
        (d) => withMyReview(d, { approved: false, state: on ? 'changes_requested' : null }, now()));
    const markReviewed = (version: number): Promise<boolean> => reviewAct(() => api.reviewed(prRef, version), ACTION_KEYS.markReviewed,
        (d) => withReviewedMark(d, version, now()));

    /** Ticks "Seen" for a file in the local state (fingerprint, or undefined = not seen), without touching other files. */
    function patchViewed(path: string, contentHash: string | undefined): void {
        patchViewedMany([[path, contentHash]]);
    }

    /** Same for several files in one update. */
    function patchViewedMany(changes: readonly (readonly [string, string | undefined])[]): void {
        const review = load.detail.value.review;
        const viewed = { ...review.viewed };
        for (const [path, contentHash] of changes) {
            if (contentHash === undefined) {
                delete viewed[path];
            } else {
                viewed[path] = contentHash;
            }
        }
        load.patchReview({ ...review, viewed });
    }

    /**
     * Ticks "Seen": immediate update (the file collapses), rolled back if the server refuses. Only this file is
     * rolled back: ticks set meanwhile on other files stay. `keepInView: false` when the caller scrolls elsewhere itself
     * ("v" moving to the next unseen file).
     */
    async function setViewed(file: FileDiff, viewed: boolean, { keepInView = true } = {}): Promise<void> {
        const previous = load.detail.value.review.viewed[file.path];
        patchViewed(file.path, viewed ? file.contentHash : undefined);
        options.collapsed.delete(file.path);
        await nextTick();
        if (keepInView) {
            keepFileInView(file.path);
        }
        try {
            await api.viewed(prRef, { path: file.path, contentHash: file.contentHash, viewed });
        } catch (error) {
            patchViewed(file.path, previous);
            showError(error);
        }
    }

    /**
     * "Mark all as viewed" (or not viewed) for these files: every file at once, one request, the files collapse like a
     * single "Seen". On failure only these files are rolled back.
     */
    async function setAllViewed(files: readonly FileDiff[], viewed: boolean): Promise<void> {
        if (!files.length) {
            return;
        }
        const previous = files.map((file): [string, string | undefined] => [file.path, load.detail.value.review.viewed[file.path]]);
        patchViewedMany(files.map((file) => [file.path, viewed ? file.contentHash : undefined]));
        for (const file of files) {
            options.collapsed.delete(file.path);
        }
        try {
            await api.viewed(prRef, { files: files.map(({ path, contentHash }) => ({ path, contentHash })), viewed });
        } catch (error) {
            patchViewedMany(previous);
            showError(error);
        }
    }

    return { setApproved, toggleRequestChanges, markReviewed, setViewed, setAllViewed };
}
