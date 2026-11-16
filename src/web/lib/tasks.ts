// Local (optimistic) updates of the Tasks tab's list, applied before the server answers. Pure: every function returns
// new objects.
import type { PrTask, Thread, User } from '../../shared/api.ts';

/** Task being created: negative temporary id, the typed text (Bitbucket renders the HTML), created by me now. */
export function pendingTask(tempId: number, raw: string, me: User | null): PrTask {
    return {
        id: tempId, raw, html: '', resolved: false, creator: me, createdOn: new Date().toISOString(), resolvedBy: null, commentId: null, mine: true, pending: true,
    };
}

/** Replaces the task `id` (a pending one) by the one the server returned. */
export function replaceTask(list: readonly PrTask[], id: number, task: PrTask): PrTask[] {
    return list.map((t) => (t.id === id ? task : t));
}

export function withoutTask(list: readonly PrTask[], id: number): PrTask[] {
    return list.filter((t) => t.id !== id);
}

/** Puts a task back at its former index (a delete that failed); at the end if the list got shorter since. */
export function insertTask(list: readonly PrTask[], task: PrTask, index: number): PrTask[] {
    const next = list.slice();
    next.splice(Math.min(index, next.length), 0, task);
    return next;
}

/** Ticked (by `me`) or reopened. */
export function withTaskResolved(task: PrTask, resolved: boolean, me: User | null): PrTask {
    return { ...task, resolved, resolvedBy: resolved ? me : null };
}

/** Thread holding a comment (root or reply), by its root id; null when the comment is not in any thread shown. */
export function commentThreadId(threads: readonly Thread[], commentId: number): number | null {
    return threads.find((t) => t.comments.some((c) => c.id === commentId))?.id ?? null;
}
