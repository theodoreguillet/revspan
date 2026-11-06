<script setup lang="ts">
import type { Seg } from '../lib/segments.ts';

defineProps<{ segs: Seg[] }>();

const CLASSES = { mono: 'rv-mono', add: 'a', del: 'd' } as const;
</script>

<template>
    <template v-for="(seg, k) in segs" :key="k">
        <template v-if="typeof seg === 'string'">{{ seg }}</template>
        <b v-else-if="seg.kind === 'b'">{{ seg.text }}</b>
        <span v-else :class="CLASSES[seg.kind]">{{ seg.text }}</span>
    </template>
</template>
