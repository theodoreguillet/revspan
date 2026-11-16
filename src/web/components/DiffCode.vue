<script setup lang="ts">
import { computed } from 'vue';
import type { DiffLine } from '../../shared/api.ts';
import { t } from '../i18n/index.ts';
import { mergeTokens, partStyle, type CodeToken } from '../lib/highlight.ts';

// tokens: syntax colors of the line (absent: plain text); the change emphasis <em> stays on top of them
const props = defineProps<{ line: DiffLine; tokens?: readonly CodeToken[] }>();
const parts = computed(() => mergeTokens(props.line.text, props.tokens ?? [], props.line.hl));
</script>

<!-- Single template line: any space added here would show up in the code (white-space: pre-wrap). -->
<template>
    <span class="c"><template v-for="(part, k) in parts" :key="k"><em v-if="part.hl" :style="partStyle(part)">{{ part.text }}</em><span v-else-if="part.color || part.italic || part.bold" :style="partStyle(part)">{{ part.text }}</span><template v-else>{{ part.text }}</template></template><span v-if="line.noEol" class="rv-noeol" :title="t('diff.noEolTitle')" :aria-label="t('diff.noEolTitle')">⏎̸ {{ t('diff.noEol') }}</span></span>
</template>
