<script setup lang="ts">
// Discussion thread: header (version, line, state), comments, reply, resolution.
// In the diff, a resolved thread is folded into a clickable bar.
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { Thread, ThreadPlacement } from '../../shared/api.ts';
import { actionKey, replyDraftKey } from '../composables/useDiscussion.ts';
import { usePrPage } from '../composables/usePrPage.ts';
import { t, tr } from '../i18n/index.ts';
import { anchorSpan, placementSpan, sameSpan, spanLabel } from '../lib/threads.ts';
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
/** Lines the comment was written on (« ligne 12 », « lignes 220–227 »), on the old side for a removed line. */
const origin = computed(() => anchorSpan(props.thread.anchor));
/** Lines where it shows in this diff, when they differ from those (relocated). */
const here = computed(() => {
    const span = placementSpan(props.placement);
    return span && !(origin.value && sameSpan(span, origin.value)) ? span : null;
});
/** Folded bar: the lines shown, or those of the comment (new side only). */
const barSpan = computed(() => (props.thread.anchor?.to ? placementSpan(props.placement) ?? origin.value : null));
/** New thread being sent: no reply nor resolution until Bitbucket gives it an id. */
const pending = computed(() => props.thread.comments[0]?.pending === true);

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

// n/p and "View in diff" scroll to this thread (folded bar or full thread)
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
            · {{ t('common.comments', { count: thread.comments.length }) }}<template v-if="barSpan"> · {{ spanLabel(tr(), barSpan) }}</template>
        </button>
        <button
            v-if="!pending"
            type="button"
            :class="['rv-link', { busy: page.busy(actionKey.resolve(thread.id)) }]"
            data-action="reopen"
            :disabled="page.acting"
            :aria-busy="page.busy(actionKey.resolve(thread.id))"
            @click="page.resolve(thread, false)"
        >
            {{ t('thread.reopen') }}
        </button>
    </div>
    <div v-else ref="root" :class="['rv-th', { 'file-level': fileLevel }]" :data-thread="thread.id">
        <div class="rv-th-h">
            <span v-if="thread.path == null">
                <I18nText k="thread.generalPostedOn"><template #version><b>v{{ thread.version }}</b></template></I18nText>
            </span>
            <span v-else>
                <I18nText k="thread.postedOn"><template #version><b>v{{ thread.version }}</b></template></I18nText>
                <template v-if="origin"> · {{ spanLabel(tr(), origin) }}<template v-if="origin.old"> {{ t('thread.oldVersion') }}</template></template>
                <template v-if="here"> {{ here.start != null ? t('thread.linesHere', { from: here.start, to: here.end }) : t('thread.lineHere', { line: here.end }) }}</template>
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
        <div v-if="!pending" class="rv-th-f">
            <textarea
                ref="replyBox"
                v-model="reply"
                rows="1"
                :placeholder="t('thread.replyPlaceholder')"
                :aria-label="t('thread.replyLabel')"
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
