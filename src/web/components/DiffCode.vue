<script setup lang="ts">
import { computed } from 'vue';
import type { DiffLine } from '../../shared/api.ts';
import { t } from '../i18n/index.ts';
import { mergeTokens, partStyle, withBands, type CodeToken, type TextMark } from '../lib/highlight.ts';

// tokens: syntax colors of the line (absent: plain text); each change range is one <em> band around its colored tokens.
// marks: search matches of the line; the one starting at `cur` is the current match.
const props = defineProps<{ line: DiffLine; tokens?: readonly CodeToken[]; marks?: readonly [number, number][]; cur?: number }>();
const search = computed((): TextMark[] => (props.marks ?? []).map(([start, end]) => ({ start, end, kind: start === props.cur ? 'cur' : 'hit' })));
const items = computed(() => withBands(mergeTokens(props.line.text, props.tokens ?? [], props.line.hl, search.value)));
</script>

<!-- Single template line: any space added here would show up in the code (white-space: pre-wrap). -->
<template>
    <span class="c"><template v-for="(item, k) in items" :key="k"><em v-if="'band' in item"><template v-for="(part, j) in item.band" :key="j"><mark v-if="part.mark" :class="{ cur: part.mark === 'cur' }" :style="partStyle(part)">{{ part.text }}</mark><span v-else-if="part.color || part.italic || part.bold" :style="partStyle(part)">{{ part.text }}</span><template v-else>{{ part.text }}</template></template></em><mark v-else-if="item.mark" :class="{ cur: item.mark === 'cur' }" :style="partStyle(item)">{{ item.text }}</mark><span v-else-if="item.color || item.italic || item.bold" :style="partStyle(item)">{{ item.text }}</span><template v-else>{{ item.text }}</template></template><span v-if="line.noEol" class="rv-noeol" :title="t('diff.noEolTitle')" :aria-label="t('diff.noEolTitle')">⏎̸ {{ t('diff.noEol') }}</span></span>
</template>
