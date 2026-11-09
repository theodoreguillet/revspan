<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { parsePrUrl } from '../../shared/pr-url.ts';
import { t } from '../i18n/index.ts';
import { prRoute } from '../lib/prUrl.ts';

const router = useRouter();
const value = ref('');
const bad = ref(false);

function go(): boolean {
    const target = parsePrUrl(value.value);
    if (!target) {
        bad.value = true;
        return false;
    }
    bad.value = false;
    value.value = '';
    void router.push(prRoute(target));
    return true;
}

function reset(event: KeyboardEvent): void {
    value.value = '';
    bad.value = false;
    (event.target as HTMLInputElement).blur();
}

// collage d'une URL valide : navigation immédiate
function onPaste(): void {
    setTimeout(() => {
        if (parsePrUrl(value.value)) {
            go();
        }
    }, 0);
}
</script>

<template>
    <input
        v-model="value"
        :class="['rv-url', { bad }]"
        type="text"
        spellcheck="false"
        autocomplete="off"
        :placeholder="t('url.placeholder')"
        :aria-label="t('url.label')"
        :title="bad ? t('url.hint') : undefined"
        @keydown.enter.prevent="go()"
        @keydown.esc="reset"
        @input="bad = false"
        @paste="onPaste"
    >
</template>
