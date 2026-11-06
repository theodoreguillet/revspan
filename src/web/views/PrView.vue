<script setup lang="ts">
// Page PR : premier chargement du détail, puis PrLoaded (qui ne voit jamais de PR absente).
import { onMounted, shallowRef } from 'vue';
import { useRoute } from 'vue-router';
import type { PrDetail, PrRef } from '../../shared/api.ts';
import ErrorPanel from '../components/ErrorPanel.vue';
import PrLoaded from '../components/PrLoaded.vue';
import TopNav from '../components/TopNav.vue';
import { api } from '../services/api.ts';

const route = useRoute();
const prRef: PrRef = { workspace: String(route.params.ws), repo: String(route.params.repo), id: Number(route.params.id) };
const detail = shallowRef<PrDetail | null>(null);
const error = shallowRef<unknown>(null);

document.title = `#${prRef.id} · Strata`;

onMounted(async () => {
    try {
        detail.value = await api.pr(prRef);
    } catch (e) {
        error.value = e;
    }
});
</script>

<template>
    <TopNav :crumbs="[{ text: `${prRef.workspace} / ${prRef.repo}` }, { text: `#${prRef.id}`, cur: true }]" />
    <main class="rv-pr">
        <ErrorPanel v-if="error" :error="error" home-link />
        <PrLoaded v-else-if="detail" :pr-ref="prRef" :detail="detail" />
        <header v-else class="rv-head" aria-busy="true">
            <div class="main skel">
                <div class="rv-skel l1" />
                <div class="rv-skel l2" />
            </div>
        </header>
    </main>
</template>

<style scoped>
.skel { width: 60%; }
.skel .l1 { height: 20px; width: 70%; }
.skel .l2 { height: 12px; width: 45%; margin-top: 8px; }
</style>
