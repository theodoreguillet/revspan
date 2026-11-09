<script setup lang="ts">
// Page PR une fois le détail chargé : crée l'état partagé (providePrPage) et assemble les sections.
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
// le détail initial suffit : la page recharge elle-même la PR après chaque écriture
const page = providePrPage(props.prRef, props.detail);

useKeyboard((key) => page.handleKey(key));

watchEffect(() => {
    document.title = `#${page.detail.pr.id} ${page.detail.pr.title} · Revspan`;
});

// fichier courant = dernier fichier dont l'en-tête est passé sous la frise
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
