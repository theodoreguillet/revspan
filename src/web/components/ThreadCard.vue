<script setup lang="ts">
// Fil de discussion : en-tête (version, ligne, état), commentaires, réponse, résolution.
// Dans le diff, un fil résolu est replié en une barre cliquable.
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { Thread, ThreadPlacement } from '../../shared/api.ts';
import { actionKey, replyDraftKey } from '../composables/useDiscussion.ts';
import { usePrPage } from '../composables/usePrPage.ts';
import { t } from '../i18n/index.ts';
import CommentItem from './CommentItem.vue';
import I18nText from './I18nText.vue';

const props = withDefaults(defineProps<{
    thread: Thread;
    placement?: ThreadPlacement | null;
    context?: 'diff' | 'disc';
    fileLevel?: boolean;
}>(), { placement: null, context: 'diff', fileLevel: false });

const page = usePrPage();
const root = ref<HTMLElement | null>(null);
const replyBox = ref<HTMLTextAreaElement | null>(null);
const sending = ref(false);

const draftKey = computed(() => replyDraftKey(props.thread.id));
const reply = computed({
    get: () => page.draft(draftKey.value),
    set: (value: string) => page.setDraft(draftKey.value, value),
});
const collapsedBar = computed(() => props.thread.resolved && props.context === 'diff' && !page.expandedThreads.has(props.thread.id));
const origin = computed(() => props.thread.anchor?.to ?? props.thread.anchor?.from ?? null);
const fromOnly = computed(() => props.thread.anchor?.to == null && props.thread.anchor?.from != null);

async function sendReply(): Promise<void> {
    const text = reply.value.trim();
    if (!text || sending.value) {
        return;
    }
    sending.value = true;
    try {
        await page.reply(props.thread, text);
    } finally {
        sending.value = false;
    }
}

function onReplyKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        void sendReply();
    } else if (event.key === 'Escape') {
        (event.target as HTMLTextAreaElement).blur();
    }
}

function focusReply(): void {
    replyBox.value?.focus();
    replyBox.value?.scrollIntoView({ block: 'nearest' });
}

// n/p et « Voir dans le diff » font défiler jusqu'à ce fil (barre repliée ou fil complet)
watch(root, (el, previous) => {
    if (previous) {
        page.unregisterThread(previous);
    }
    if (el) {
        page.registerThread(el, { threadId: props.thread.id, inDiff: props.context === 'diff' });
    }
});
onBeforeUnmount(() => {
    if (root.value) {
        page.unregisterThread(root.value);
    }
});

function autosize(): void {
    const ta = replyBox.value;
    if (ta) {
        ta.style.height = 'auto';
        ta.style.height = `${Math.min(ta.scrollHeight + 2, 240)}px`;
    }
}
</script>

<template>
    <div v-if="collapsedBar" ref="root" :class="['rv-th', { 'file-level': fileLevel }]" :data-thread="thread.id" data-resolved="1">
        <button type="button" class="rv-th-bar" aria-expanded="false" @click="page.toggleThreadExpanded(thread.id)">
            <span class="ok">✓</span>
            {{ thread.resolvedBy ? t('thread.resolvedBarBy', { name: thread.resolvedBy.displayName }) : t('thread.resolvedBar') }}
            · {{ t('common.comments', { count: thread.comments.length }) }}<template v-if="thread.anchor?.to"> · {{ t('thread.line', { line: placement?.line ?? thread.anchor.to }) }}</template>
        </button>
    </div>
    <div v-else ref="root" :class="['rv-th', { 'file-level': fileLevel }]" :data-thread="thread.id">
        <div class="rv-th-h">
            <span v-if="thread.path == null">
                <I18nText k="thread.generalPostedOn"><template #version><b>v{{ thread.version }}</b></template></I18nText>
            </span>
            <span v-else>
                <I18nText k="thread.postedOn"><template #version><b>v{{ thread.version }}</b></template></I18nText>
                <template v-if="origin != null"> · {{ t('thread.line', { line: origin }) }}<template v-if="fromOnly"> {{ t('thread.oldVersion') }}</template></template>
                <template v-if="placement?.line != null && placement.line !== origin"> {{ t('thread.lineHere', { line: placement.line }) }}</template>
                <template v-if="placement?.moved"> · <span class="rv-moved" :title="t('thread.movedTitle')">{{ t('thread.moved') }}</span></template>
                <template v-if="fileLevel && placement?.outOfHunks"> · {{ t('thread.outOfHunks') }}</template>
                <template v-else-if="fileLevel && placement && placement.line == null"> · {{ t('thread.fileLevel') }}</template>
            </span>
            <span v-if="thread.resolved">
                <span class="st res">{{ thread.resolvedBy ? t('thread.resolvedBy', { name: thread.resolvedBy.displayName }) : t('thread.resolved') }}</span>
                <template v-if="context === 'diff'"> · <button type="button" class="rv-link" @click="page.toggleThreadExpanded(thread.id)">{{ t('thread.collapse') }}</button></template>
            </span>
            <span v-else><span class="st open">{{ t('thread.open') }}</span></span>
        </div>
        <CommentItem v-for="c in thread.comments" :key="c.id" :comment="c" @reply="focusReply" />
        <div class="rv-th-f">
            <textarea
                ref="replyBox"
                v-model="reply"
                rows="1"
                :placeholder="t('thread.replyPlaceholder')"
                :aria-label="t('thread.replyLabel')"
                :disabled="sending"
                @input="autosize"
                @keydown="onReplyKeydown"
            />
            <button
                type="button"
                :class="['rv-btn rv-btn-sm rv-btn-primary', { busy: sending }]"
                data-action="send-reply"
                :disabled="!reply.trim() || sending || page.acting"
                :aria-busy="sending"
                @click="sendReply"
            >
                {{ t('common.reply') }}
            </button>
            <button
                type="button"
                :class="['rv-btn rv-btn-sm', { busy: page.busy(actionKey.resolve(thread.id)) }]"
                :data-action="thread.resolved ? 'reopen' : 'resolve'"
                :disabled="page.acting"
                :aria-busy="page.busy(actionKey.resolve(thread.id))"
                @click="page.resolve(thread, !thread.resolved)"
            >
                {{ thread.resolved ? t('thread.reopen') : t('thread.resolve') }}
            </button>
        </div>
    </div>
</template>
