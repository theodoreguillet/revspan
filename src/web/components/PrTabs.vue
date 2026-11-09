<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { PrTab } from '../composables/useDiffOptions.ts';
import { usePrPage } from '../composables/usePrPage.ts';
import { t } from '../i18n/index.ts';
import { threadGroups } from '../lib/threads.ts';

const page = usePrPage();
const root = ref<HTMLElement | null>(null);
const freshCount = computed(() => threadGroups(page.detail.threads).fresh.length);
const openCount = computed(() => page.detail.threads.filter((t) => !t.resolved).length);
const diffCount = computed(() => (page.compare && !page.compareLoading ? String(page.compare.files.length) : '…'));

function pick(tab: PrTab): void {
    page.tab = tab;
}

// anchor to scroll back to the top of the tabs when the range changes
onMounted(() => page.registerTabs(root.value));
onBeforeUnmount(() => page.registerTabs(null));
</script>

<template>
    <div ref="root" class="rv-tabs" role="tablist">
        <button type="button" role="tab" :class="['rv-tab', { on: page.tab === 'diff' }]" data-tab="diff" :aria-selected="page.tab === 'diff'" @click="pick('diff')">
            {{ t('tabs.diff') }} <span class="n">{{ diffCount }}</span>
        </button>
        <button type="button" role="tab" :class="['rv-tab', { on: page.tab === 'discussions' }]" data-tab="discussions" :aria-selected="page.tab === 'discussions'" @click="pick('discussions')">
            {{ t('tabs.discussions') }}
            <span v-if="freshCount" class="n blue">{{ t('tabs.new', { count: freshCount }) }}</span>
            <span class="n">{{ t('tabs.open', { count: openCount }) }}</span>
        </button>
        <button type="button" role="tab" :class="['rv-tab', { on: page.tab === 'versions' }]" data-tab="versions" :aria-selected="page.tab === 'versions'" @click="pick('versions')">
            {{ t('tabs.versions') }} <span class="n">{{ page.n }}</span>
        </button>
    </div>
</template>
