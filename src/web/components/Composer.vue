<script setup lang="ts">
// Composeur de commentaire : sur une ligne du diff (target) ou commentaire général (onglet Discussions).
import { computed, onMounted, ref } from 'vue';
import { GENERAL_DRAFT } from '../composables/useDiscussion.ts';
import { usePrPage } from '../composables/usePrPage.ts';
import { t } from '../i18n/index.ts';
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
    const target = props.target;
    const cmp = page.compare;
    if (!target || !cmp) {
        return t('composer.general');
    }
    return target.kind === 'old'
        ? t('composer.deletedLine', { line: target.line, from: vname(cmp.from), to: vname(cmp.to) })
        : t('composer.line', { line: target.line, version: vname(cmp.to) });
});
const placeholder = computed(() => {
    if (general.value) {
        return t('composer.generalPlaceholder');
    }
    return props.target?.kind === 'old' ? t('composer.deletedLinePlaceholder') : t('composer.linePlaceholder');
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
            :aria-label="general ? t('composer.general') : t('composer.label')"
            :disabled="sending"
            @keydown="onKeydown"
        />
        <div class="row">
            <span class="k">{{ general ? t('composer.hintSend') : t('composer.hintSendCancel') }}</span>
            <button v-if="!general" type="button" class="rv-btn rv-btn-sm" @click="page.closeComposer()">{{ t('common.cancel') }}</button>
            <button
                type="button"
                :class="['rv-btn rv-btn-sm rv-btn-primary', { busy: sending }]"
                :data-action="general ? 'send-general' : 'send-comment'"
                :disabled="!text.trim() || sending || page.acting"
                :aria-busy="sending"
                @click="submit"
            >
                {{ t('composer.submit') }}
            </button>
        </div>
    </div>
</template>
