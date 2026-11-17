<script setup lang="ts">
// Tasks tab: the PR's Bitbucket tasks (read when the tab opens), tick, delete mine, add one at the bottom.
import type { PrTask } from '../../shared/api.ts';
import { usePrPage } from '../composables/usePrPage.ts';
import { taskActionKey } from '../composables/useTasks.ts';
import { t, tr } from '../i18n/index.ts';
import { displayName, fmtFull, relTime } from '../lib/format.ts';
import ConfirmButton from './ConfirmButton.vue';
import SafeHtml from './SafeHtml.vue';

const page = usePrPage();

function add(): void {
    if (!page.acting && page.tasks !== null && page.taskDraft.trim()) {
        void page.addTask(page.taskDraft);
    }
}

/** The box shows the task's state once the write is over (a refused write leaves it as it was). */
async function toggle(task: PrTask, event: Event): Promise<void> {
    const box = event.target as HTMLInputElement;
    await page.setTaskResolved(task, box.checked);
    box.checked = page.tasks?.find((x) => x.id === task.id)?.resolved ?? box.checked;
}
</script>

<template>
    <div class="rv-tasks">
        <div class="rv-tasks-list">
            <template v-if="page.tasks === null">
                <p v-if="page.tasksError && !page.tasksLoading" class="rv-task muted" data-tasks="unavailable">
                    {{ t('task.unavailable') }}
                    <button type="button" class="rv-btn rv-btn-sm" data-action="retry-tasks" @click="page.loadTasks()">{{ t('task.retry') }}</button>
                </p>
                <div v-else class="rv-tasks-skel" data-tasks="loading" aria-busy="true">
                    <div v-for="i in 2" :key="i" class="rv-skel-row"><div class="rv-skel l1" /><div class="rv-skel l2" /></div>
                </div>
            </template>
            <template v-else>
                <p v-if="!page.tasks.length" class="rv-task muted" data-tasks="empty">{{ t('task.empty') }}</p>
                <div
                    v-for="task in page.tasks"
                    :key="task.id"
                    :class="['rv-task', { done: task.resolved, pending: task.pending }]"
                    :data-task="task.id"
                    :data-state="task.resolved ? 'resolved' : 'open'"
                >
                    <input
                        type="checkbox"
                        data-action="resolve-task"
                        :checked="task.resolved"
                        :disabled="task.pending || page.acting"
                        :aria-label="t('task.done')"
                        @change="toggle(task, $event)"
                    >
                    <div class="body">
                        <!-- being sent: the typed text (Bitbucket renders the HTML) -->
                        <div v-if="task.pending" class="raw">{{ task.raw }}</div>
                        <SafeHtml v-else :html="task.html" />
                        <div class="meta">
                            <span class="who">{{ displayName(task.creator) }}</span>
                            <span class="when" :title="fmtFull(tr(), task.createdOn)">{{ relTime(tr(), task.createdOn) }}</span>
                            <span v-if="task.resolved && task.resolvedBy" class="by">{{ t('task.resolvedBy', { name: displayName(task.resolvedBy) }) }}</span>
                            <span v-if="task.pending" class="sending">{{ t('comment.sending') }}</span>
                            <button v-if="task.commentId !== null" type="button" data-action="show-comment" @click="page.showComment(task.commentId)">
                                {{ t('task.showComment') }}
                            </button>
                            <ConfirmButton
                                v-if="task.mine && !task.pending"
                                data-action="delete-task"
                                :class="{ busy: page.busy(taskActionKey.remove(task.id)) }"
                                :disabled="page.acting"
                                :aria-busy="page.busy(taskActionKey.remove(task.id))"
                                :label="t('common.delete')"
                                :question="t('task.deleteQuestion')"
                                @confirm="page.deleteTask(task)"
                            />
                        </div>
                    </div>
                </div>
            </template>
            <form class="rv-task-new" @submit.prevent="add">
                <!-- until the list is read, a task added would have no list to show in -->
                <input
                    v-model="page.taskDraft"
                    type="text"
                    data-new-task
                    maxlength="32000"
                    :disabled="page.tasks === null"
                    :placeholder="t('task.new')"
                    :aria-label="t('task.new')"
                >
                <button
                    type="submit"
                    :class="['rv-btn rv-btn-sm rv-btn-primary', { busy: page.busy(taskActionKey.add) }]"
                    data-action="add-task"
                    :disabled="page.tasks === null || !page.taskDraft.trim() || page.acting"
                    :aria-busy="page.busy(taskActionKey.add)"
                >
                    {{ t('task.add') }}
                </button>
            </form>
        </div>
    </div>
</template>
