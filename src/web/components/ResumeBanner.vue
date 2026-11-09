<script setup lang="ts">
import { computed } from 'vue';
import { usePrPage } from '../composables/usePrPage.ts';
import { t, tr } from '../i18n/index.ts';
import { bannerModel } from '../lib/banner.ts';
import { ACTION_KEYS } from '../composables/useReviewActions.ts';
import SegText from './SegText.vue';

const page = usePrPage();
const model = computed(() => bannerModel(tr(), page.detail, page.sums, !!page.summary));
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
                :class="['rv-btn rv-btn-ok', { busy: page.busy(ACTION_KEYS.approve) }]"
                data-action="reapprove"
                :disabled="page.acting"
                :aria-busy="page.busy(ACTION_KEYS.approve)"
                @click="page.setApproved(true)"
            >
                {{ t('pr.reapprove', { version: model.latest }) }}
            </button>
            <button
                v-else
                type="button"
                :class="['rv-btn', { busy: page.busy(ACTION_KEYS.markReviewed) }]"
                data-action="mark-reviewed"
                :disabled="page.acting"
                :aria-busy="page.busy(ACTION_KEYS.markReviewed)"
                @click="page.markReviewed(model.latest)"
            >
                {{ t('banner.markReviewed', { version: model.latest }) }}
            </button>
            <div v-if="model.rule" class="rule">{{ t('banner.rule') }}</div>
        </div>
    </section>
</template>
