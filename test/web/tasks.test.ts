import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrDetail, PrTask } from '../../src/shared/api.ts';
import { usePrLoad } from '../../src/web/composables/usePrLoad.ts';
import { useTasks } from '../../src/web/composables/useTasks.ts';
import { commentThreadId, insertTask, pendingTask, replaceTask, withoutTask, withTaskResolved } from '../../src/web/lib/tasks.ts';
import { prLong } from './fixtures.ts';

const { api, showError } = vi.hoisted(() => ({
    api: { pr: vi.fn(), summary: vi.fn(), tasks: vi.fn(), createTask: vi.fn(), deleteTask: vi.fn(), resolveTask: vi.fn() },
    showError: vi.fn(),
}));
vi.mock('../../src/web/services/api.ts', async (importOriginal) => ({ ...await importOriginal<object>(), api }));
vi.mock('../../src/web/composables/useErrors.ts', () => ({ showError }));

const ref = { workspace: 'acme', repo: 'records-api', id: 212 };
const me = { uuid: '{me-uuid}', displayName: 'Thomas Girard', nickname: 'tgirard' };
const cam = { uuid: '{cam}', displayName: 'Camille Durand', nickname: 'cdurand' };

/** Promise resolved or rejected by hand (slow request). */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((ok, ko) => {
        resolve = ok;
        reject = ko;
    });
    return { promise, resolve, reject };
}

/** Lets already-resolved promises through (background refreshes started without awaiting). */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

function task(id: number, raw: string, over: Partial<PrTask> = {}): PrTask {
    return {
        id, raw, html: `<p>${raw}</p>`, resolved: false, creator: cam, createdOn: '2026-11-10T09:00:00Z', resolvedBy: null, commentId: null, mine: false, ...over,
    };
}

describe('useTasks', () => {
    let detail: PrDetail;

    beforeEach(() => {
        vi.clearAllMocks();
        const base = prLong().data;
        detail = { ...base, me, pr: { ...base.pr, taskCount: 1 } };
        api.pr.mockReturnValue(new Promise(() => undefined));
        api.tasks.mockResolvedValue([task(1, 'Add a test'), task(2, 'Changelog', { resolved: true, resolvedBy: cam })]);
    });

    it('reads the list only when asked, and shows no list before', async () => {
        const load = usePrLoad(ref, detail);
        const tasks = useTasks(ref, load);
        expect(tasks.tasks.value).toBeNull();
        expect(api.tasks).not.toHaveBeenCalled();
        const reading = tasks.loadTasks();
        expect(tasks.tasksLoading.value).toBe(true);
        await reading;
        expect(api.tasks).toHaveBeenCalledWith(ref);
        expect(tasks.tasks.value?.map((t) => t.id)).toEqual([1, 2]);
        expect(tasks.tasksLoading.value).toBe(false);
    });

    it('useTasks adds a pending task then the server one', async () => {
        const load = usePrLoad(ref, detail);
        const tasks = useTasks(ref, load);
        await tasks.loadTasks();
        const sent = deferred<PrTask>();
        api.createTask.mockReturnValue(sent.promise);
        tasks.taskDraft.value = 'Rename archiveAll';

        const adding = tasks.addTask('Rename archiveAll');
        expect(tasks.tasks.value?.at(-1)).toMatchObject({ raw: 'Rename archiveAll', pending: true, mine: true, creator: me, resolved: false });
        expect(tasks.tasks.value?.at(-1)?.id).toBeLessThan(0);
        expect(tasks.taskDraft.value).toBe('');
        expect(load.detail.value.pr.taskCount).toBe(2);
        expect(api.createTask).toHaveBeenCalledWith(ref, 'Rename archiveAll');

        const created = task(3, 'Rename archiveAll', { creator: me, mine: true });
        sent.resolve(created);
        expect(await adding).toBe(true);
        expect(tasks.tasks.value?.map((t) => t.id)).toEqual([1, 2, 3]);
        expect(tasks.tasks.value?.at(-1)).toEqual(created);
        // the background detail refresh brings the server's count
        expect(api.pr).toHaveBeenCalledWith(ref, { fresh: true });
    });

    it('…restores the text on failure', async () => {
        const load = usePrLoad(ref, detail);
        const tasks = useTasks(ref, load);
        await tasks.loadTasks();
        const sent = deferred<PrTask>();
        api.createTask.mockReturnValue(sent.promise);
        tasks.taskDraft.value = 'Rename archiveAll';

        const adding = tasks.addTask('Rename archiveAll');
        tasks.taskDraft.value = 'typed meanwhile';
        sent.reject(new Error('refused'));
        expect(await adding).toBe(false);
        expect(tasks.tasks.value?.map((t) => t.id)).toEqual([1, 2]);
        expect(tasks.taskDraft.value).toBe('Rename archiveAll typed meanwhile');
        expect(load.detail.value.pr.taskCount).toBe(1);
        expect(showError).toHaveBeenCalledOnce();
        await settle();
        expect(api.pr).not.toHaveBeenCalled();
    });

    it('an empty text sends nothing', async () => {
        const load = usePrLoad(ref, detail);
        const tasks = useTasks(ref, load);
        expect(await tasks.addTask('   ')).toBe(false);
        expect(api.createTask).not.toHaveBeenCalled();
    });

    it('ticks a task at once, rolls back when the write fails', async () => {
        const load = usePrLoad(ref, detail);
        const tasks = useTasks(ref, load);
        await tasks.loadTasks();
        const first = tasks.tasks.value?.[0];
        if (!first) {
            throw new Error('no task');
        }
        const write = deferred<PrTask>();
        api.resolveTask.mockReturnValue(write.promise);
        const ticking = tasks.setTaskResolved(first, true);
        expect(tasks.tasks.value?.[0]).toMatchObject({ resolved: true, resolvedBy: me });
        expect(load.detail.value.pr.taskCount).toBe(0);
        expect(api.resolveTask).toHaveBeenCalledWith(ref, 1, true);
        write.reject(new Error('refused'));
        expect(await ticking).toBe(false);
        expect(tasks.tasks.value?.[0]).toMatchObject({ resolved: false, resolvedBy: null });
        expect(load.detail.value.pr.taskCount).toBe(1);

        api.resolveTask.mockResolvedValue(task(1, 'Add a test', { resolved: true, resolvedBy: me }));
        expect(await tasks.setTaskResolved(first, true)).toBe(true);
        expect(tasks.tasks.value?.[0]).toMatchObject({ resolved: true, resolvedBy: me });
    });

    it('deletes a task at once, puts it back in place when the write fails', async () => {
        const load = usePrLoad(ref, detail);
        const tasks = useTasks(ref, load);
        await tasks.loadTasks();
        const first = tasks.tasks.value?.[0];
        if (!first) {
            throw new Error('no task');
        }
        const write = deferred<{ ok: true }>();
        api.deleteTask.mockReturnValue(write.promise);
        const deleting = tasks.deleteTask(first);
        expect(tasks.tasks.value?.map((t) => t.id)).toEqual([2]);
        expect(load.detail.value.pr.taskCount).toBe(0);
        write.reject(new Error('gone'));
        expect(await deleting).toBe(false);
        expect(tasks.tasks.value?.map((t) => t.id)).toEqual([1, 2]);
        expect(load.detail.value.pr.taskCount).toBe(1);

        api.deleteTask.mockResolvedValue({ ok: true });
        expect(await tasks.deleteTask(first)).toBe(true);
        expect(tasks.tasks.value?.map((t) => t.id)).toEqual([2]);
        expect(api.deleteTask).toHaveBeenLastCalledWith(ref, 1);
    });

    it('drops a list read that started before a write, and reads again once the write is over', async () => {
        const load = usePrLoad(ref, detail);
        const tasks = useTasks(ref, load);
        await tasks.loadTasks();
        const stale = deferred<PrTask[]>();
        api.tasks.mockReturnValueOnce(stale.promise);
        const reading = tasks.loadTasks();
        api.createTask.mockResolvedValue(task(3, 'New', { creator: me, mine: true }));
        api.tasks.mockResolvedValueOnce([task(1, 'Add a test'), task(2, 'Changelog'), task(3, 'New', { creator: me, mine: true })]);
        await tasks.addTask('New');
        // the read sent before the creation answers without it: not shown
        stale.resolve([task(1, 'Add a test'), task(2, 'Changelog')]);
        await reading;
        await settle();
        expect(tasks.tasks.value?.map((t) => t.id)).toEqual([1, 2, 3]);
        expect(api.tasks).toHaveBeenCalledTimes(3);
    });

    it('a failed read shows the error and keeps the list shown', async () => {
        const load = usePrLoad(ref, detail);
        const tasks = useTasks(ref, load);
        await tasks.loadTasks();
        api.tasks.mockRejectedValueOnce(new Error('down'));
        await tasks.loadTasks();
        expect(showError).toHaveBeenCalledOnce();
        expect(tasks.tasks.value?.map((t) => t.id)).toEqual([1, 2]);
        expect(tasks.tasksError.value).toBeInstanceOf(Error);
    });
});

describe('lib/tasks', () => {
    const list = [task(1, 'a'), task(2, 'b'), task(3, 'c')];

    it('pending task, replace, remove, insert back at its place', () => {
        const pending = pendingTask(-1, 'new', me);
        expect(pending).toMatchObject({ id: -1, raw: 'new', html: '', resolved: false, creator: me, mine: true, pending: true, commentId: null });
        const server = task(4, 'new');
        expect(replaceTask([...list, pending], -1, server).map((t) => t.id)).toEqual([1, 2, 3, 4]);
        expect(withoutTask(list, 2).map((t) => t.id)).toEqual([1, 3]);
        expect(insertTask(withoutTask(list, 2), list[1] ?? server, 1).map((t) => t.id)).toEqual([1, 2, 3]);
        expect(insertTask([], server, 5).map((t) => t.id)).toEqual([4]);
    });

    it('resolved by me, reopened without resolver', () => {
        expect(withTaskResolved(task(1, 'a'), true, me)).toMatchObject({ resolved: true, resolvedBy: me });
        expect(withTaskResolved(task(1, 'a', { resolved: true, resolvedBy: cam }), false, me)).toMatchObject({ resolved: false, resolvedBy: null });
    });

    it('thread of a comment: the root of the thread holding it, null when unknown', () => {
        const threads = prLong().data.threads;
        const thread = threads.find((t) => t.comments.length > 1);
        const reply = thread?.comments[1];
        expect(thread && reply && commentThreadId(threads, reply.id)).toBe(thread?.id);
        expect(commentThreadId(threads, 987654321)).toBeNull();
    });
});
