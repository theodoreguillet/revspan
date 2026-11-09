<script setup lang="ts">
// PR page once the detail is loaded: creates the shared state (providePrPage) and assembles the sections.
import { onBeforeUnmount, onMounted, watchEffect } from 'vue';
import type { PrDetail, PrRef } from '../../shared/api.ts';
import { useKeyboard } from '../composables/useKeyboard.ts';
import { providePrPage } from '../composables/usePrPage.ts';
import DiffTab from './DiffTab.vue';
import DiscussionsTab from './DiscussionsTab.vue';
import PrHeader from './PrHeader.vue';
import PrTabs from './PrTabs.vue';
import ResumeBanner from './ResumeBanner.vue';
import Timeline from './Timeline.vue';
import VersionsTab from './VersionsTab.vue';

const props = defineProps<{ prRef: PrRef; detail: PrDetail }>();
// the initial detail is enough: the page reloads the PR itself after each write
const page = providePrPage(props.prRef, props.detail);

useKeyboard((key) => page.handleKey(key));

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
    <PrHeader />
    <Timeline />
    <ResumeBanner />
    <PrTabs />
    <div class="rv-content">
        <DiffTab v-if="page.tab === 'diff'" />
        <DiscussionsTab v-else-if="page.tab === 'discussions'" />
        <VersionsTab v-else />
    </div>
</template>
