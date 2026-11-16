<script setup lang="ts">
// Search box at the top of the file list: filters the files by name and marks the matches in the lines shown.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { usePrPage } from '../composables/usePrPage.ts';
import { t } from '../i18n/index.ts';

const page = usePrPage();
const search = page.search;
const box = ref<HTMLInputElement | null>(null);

const status = computed(() => {
    const total = search.hits.length;
    if (!total) {
        return t('search.none');
    }
    return search.current >= 0 ? t('search.position', { cur: search.current + 1, total }) : t('search.count', { count: total });
});

function onEnter(event: KeyboardEvent): void {
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
            @keydown.enter.prevent="onEnter"
            @keydown.esc.prevent="onEscape"
        >
        <span v-if="search.active" class="st" data-search-status aria-live="polite" :title="t('search.statusTitle')">{{ status }}</span>
    </div>
</template>
