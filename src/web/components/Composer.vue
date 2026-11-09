<script setup lang="ts">
// Composeur de commentaire : sur une ligne du diff (target) ou commentaire général (onglet Discussions).
import { computed, onMounted, ref } from 'vue';
import { GENERAL_DRAFT } from '../composables/useDiscussion.ts';
import { usePrPage } from '../composables/usePrPage.ts';
import type { ComposerTarget } from '../lib/diff.ts';
import { vname } from '../lib/format.ts';

const props = withDefaults(defineProps<{ target?: ComposerTarget | null }>(), { target: null });
const page = usePrPage();
const textarea = ref<HTMLTextAreaElement | null>(null);
const sending = ref(false);

const general = computed(() => !props.target);
const key = computed(() => props.target?.key ?? GENERAL_DRAFT);
const text = computed({
    get: () => page.draft(key.value),
    set: (value: string) => page.setDraft(key.value, value),
});
const label = computed(() => {
    const t = props.target;
    const cmp = page.compare;
    if (!t || !cmp) {
        return 'Nouveau commentaire général';
    }
    return t.kind === 'old'
        ? `Ligne ${t.line} supprimée (${vname(cmp.from)} → v${cmp.to}) : publié comme commentaire général qui cite la ligne.`
        : `Ligne ${t.line} de v${cmp.to}`;
});
const placeholder = computed(() => {
    if (general.value) {
        return 'Nouveau commentaire général…';
    }
    return props.target?.kind === 'old' ? 'Ton commentaire sur la ligne supprimée…' : 'Commenter cette ligne…';
});

async function submit(): Promise<void> {
    const value = text.value.trim();
    if (!value || sending.value) {
        return;
    }
    sending.value = true;
    try {
        if (props.target) {
            await page.submitComposer(props.target, value);
        } else {
            await page.postGeneral(value);
        }
    } finally {
        sending.value = false;
    }
}

function onKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        void submit();
    } else if (event.key === 'Escape' && !general.value) {
        event.preventDefault();
        page.closeComposer();
    }
}

onMounted(() => {
    if (!general.value) {
        textarea.value?.focus();
    }
});
</script>

<template>
    <div :class="['rv-comp', { old: target?.kind === 'old' }]" :data-composer="key">
        <div class="q">{{ label }}</div>
        <textarea
            ref="textarea"
            v-model="text"
            :placeholder="placeholder"
            :aria-label="general ? 'Nouveau commentaire général' : 'Nouveau commentaire'"
            :disabled="sending"
            @keydown="onKeydown"
        />
        <div class="row">
            <span class="k">{{ general ? '⌘/Ctrl + Entrée pour envoyer' : '⌘/Ctrl + Entrée pour envoyer · Échap pour annuler' }}</span>
            <button v-if="!general" type="button" class="rv-btn rv-btn-sm" @click="page.closeComposer()">Annuler</button>
            <button
                type="button"
                :class="['rv-btn rv-btn-sm rv-btn-primary', { busy: sending }]"
                :data-action="general ? 'send-general' : 'send-comment'"
                :disabled="!text.trim() || sending || page.acting"
                :aria-busy="sending"
                @click="submit"
            >
                Commenter
            </button>
        </div>
    </div>
</template>
