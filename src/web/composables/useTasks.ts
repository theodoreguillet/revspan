// Tasks tab: the PR's Bitbucket tasks, read only when the tab is opened (and on ↻ while it is open). Writes show at once
// (pending task, ticked or removed row), are undone if Bitbucket refuses them (the typed text comes back), and the open
// task count is then read from the PR's light pulse (one request, not the whole detail).
import { ref, shallowRef } from 'vue';
import type { PrPulse, PrRef, PrTask } from '../../shared/api.ts';
import { afterTaskWrite } from '../lib/pulse.ts';
import { insertTask, pendingTask, replaceTask, withoutTask, withTaskResolved } from '../lib/tasks.ts';
import { api } from '../services/api.ts';
import { showError } from './useErrors.ts';
import type { ActOptions, PrLoad } from './usePrLoad.ts';

/** Keys of the task buttons (single-write lock and loading indicator). */
export const taskActionKey = {
    add: 'task:add',
    remove: (taskId: number): string => `task-delete:${taskId}`,
    resolve: (taskId: number): string => `task-resolve:${taskId}`,
};

export function useTasks(prRef: PrRef, load: PrLoad) {
    /** null: not read yet (the tab was never opened). */
    const tasks = shallowRef<PrTask[] | null>(null);
    const tasksLoading = ref(false);
    /** Error of the latest read (the list read before, if any, stays shown). */
    const tasksError = shallowRef<unknown>(null);
    /** Text of the "New task" input. */
    const taskDraft = ref('');
    /** Temporary ids of the tasks being created (negative: never a Bitbucket id). */
    let lastTempId = 0;
    /** Latest list read: only its answer is shown. */
    let listRequest = 0;
    /** Task writes started so far, and those in progress: a read during which one started may predate it. */
    let writesStarted = 0;
    let writesRunning = 0;
    /** A read was dropped while a write was in progress: read again when that write ends. */
    let reloadWanted = false;

    function patchList(fn: (list: PrTask[]) => PrTask[]): void {
        if (tasks.value) {
            tasks.value = fn(tasks.value);
        }
    }

    /** Local open count of the tab label, until the pulse read after the write brings Bitbucket's. */
    function patchCount(delta: number): void {
        load.patchDetail((d) => ({ ...d, pr: { ...d.pr, taskCount: Math.max(0, (d.pr.taskCount ?? 0) + delta) } }));
    }

    /**
     * Reads the list. An answer that may predate a task write (sent during one, or one started meanwhile) is dropped:
     * read again at once, or when the write in progress ends.
     */
    async function loadTasks(): Promise<void> {
        const request = ++listRequest;
        tasksLoading.value = true;
        try {
            for (;;) {
                const started = writesStarted;
                const duringWrite = writesRunning > 0;
                let list: PrTask[];
                try {
                    list = await api.tasks(prRef);
                } catch (error) {
                    if (request === listRequest) {
                        tasksError.value = error;
                        showError(error);
                    }
                    return;
                }
                if (request !== listRequest) {
                    return;
                }
                if (started === writesStarted && !duringWrite && writesRunning === 0) {
                    tasks.value = list;
                    tasksError.value = null;
                    return;
                }
                if (writesRunning > 0) {
                    reloadWanted = true;
                    return;
                }
            }
        } finally {
            if (request === listRequest) {
                tasksLoading.value = false;
            }
        }
    }

    /**
     * Bitbucket's open count after a task write: one pulse read, kept unless the detail changed meanwhile (another write
     * or a refresh, which bring their own). A failure leaves the local count.
     */
    async function confirmCount(): Promise<void> {
        const seq = load.syncSeq();
        let now: PrPulse;
        try {
            now = await api.pulse(prRef);
        } catch {
            return;
        }
        if (seq !== load.syncSeq() || load.acting.value) {
            return;
        }
        load.patchDetail((d) => ({ ...d, pr: { ...d.pr, taskCount: now.taskCount }, pulse: afterTaskWrite(d.pulse, now) }));
    }

    /**
     * A task write through the page's single-write lock (`act`), confirmed by a pulse read instead of a detail refresh;
     * the list read is kept consistent with it.
     */
    async function taskAct(write: () => Promise<unknown>, { optimistic, ...options }: ActOptions): Promise<boolean> {
        let started = false;
        const ok = await load.act(write, {
            ...options,
            refresh: false,
            optimistic: () => {
                started = true;
                writesStarted++;
                writesRunning++;
                optimistic?.();
            },
        });
        if (started) {
            writesRunning--;
            if (reloadWanted && writesRunning === 0) {
                reloadWanted = false;
                void loadTasks();
            }
        }
        if (ok) {
            void confirmCount();
        }
        return ok;
    }

    /** Creates a task: shown at once as pending, replaced by Bitbucket's; on failure it goes and the text comes back. */
    function addTask(text: string): Promise<boolean> {
        const raw = text.trim();
        if (!raw) {
            return Promise.resolve(false);
        }
        const tempId = --lastTempId;
        let created: PrTask | null = null;
        return taskAct(async () => {
            created = await api.createTask(prRef, raw);
        }, {
            key: taskActionKey.add,
            optimistic: () => {
                patchList((list) => [...list, pendingTask(tempId, raw, load.detail.value.me)]);
                taskDraft.value = '';
                patchCount(1);
            },
            rollback: () => {
                patchList((list) => withoutTask(list, tempId));
                // before anything typed in the input since
                const typed = taskDraft.value.trim();
                taskDraft.value = typed ? `${raw} ${typed}` : raw;
                patchCount(-1);
            },
            onDone: () => {
                const task = created;
                if (task) {
                    patchList((list) => replaceTask(list, tempId, task));
                }
            },
        });
    }

    /** Ticks or reopens a task at once; put back as it was if Bitbucket refuses. */
    function setTaskResolved(task: PrTask, resolved: boolean): Promise<boolean> {
        const before = tasks.value?.find((t) => t.id === task.id) ?? task;
        let updated: PrTask | null = null;
        return taskAct(async () => {
            updated = await api.resolveTask(prRef, task.id, resolved);
        }, {
            key: taskActionKey.resolve(task.id),
            optimistic: () => {
                patchList((list) => list.map((t) => (t.id === task.id ? withTaskResolved(t, resolved, load.detail.value.me) : t)));
                if (before.resolved !== resolved) {
                    patchCount(resolved ? -1 : 1);
                }
            },
            rollback: () => {
                patchList((list) => list.map((t) => (t.id === task.id ? before : t)));
                if (before.resolved !== resolved) {
                    patchCount(resolved ? 1 : -1);
                }
            },
            onDone: () => {
                const saved = updated;
                if (saved) {
                    patchList((list) => replaceTask(list, task.id, saved));
                }
            },
        });
    }

    /** Deletes a task (the button asks first): removed at once, put back in place if Bitbucket refuses. */
    function deleteTask(task: PrTask): Promise<boolean> {
        const index = tasks.value?.findIndex((t) => t.id === task.id) ?? -1;
        const before = tasks.value?.[index] ?? task;
        return taskAct(() => api.deleteTask(prRef, task.id), {
            key: taskActionKey.remove(task.id),
            optimistic: () => {
                patchList((list) => withoutTask(list, task.id));
                if (!before.resolved) {
                    patchCount(-1);
                }
            },
            rollback: () => {
                patchList((list) => insertTask(list, before, Math.max(index, 0)));
                if (!before.resolved) {
                    patchCount(1);
                }
            },
        });
    }

    return { tasks, tasksLoading, tasksError, taskDraft, loadTasks, addTask, setTaskResolved, deleteTask };
}
