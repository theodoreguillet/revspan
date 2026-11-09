<script setup lang="ts">
// Bitbucket comment HTML (untrusted): sanitized with an allowlist then added as a DOM fragment, never through v-html.
import { onMounted, ref, watch } from 'vue';
import { sanitizeHtml } from '../lib/sanitize.ts';

const props = defineProps<{ html: string }>();
const root = ref<HTMLElement | null>(null);

function render(): void {
    root.value?.replaceChildren(sanitizeHtml(props.html));
}

onMounted(render);
watch(() => props.html, render);
</script>

<template>
    <div ref="root" class="rv-html" />
</template>
