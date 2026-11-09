<script setup lang="ts">
import { computed } from 'vue';
import type { Version } from '../../shared/api.ts';
import { usePrPage } from '../composables/usePrPage.ts';
import { MINUS } from '../lib/format.ts';
import { isMuted } from '../lib/kinds.ts';
import { nodeDelta, nodeTooltip } from '../lib/timeline.ts';

const props = defineProps<{ version: Version }>();
const page = usePrPage();

const i = computed(() => props.version.index);
const lastReviewed = computed(() => page.detail.review.lastReviewed);
const sum = computed(() => page.sums.get(i.value));
const delta = computed(() => nodeDelta(sum.value));
const inRange = computed(() => i.value > page.from && i.value <= page.to);
const classes = computed(() => ['rv-v', {
    reb: props.version.isRebase,
    nocode: isMuted(sum.value),
    gone: !props.version.available,
    new: lastReviewed.value == null || i.value > lastReviewed.value,
    from: i.value === page.from,
    to: i.value === page.to,
    in: i.value > page.from && i.value < page.to,
}]);
const title = computed(() => nodeTooltip(props.version, sum.value, { lastReviewed: lastReviewed.value, n: page.n }));
</script>

<template>
    <button
        type="button"
        :class="classes"
        :data-i="i"
        :title="title"
        :aria-label="version.available ? `Version ${i}` : `Version ${i} indisponible`"
        :aria-pressed="inRange"
        :aria-disabled="!version.available"
        @click="page.clickVersion(i, $event.shiftKey)"
    >
        <span class="tag de">de</span>
        <span class="tag a">à</span>
        <span class="rv-dot" />
        <span class="rv-vl">v{{ i }}</span>
        <span v-if="delta.code" class="rv-dl code"><span class="a">+{{ delta.added }}</span> <span class="d">{{ MINUS }}{{ delta.removed }}</span></span>
        <span v-else class="rv-dl muted">{{ delta.text }}</span>
    </button>
</template>
