<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { Comment } from '../../shared/api.ts';
import { actionKey, editDraftKey } from '../composables/useDiscussion.ts';
import { usePrPage } from '../composables/usePrPage.ts';
import { t, tr } from '../i18n/index.ts';
import { displayName, fmtFull, relTime } from '../lib/format.ts';
import { avatarHue, initials } from '../lib/threads.ts';
import ConfirmButton from './ConfirmButton.vue';
import SafeHtml from './SafeHtml.vue';

const props = defineProps<{ comment: Comment }>();
const emit = defineEmits<{ reply: [] }>();
const page = usePrPage();

const name = computed(() => displayName(props.comment.user));
const isEditing = computed(() => page.editing === props.comment.id);
const editBox = ref<HTMLTextAreaElement | null>(null);
const editKey = computed(() => editDraftKey(props.comment.id));
const text = computed({
    get: () => page.draft(editKey.value),
    set: (value: string) => page.setDraft(editKey.value, value),
});
const saving = computed(() => page.busy(actionKey.edit(props.comment.id)));

function autosize(): void {
    const ta = editBox.value;
    if (ta) {
        ta.style.height = 'auto';
        ta.style.height = `${Math.min(ta.scrollHeight + 2, 240)}px`;
    }
}

watch(isEditing, async (editing) => {
    if (editing) {
        await nextTick();
        editBox.value?.focus();
        autosize();
    }
}, { immediate: true });

function save(): void {
    if (!saving.value && !page.acting && text.value.trim()) {
        void page.saveEdit(props.comment, text.value);
    }
}

function onEditKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        save();
    } else if (event.key === 'Escape') {
        event.preventDefault();
        page.cancelEdit();
    }
}
</script>

<template>
    <div :class="['rv-cm', { new: comment.isNew, pending: comment.pending }]" :data-comment="comment.id">
        <span class="rv-av" :style="{ background: `hsl(${avatarHue(comment.user)} 52% 42%)` }" :title="name" aria-hidden="true">{{ initials(name) }}</span>
        <div class="body">
            <div>
                <span class="who">{{ name }}</span>
                <span class="when" :title="fmtFull(tr(), comment.createdOn)">{{ relTime(tr(), comment.createdOn) }}</span>
                <span v-if="comment.version != null" class="vtag" :title="t('comment.versionTitle', { version: comment.version })">v{{ comment.version }}</span>
                <span v-if="comment.isNew" class="newtag">{{ t('comment.new') }}</span>
                <span v-if="comment.pending" class="sending">{{ t('comment.sending') }}</span>
            </div>
            <div v-if="comment.deleted" class="deleted">{{ t('comment.deleted') }}</div>
            <!-- being sent: the typed text (Bitbucket renders the HTML) -->
            <div v-else-if="comment.pending" class="raw">{{ comment.raw }}</div>
            <div v-else-if="isEditing" class="rv-edit">
                <textarea
                    ref="editBox"
                    v-model="text"
                    data-edit
                    rows="2"
                    :readonly="saving"
                    :aria-label="t('comment.editLabel')"
                    @input="autosize"
                    @keydown="onEditKeydown"
                />
                <div class="acts">
                    <button
                        type="button"
                        :class="['rv-btn rv-btn-sm rv-btn-primary', { busy: saving }]"
                        data-action="save-edit"
                        :disabled="!text.trim() || saving || page.acting"
                        :aria-busy="saving"
                        @click="save"
                    >
                        {{ t('common.save') }}
                    </button>
                    <button type="button" class="rv-btn rv-btn-sm" data-action="cancel-edit" :disabled="saving" @click="page.cancelEdit()">{{ t('common.cancel') }}</button>
                </div>
            </div>
            <SafeHtml v-else :html="comment.html" />
            <div v-if="!comment.deleted && !comment.pending && !isEditing" class="acts">
                <button type="button" data-action="reply" @click="emit('reply')">{{ t('common.reply') }}</button>
                <button v-if="comment.mine" type="button" data-action="edit" :disabled="page.acting" @click="page.startEdit(comment)">{{ t('common.edit') }}</button>
                <ConfirmButton
                    v-if="comment.mine"
                    data-action="delete"
                    :class="{ busy: page.busy(actionKey.remove(comment.id)) }"
                    :disabled="page.acting"
                    :aria-busy="page.busy(actionKey.remove(comment.id))"
                    :label="t('common.delete')"
                    :question="t('comment.deleteQuestion')"
                    @confirm="page.deleteComment(comment)"
                />
            </div>
        </div>
    </div>
</template>
