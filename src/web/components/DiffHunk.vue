<script setup lang="ts">
// Un hunk en vue unifiée ou côte à côte, avec les fils et le composeur insérés sous leur ligne.
import { computed } from 'vue';
import type { Hunk } from '../../shared/api.ts';
import { usePrPage } from '../composables/usePrPage.ts';
import { t } from '../i18n/index.ts';
import { hunkRange, lineSign, sideBySideRows, unifiedRows, type ComposerTarget, type PlacedThread } from '../lib/diff.ts';
import { isVsCode, openLocalFile } from '../services/host.ts';
import Composer from './Composer.vue';
import DiffCode from './DiffCode.vue';
import ThreadCard from './ThreadCard.vue';

const props = defineProps<{ path: string; hunk: Hunk; byLine: Map<number, PlacedThread[]> }>();
const page = usePrPage();

const input = computed(() => ({ path: props.path, lines: props.hunk.lines, byLine: props.byLine, canComment: page.canInlineComment, composer: page.composer }));
const rows = computed(() => (page.view === 'unified' ? unifiedRows(input.value) : []));
const splitRows = computed(() => (page.view === 'split' ? sideBySideRows(input.value) : []));

const lineClass = (t: string): string => (t === '+' ? 'rv-l a' : t === '-' ? 'rv-l r' : 'rv-l');
const plusTitle = (target: ComposerTarget): string => (target.kind === 'old'
    ? t('diff.commentDeletedLineTitle')
    : t('diff.commentLineTitle', { line: target.line }));
</script>

<template>
    <div class="rv-hunk">{{ hunkRange(hunk) }}<span v-if="hunk.header" class="hh">{{ hunk.header }}</span></div>
    <template v-for="(row, k) in rows" :key="k">
        <div :class="lineClass(row.line.t)" :data-o="row.line.o ?? ''" :data-n="row.line.n ?? ''">
            <span class="n">{{ row.line.o ?? '' }}</span>
            <span class="n">{{ row.line.n ?? '' }}</span>
            <span class="s">{{ lineSign(row.line.t) }}</span>
            <DiffCode :line="row.line" />
            <button
                v-if="isVsCode && row.line.n != null"
                type="button"
                class="rv-open-line"
                tabindex="-1"
                data-action="open-line"
                :title="t('diff.openAtLineTitle', { line: row.line.n })"
                @click="openLocalFile(page.ref, path, row.line.n)"
            >
                {{ t('diff.openAtLine') }}
            </button>
            <button
                v-if="row.target"
                type="button"
                class="rv-plus"
                tabindex="-1"
                data-action="add-comment"
                :title="plusTitle(row.target)"
                @click="page.openComposer(row.target)"
            >
                +
            </button>
        </div>
        <ThreadCard v-for="item in row.threads" :key="item.thread.id" :thread="item.thread" :placement="item.placement" />
        <Composer v-if="row.composer" :target="row.composer" />
    </template>
    <template v-for="(row, k) in splitRows" :key="k">
        <div class="rv-sl">
            <template v-for="cell in row.cells" :key="cell.side">
                <div v-if="!cell.line" class="half e" />
                <div
                    v-else
                    :class="['half', { r: cell.line.t !== ' ' && cell.side === 'old', a: cell.line.t !== ' ' && cell.side === 'new' }]"
                    :data-o="cell.side === 'old' ? cell.line.o ?? '' : undefined"
                    :data-n="cell.side === 'new' ? cell.line.n ?? '' : undefined"
                >
                    <span class="n">{{ (cell.side === 'old' ? cell.line.o : cell.line.n) ?? '' }}</span>
                    <span class="s">{{ cell.line.t !== ' ' ? lineSign(cell.line.t) : '' }}</span>
                    <DiffCode :line="cell.line" />
                    <button
                        v-if="isVsCode && cell.side === 'new' && cell.line.n != null"
                        type="button"
                        class="rv-open-line"
                        tabindex="-1"
                        data-action="open-line"
                        :title="t('diff.openAtLineTitle', { line: cell.line.n })"
                        @click="openLocalFile(page.ref, path, cell.line.n)"
                    >
                        {{ t('diff.openAtLine') }}
                    </button>
                    <button
                        v-if="cell.target"
                        type="button"
                        class="rv-plus"
                        tabindex="-1"
                        data-action="add-comment"
                        :title="plusTitle(cell.target)"
                        @click="page.openComposer(cell.target)"
                    >
                        +
                    </button>
                </div>
            </template>
        </div>
        <div v-if="row.leftComposer" class="rv-split-left"><Composer :target="row.leftComposer" /></div>
        <div v-if="row.threads.length" class="rv-split-right">
            <ThreadCard v-for="item in row.threads" :key="item.thread.id" :thread="item.thread" :placement="item.placement" />
        </div>
        <div v-if="row.rightComposer" class="rv-split-right"><Composer :target="row.rightComposer" /></div>
    </template>
</template>
