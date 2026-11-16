<script setup lang="ts">
// PR page once the detail is loaded: creates the shared state (providePrPage) and assembles the sections.
import { onBeforeUnmount, onMounted, reactive, watchEffect } from 'vue';
import type { PrDetail, PrRef } from '../../shared/api.ts';
import { useKeyboard } from '../composables/useKeyboard.ts';
import { providePrPage } from '../composables/usePrPage.ts';
import { usePulse } from '../composables/usePulse.ts';
import BuildChecks from './BuildChecks.vue';
import DiffTab from './DiffTab.vue';
import DiscussionsTab from './DiscussionsTab.vue';
import PrHeader from './PrHeader.vue';
import PrTabs from './PrTabs.vue';
import PulseBanner from './PulseBanner.vue';
import ResumeBanner from './ResumeBanner.vue';
import TasksTab from './TasksTab.vue';
import Timeline from './Timeline.vue';
import VersionsTab from './VersionsTab.vue';

const props = defineProps<{ prRef: PrRef; detail: PrDetail }>();
// the initial detail is enough: the page reloads the PR itself after each write
const page = providePrPage(props.prRef, props.detail);
// light check for news on Bitbucket while the page is seen, and the ↻ refresh
const pulse = reactive(usePulse(page));

useKeyboard((key, event) => page.handleKey(key, event));

watchEffect(() => {
    document.title = `#${page.detail.pr.id} ${page.detail.pr.title} · Revspan`;
});

// current file = last file whose header went under the timeline
let raf = 0;
function onScroll(): void {
    if (!raf) {
        raf = requestAnimationFrame(() => {
            raf = 0;
            page.updateCurrentFromScroll();
        });
    }
}
onMounted(() => window.addEventListener('scroll', onScroll, { passive: true }));
onBeforeUnmount(() => {
    window.removeEventListener('scroll', onScroll);
    cancelAnimationFrame(raf);
});
</script>

<template>
    <PrHeader :pulse="pulse" />
    <PulseBanner :pulse="pulse" />
    <Timeline />
    <ResumeBanner />
    <PrTabs />
    <div class="rv-content">
        <DiffTab v-if="page.tab === 'diff'" />
        <DiscussionsTab v-else-if="page.tab === 'discussions'" />
        <VersionsTab v-else-if="page.tab === 'versions'" />
        <TasksTab v-else-if="page.tab === 'tasks'" />
        <BuildChecks v-else />
    </div>
</template>
