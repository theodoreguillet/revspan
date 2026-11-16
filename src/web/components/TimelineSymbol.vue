<script setup lang="ts">
// The dot of a version: C = commit (code push), R = rebase. Shared by the timeline nodes and the legend.
defineProps<{ rebase?: boolean; gone?: boolean }>();
</script>

<template>
    <span :class="['rv-dot', { reb: rebase, gone }]"><i aria-hidden="true">{{ rebase ? 'R' : 'C' }}</i></span>
</template>
