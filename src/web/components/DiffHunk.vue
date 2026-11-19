<script setup lang="ts">
// A hunk in unified or side-by-side view, with the threads and composer inserted under their line.
// Its rows are grouped in blocks: the browser skips the blocks off screen (content-visibility), and a block renders
// again only when something it shows changes (v-memo). A block off screen shows no search marks: typing a query only
// renders the blocks on screen again, the others get their marks when they come into view. A large file gives each hunk
// a `limit`: the blocks past it keep their height but stay empty until the next frames, except those holding a thread,
// the composer, the current match or the line reached by go to definition.
import { computed, reactive, ref } from 'vue';
import type { DiffLine, Hunk } from '../../shared/api.ts';
import type { JumpTarget } from '../composables/useGotoDefinition.ts';
import { useHunkTokens } from '../composables/useHunkTokens.ts';
import { usePrPage } from '../composables/usePrPage.ts';
import { locale, t } from '../i18n/index.ts';
import {
    LINE_PX, currentMatchKey, hunkRange, lineSign, rowBlocks, sideBySideRows, unifiedRows, viewportDistance,
    type ComposerTarget, type PlacedThread, type RowBlock,
} from '../lib/diff.ts';
import { familyOf } from '../lib/goto-definition.ts';
import { languageOf, lineTokens } from '../lib/highlight.ts';
import { lineMarks, NO_HITS, type SearchHit } from '../lib/search.ts';
import { isVsCode, openLocalFile } from '../services/host.ts';
import Composer from './Composer.vue';
import DiffCode from './DiffCode.vue';
import ThreadCard from './ThreadCard.vue';

/**
 * hits: search matches of this hunk (ordered); curLine / curStart: current match in this hunk (index in hunk.lines and
 * start), -1 if it is elsewhere. limit: lines of the hunk to render now (rows past it wait for the next frames).
 * jump: line of this hunk to reach by go to definition (index in hunk.lines, side), null if it is elsewhere.
 */
const props = defineProps<{
    path: string; view: 'unified' | 'split'; hunk: Hunk; byLine: Map<number, PlacedThread[]>; near: boolean;
    fileIdx: number; hunkIdx: number; hits: readonly SearchHit[]; curLine: number; curStart: number; limit: number;
    jump: Pick<JumpTarget, 'index' | 'side' | 'seq'> | null;
}>();
const page = usePrPage();
/** The browser tells when it starts or stops skipping a block (content-visibility: auto). */
const REPORTS_SKIPPED = typeof window !== 'undefined' && 'ContentVisibilityAutoStateChangeEvent' in window;

const input = computed(() => ({ path: props.path, lines: props.hunk.lines, byLine: props.byLine, canComment: page.canInlineComment, composer: page.composer }));
const rows = computed(() => (props.view === 'unified' ? unifiedRows(input.value) : []));
const splitRows = computed(() => (props.view === 'split' ? sideBySideRows(input.value) : []));

// syntax colors arrive after the first render; a side-by-side cell finds its tokens and matches by its index in the hunk
const lang = computed(() => languageOf(props.path));
const family = computed(() => familyOf(props.path));
const head = ref<HTMLElement | null>(null);
/** The hunks on screen are colored first (its rows are estimated from the header: they may not be rendered yet). */
const distance = (): number => (head.value?.isConnected
    ? viewportDistance(head.value.getBoundingClientRect().top, props.hunk.lines.length * LINE_PX, window.innerHeight)
    : Infinity);
const tokens = useHunkTokens(() => props.hunk, () => lang.value, () => props.near, distance);
const lineIndex = computed(() => ((tokens.value || props.hits.length || props.jump) && props.view === 'split' ? new Map(props.hunk.lines.map((line, k) => [line, k])) : null));
const indexOf = (line: DiffLine): number => lineIndex.value?.get(line) ?? -1;
const splitTokens = (line: DiffLine, side: 'old' | 'new') => lineTokens(tokens.value, indexOf(line), side);

// search: lines without a match get the same empty array, so that they do not render again on each keystroke
const marksAt = (k: number, hits = props.hits) => lineMarks(hits, props.fileIdx, props.hunkIdx, k);
const curAt = (k: number): number => (k === props.curLine ? props.curStart : -1);
/** The line of the current match, and the line reached by go to definition, register themselves to be scrolled into view. */
const matchRef = (el: unknown): void => page.registerMatch(el);
const jumpRef = (el: unknown): void => page.registerJump(el);
const bothRef = (el: unknown): void => {
    matchRef(el);
    jumpRef(el);
};
const lineRef = (match: boolean, jumpHere: boolean) => (match ? (jumpHere ? bothRef : matchRef) : jumpHere ? jumpRef : undefined);
/** The cell of the jump line (side by side, a context line shows on both sides: the jump's side). */
const isJump = (line: DiffLine, side: 'old' | 'new'): boolean => !!props.jump && side === props.jump.side && indexOf(line) === props.jump.index;

// blocks of rows
const blocks = computed(() => rowBlocks(props.view === 'unified' ? rows.value.length : splitRows.value.length));
/** Row of the current match (side by side: the row holding its line), -1 if it is elsewhere. */
const curRow = computed(() => {
    if (props.curLine < 0 || props.view === 'unified') {
        return props.curLine;
    }
    const line = props.hunk.lines[props.curLine];
    return splitRows.value.findIndex((row) => row.cells.some((cell) => cell.line === line));
});
/** Rows that must exist at once: threads (n/p, "View in diff") and the composer. */
const pinnedRows = computed(() => (props.view === 'unified'
    ? rows.value.flatMap((row, k) => (row.threads.length || row.composer ? [k] : []))
    : splitRows.value.flatMap((row, k) => (row.threads.length || row.leftComposer || row.rightComposer ? [k] : []))));
/** Row of the go-to-definition line, -1 if it is elsewhere. */
const jumpRow = computed(() => {
    const jump = props.jump;
    if (!jump || props.view === 'unified') {
        return jump ? jump.index : -1;
    }
    const line = props.hunk.lines[jump.index];
    return splitRows.value.findIndex((row) => row.cells.some((cell) => cell.line === line && cell.side === jump.side));
});
const inBlock = (block: RowBlock, row: number): boolean => row >= block.start && row < block.end;
/**
 * Blocks on screen, by first row, as the browser reports them (it skips the others). Without that report (older
 * browser), every block counts as on screen.
 */
const onScreen = reactive(new Set<number>());
const onBlockState = (block: RowBlock, event: Event): void => {
    if ((event as ContentVisibilityAutoStateChangeEvent).skipped) {
        onScreen.delete(block.start);
    } else {
        onScreen.add(block.start);
    }
};
/** Search matches a block shows: none while it is off screen. */
const blockHits = (block: RowBlock): readonly SearchHit[] => (!REPORTS_SKIPPED || onScreen.has(block.start) ? props.hits : NO_HITS);
/**
 * A block renders its rows once the file's progressive rendering reaches it, or at once when it holds a thread, the
 * composer, the current match or the go-to-definition line, or comes on screen (a jump deep into a large file still
 * filling).
 */
const rendered = (block: RowBlock): boolean => block.start < props.limit || onScreen.has(block.start) || inBlock(block, curRow.value)
    || inBlock(block, jumpRow.value) || pinnedRows.value.some((k) => inBlock(block, k));
/** The current match, for the block that holds it only (the other blocks do not render again when it moves). */
const curIn = (block: RowBlock): string => currentMatchKey(block, curRow.value, props.curLine, props.curStart);
/** Each jump renders the block holding its line again (it registers the line), and only that block. */
const jumpIn = (block: RowBlock): number => (props.jump && inBlock(block, jumpRow.value) ? props.jump.seq : 0);
/** An empty block keeps the height of its rows; a rendered one gives it as its size while skipped off screen. */
const blockStyle = (block: RowBlock): Record<string, string> => {
    const height = `${(block.end - block.start) * LINE_PX}px`;
    return rendered(block) ? { containIntrinsicSize: `auto ${height}` } : { height };
};
const unifiedIn = (block: RowBlock) => rows.value.slice(block.start, block.end).map((row, i) => ({ row, k: block.start + i }));
const splitIn = (block: RowBlock) => splitRows.value.slice(block.start, block.end).map((row, i) => ({ row, k: block.start + i }));

const lineClass = (t: string): string => (t === '+' ? 'rv-l a' : t === '-' ? 'rv-l r' : 'rv-l');
const plusTitle = (target: ComposerTarget): string => (target.kind === 'old'
    ? t('diff.commentDeletedLineTitle')
    : t('diff.commentLineTitle', { line: target.line }));
</script>

<template>
    <div ref="head" class="rv-hunk">{{ hunkRange(hunk) }}<span v-if="hunk.header" class="hh">{{ hunk.header }}</span></div>
    <template v-if="view === 'unified'">
        <div
            v-for="block in blocks"
            :key="block.start"
            v-memo="[rendered(block), rows, tokens, blockHits(block), curIn(block), jumpIn(block), locale]"
            class="rv-blk"
            :style="blockStyle(block)"
            @contentvisibilityautostatechange="onBlockState(block, $event)"
        >
            <template v-if="rendered(block)">
                <template v-for="{ row, k } in unifiedIn(block)" :key="k">
                    <div :ref="lineRef(k === curLine, k === jump?.index)" :class="lineClass(row.line.t)" :data-o="row.line.o ?? ''" :data-n="row.line.n ?? ''">
                        <span class="n">{{ row.line.o ?? '' }}</span>
                        <span class="n">{{ row.line.n ?? '' }}</span>
                        <span class="s">{{ lineSign(row.line.t) }}</span>
                        <DiffCode :line="row.line" :tokens="lineTokens(tokens, k, row.line.t === '-' ? 'old' : 'new')" :marks="marksAt(k, blockHits(block))" :cur="curAt(k)" :family="family" />
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
            </template>
        </div>
    </template>
    <template v-else>
        <div
            v-for="block in blocks"
            :key="block.start"
            v-memo="[rendered(block), splitRows, tokens, blockHits(block), curIn(block), jumpIn(block), locale]"
            class="rv-blk"
            :style="blockStyle(block)"
            @contentvisibilityautostatechange="onBlockState(block, $event)"
        >
            <template v-if="rendered(block)">
                <template v-for="{ row, k } in splitIn(block)" :key="k">
                    <div class="rv-sl">
                        <template v-for="cell in row.cells" :key="cell.side">
                            <div v-if="!cell.line" class="half e" />
                            <div
                                v-else
                                :ref="lineRef(curLine >= 0 && indexOf(cell.line) === curLine, isJump(cell.line, cell.side))"
                                :class="['half', { r: cell.line.t !== ' ' && cell.side === 'old', a: cell.line.t !== ' ' && cell.side === 'new' }]"
                                :data-o="cell.side === 'old' ? cell.line.o ?? '' : undefined"
                                :data-n="cell.side === 'new' ? cell.line.n ?? '' : undefined"
                            >
                                <span class="n">{{ (cell.side === 'old' ? cell.line.o : cell.line.n) ?? '' }}</span>
                                <span class="s">{{ cell.line.t !== ' ' ? lineSign(cell.line.t) : '' }}</span>
                                <DiffCode :line="cell.line" :tokens="splitTokens(cell.line, cell.side)" :marks="marksAt(indexOf(cell.line), blockHits(block))" :cur="curAt(indexOf(cell.line))" :family="family" />
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
        </div>
    </template>
</template>
