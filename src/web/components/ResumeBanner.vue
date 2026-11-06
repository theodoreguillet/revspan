<script setup lang="ts">
import { computed } from 'vue';
import { usePrPage } from '../composables/usePrPage.ts';
import { bannerModel } from '../lib/banner.ts';
import SegText from './SegText.vue';

const page = usePrPage();
const model = computed(() => bannerModel(page.detail, page.sums, !!page.summary));
const tone = computed(() => ({ 'up-to-date': 'ok', fast: 'fast' } as Record<string, string>)[model.value.variant] ?? '');
</script>

<template>
    <section :class="['rv-banner', tone]" :data-banner="model.variant">
        <div>
            <div class="h">{{ model.head }}</div>
            <ul v-if="model.lines.length">
                <li v-for="(line, k) in model.lines" :key="k"><SegText :segs="line" /></li>
            </ul>
        </div>
        <div v-if="model.action !== 'none'" class="acts">
            <button
                v-if="model.action === 'reapprove'"
                type="button"
                class="rv-btn rv-btn-ok"
                data-action="reapprove"
                @click="page.setApproved(true)"
            >
                ✓ Réapprouver v{{ model.latest }}
            </button>
            <button v-else type="button" class="rv-btn" data-action="mark-reviewed" @click="page.markReviewed(model.latest)">
                Marquer v{{ model.latest }} comme relue
            </button>
            <div v-if="model.rule" class="rule">Approuver ou commenter marque la version comme relue automatiquement.</div>
        </div>
    </section>
</template>
