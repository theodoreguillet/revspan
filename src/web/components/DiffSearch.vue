<script setup lang="ts">
// Search box at the top of the file list: filters the files by name and marks the matches in the lines shown.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { usePrPage } from '../composables/usePrPage.ts';
import { t } from '../i18n/index.ts';

const page = usePrPage();
const search = page.search;
const box = ref<HTMLInputElement | null>(null);

// empty without a search: the live region stays in the page, so that its first message is read out
const status = computed(() => {
    if (!search.active) {
        return '';
    }
    const total = search.hits.length;
    if (!total) {
        const byName = search.nameMatches.size;
        return byName ? t('search.noneInContent', { count: byName }) : t('search.none');
    }
    return search.current >= 0 ? t('search.position', { cur: search.current + 1, total }) : t('search.count', { count: total });
});

function onEnter(event: KeyboardEvent): void {
    // Enter that validates an IME composition is not a navigation
    if (event.isComposing) {
        return;
    }
    void search.step(event.shiftKey ? -1 : 1);
}

function onEscape(): void {
    search.clear();
    box.value?.blur();
}

// "/" focuses the box from anywhere on the page
onMounted(() => search.registerBox(box.value));
onBeforeUnmount(() => search.registerBox(null));
</script>

<template>
    <div class="rv-search">
        <input
            ref="box"
            v-model="search.input"
            type="search"
            data-search
            spellcheck="false"
            autocomplete="off"
            :placeholder="t('search.placeholder')"
            :aria-label="t('search.label')"
            :title="t('search.title')"
            aria-keyshortcuts="/"
            @keydown.enter.prevent="onEnter"
            @keydown.esc.prevent="onEscape"
        >
        <span class="st" data-search-status aria-live="polite" :title="search.active ? t('search.statusTitle') : undefined">{{ status }}</span>
    </div>
</template>
