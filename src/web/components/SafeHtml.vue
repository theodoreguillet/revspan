<script setup lang="ts">
// HTML de commentaire Bitbucket (non fiable) : assaini par liste blanche puis ajouté comme fragment DOM, jamais via v-html.
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
