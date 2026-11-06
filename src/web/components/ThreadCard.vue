<script setup lang="ts">
// Fil de discussion : en-tête (version, ligne, état), commentaires, réponse, résolution.
// Dans le diff, un fil résolu est replié en une barre cliquable.
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { Thread, ThreadPlacement } from '../../shared/api.ts';
import { replyDraftKey } from '../composables/useDiscussion.ts';
import { usePrPage } from '../composables/usePrPage.ts';
import { plural } from '../lib/format.ts';
import CommentItem from './CommentItem.vue';

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
            Fil résolu<template v-if="thread.resolvedBy"> par {{ thread.resolvedBy.displayName }}</template>
            · {{ plural(thread.comments.length, 'commentaire') }}<template v-if="thread.anchor?.to"> · ligne {{ placement?.line ?? thread.anchor.to }}</template>
        </button>
    </div>
    <div v-else ref="root" :class="['rv-th', { 'file-level': fileLevel }]" :data-thread="thread.id">
        <div class="rv-th-h">
            <span v-if="thread.path == null">Commentaire général · posté sur <b>v{{ thread.version }}</b></span>
            <span v-else>
                Posté sur <b>v{{ thread.version }}</b>
                <template v-if="origin != null"> · ligne {{ origin }}<template v-if="fromOnly"> (ancienne version)</template></template>
                <template v-if="placement?.line != null && placement.line !== origin"> (ligne {{ placement.line }} ici)</template>
                <template v-if="placement?.moved"> · <span class="rv-moved" title="La ligne commentée a changé depuis le commentaire">ligne modifiée depuis</span></template>
                <template v-if="fileLevel && placement?.outOfHunks"> · hors des zones affichées</template>
                <template v-else-if="fileLevel && placement && placement.line == null"> · niveau fichier</template>
            </span>
            <span v-if="thread.resolved">
                <span class="st res">Résolu<template v-if="thread.resolvedBy"> par {{ thread.resolvedBy.displayName }}</template></span>
                <template v-if="context === 'diff'"> · <button type="button" class="rv-link" @click="page.toggleThreadExpanded(thread.id)">Replier</button></template>
            </span>
            <span v-else><span class="st open">Ouvert</span></span>
        </div>
        <CommentItem v-for="c in thread.comments" :key="c.id" :comment="c" @reply="focusReply" />
        <div class="rv-th-f">
            <textarea
                ref="replyBox"
                v-model="reply"
                rows="1"
                placeholder="Répondre…"
                aria-label="Répondre au fil"
                :disabled="sending"
                @input="autosize"
                @keydown="onReplyKeydown"
            />
            <button type="button" class="rv-btn rv-btn-sm rv-btn-primary" data-action="send-reply" :disabled="!reply.trim() || sending" @click="sendReply">Répondre</button>
            <button v-if="thread.resolved" type="button" class="rv-btn rv-btn-sm" data-action="reopen" @click="page.resolve(thread, false)">Rouvrir</button>
            <button v-else type="button" class="rv-btn rv-btn-sm" data-action="resolve" @click="page.resolve(thread, true)">✓ Résoudre</button>
        </div>
    </div>
</template>
