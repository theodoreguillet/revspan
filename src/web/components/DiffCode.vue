<script setup lang="ts">
import { computed } from 'vue';
import type { DiffLine } from '../../shared/api.ts';
import { t } from '../i18n/index.ts';
import { highlightParts } from '../lib/diff.ts';

const props = defineProps<{ line: DiffLine }>();
const parts = computed(() => highlightParts(props.line.text, props.line.hl));
</script>

<!-- Une seule ligne de gabarit : tout espace ajouté ici apparaîtrait dans le code (white-space: pre-wrap). -->
<template>
    <span class="c"><template v-for="(part, k) in parts" :key="k"><em v-if="part.hl">{{ part.text }}</em><template v-else>{{ part.text }}</template></template><span v-if="line.noEol" class="rv-noeol" :title="t('diff.noEolTitle')" :aria-label="t('diff.noEolTitle')">⏎̸ {{ t('diff.noEol') }}</span></span>
</template>
