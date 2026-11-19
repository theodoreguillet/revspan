// Diff rules: seen files, side-by-side pairs, thread placement, comments on deleted lines.
import type { DiffLine, FileDiff, Hunk, Thread, ThreadPlacement } from '../../shared/api.ts';
import type { MessageKey, Translator } from '../i18n/index.ts';
import { MINUS, vname } from './format.ts';
import type { SummaryMap } from './kinds.ts';

export type ViewedStatus = 'none' | 'seen' | 'changed';

/** none: never seen; seen: seen with this content; changed: seen, but the content changed since. */
export function viewedStatus(file: Pick<FileDiff, 'path' | 'contentHash'>, viewed: Record<string, string> | undefined): ViewedStatus {
    const stored = viewed?.[file.path];
    if (stored == null) {
        return 'none';
    }
    return stored === file.contentHash ? 'seen' : 'changed';
}

/**
 * Index of the file "v" moves to after marking `current` seen: the first unseen one after it, else the first unseen
 * before it, else null. The current file counts as seen (it was just marked).
 */
export function nextUnseenIndex(files: readonly { seen: boolean }[], current: number): number | null {
    const after = files.findIndex((file, idx) => idx > current && !file.seen);
    if (after !== -1) {
        return after;
    }
    const before = files.findIndex((file, idx) => idx < current && !file.seen);
    return before === -1 ? null : before;
}

/** Latest version of the range (from, to] that modified this file, according to the summary. */
export function lastTouched(sums: SummaryMap, from: number, to: number, path: string): number | null {
    for (let i = to; i >= from + 1; i--) {
        if (sums.get(i)?.files.some((f) => f.path === path)) {
            return i;
        }
    }
    return null;
}

export interface SplitRow {
    left: DiffLine | null;
    right: DiffLine | null;
}

/**
 * Left/right rows of a hunk. In a - then + run, a removed line and the added line it was compared with (`pair`, from
 * the server) share a row; the unpaired lines between two pairs line up by position, as do whole runs without `pair`.
 */
export function splitRows(lines: DiffLine[]): SplitRow[] {
    const rows: SplitRow[] = [];
    let dels: DiffLine[] = [];
    let adds: DiffLine[] = [];
    const zip = (left: readonly DiffLine[], right: readonly DiffLine[]): void => {
        for (let k = 0; k < Math.max(left.length, right.length); k++) {
            rows.push({ left: left[k] ?? null, right: right[k] ?? null });
        }
    };
    const flush = (): void => {
        const indexOf = new Map(adds.map((add, k) => [add.n, k]));
        let next = 0;
        let unpaired: DiffLine[] = [];
        for (const del of dels) {
            const j = del.pair === undefined ? undefined : indexOf.get(del.pair);
            // pairings never cross: one that would go back is ignored
            if (j === undefined || j < next) {
                unpaired.push(del);
                continue;
            }
            zip(unpaired, adds.slice(next, j));
            rows.push({ left: del, right: adds[j]! });
            unpaired = [];
            next = j + 1;
        }
        zip(unpaired, adds.slice(next));
        dels = [];
        adds = [];
    };
    for (const line of lines) {
        if (line.t === ' ') {
            flush();
            rows.push({ left: line, right: line });
        } else if (line.t === '-') {
            if (adds.length) {
                flush();
            }
            dels.push(line);
        } else {
            adds.push(line);
        }
    }
    flush();
    return rows;
}

export function hunkRange(h: Pick<Hunk, 'oldStart' | 'oldLines' | 'newStart' | 'newLines'>): string {
    return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
}

export function lineSign(t: DiffLine['t']): string {
    if (t === '+') {
        return '+';
    }
    return t === '-' ? MINUS : '';
}

export interface TextPart {
    text: string;
    hl: boolean;
}

/** Splits a line's text according to the [start, end[ ranges to highlight. */
export function highlightParts(text: string, ranges: readonly [number, number][] | undefined): TextPart[] {
    if (!ranges?.length) {
        return [{ text, hl: false }];
    }
    const out: TextPart[] = [];
    let pos = 0;
    for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
        const s = Math.max(pos, Math.min(start, text.length));
        const e = Math.max(s, Math.min(end, text.length));
        if (s > pos) {
            out.push({ text: text.slice(pos, s), hl: false });
        }
        if (e > s) {
            out.push({ text: text.slice(s, e), hl: true });
        }
        pos = e;
    }
    if (pos < text.length) {
        out.push({ text: text.slice(pos), hl: false });
    }
    return out;
}

export interface PlacedThread {
    placement: ThreadPlacement;
    thread: Thread;
}

export interface FileThreads {
    /** Threads without a displayed line: file level, line outside the hunks. */
    fileLevel: PlacedThread[];
    /** Inline threads, by line number on the "to" side. */
    byLine: Map<number, PlacedThread[]>;
}

/** Distributes a file's threads between the file head and the displayed lines. Resolved threads are omitted unless requested. */
export function placeFileThreads(file: FileDiff, threadsById: Map<number, Thread>, showResolved: boolean): FileThreads {
    const lineSet = new Set<number>();
    for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
            if (line.n != null && line.t !== '-') {
                lineSet.add(line.n);
            }
        }
    }
    const fileLevel: PlacedThread[] = [];
    const byLine = new Map<number, PlacedThread[]>();
    for (const placement of file.threads) {
        const thread = threadsById.get(placement.threadId);
        if (!thread || (thread.resolved && !showResolved)) {
            continue;
        }
        if (placement.line == null || !lineSet.has(placement.line)) {
            fileLevel.push({ placement, thread });
        } else {
            const list = byLine.get(placement.line) ?? [];
            list.push({ placement, thread });
            byLine.set(placement.line, list);
        }
    }
    return { fileLevel, byLine };
}

/** Number of threads of a file (open ones only, unless resolved ones are shown). */
export function fileThreadCount(file: FileDiff, threadsById: Map<number, Thread>, includeResolved: boolean): number {
    return file.threads.filter((p) => {
        const t = threadsById.get(p.threadId);
        return !!t && (!t.resolved || includeResolved);
    }).length;
}

export type ComposerKind = 'new' | 'old';

export interface ComposerTarget {
    /** Draft and composer key: that of the (last) line, so a range keeps the text typed under its last line. */
    key: string;
    path: string;
    kind: ComposerKind;
    /** Line number on the new (new) or old (old) side; a range's last line. */
    line: number;
    code: string;
    /** New side only: first line of a range of lines (before `line`); absent for a single line. */
    startLine?: number;
}

/**
 * Target of the "+" on a line: on the new side, an inline comment; on a deleted line, a general comment
 * quoting it. `side`: column of the side-by-side view, or 'both' in the unified view.
 */
export function composerTargetFor(path: string, line: DiffLine, side: 'old' | 'new' | 'both'): ComposerTarget | null {
    if (side !== 'old' && line.t !== '-' && line.n != null) {
        return { key: composerKey('new', line.n, path), path, kind: 'new', line: line.n, code: line.text };
    }
    if (side !== 'new' && line.t === '-' && line.o != null) {
        return { key: composerKey('old', line.o, path), path, kind: 'old', line: line.o, code: line.text };
    }
    return null;
}

/**
 * Range from the line of `anchor` to that of `other` (Shift+click on a second "+"): both new-side lines of the same file.
 * The target of the later line, starting at the earlier one; the line alone when both are the same; null otherwise. An
 * anchor that is itself a range counts by its own line (its last one).
 */
export function rangeTarget(anchor: ComposerTarget, other: ComposerTarget): ComposerTarget | null {
    if (anchor.kind !== 'new' || other.kind !== 'new' || anchor.path !== other.path) {
        return null;
    }
    const later = other.line >= anchor.line ? other : anchor;
    const last: ComposerTarget = { key: later.key, path: later.path, kind: later.kind, line: later.line, code: later.code };
    const first = Math.min(anchor.line, other.line);
    return first < last.line ? { ...last, startLine: first } : last;
}

const sameTarget = (a: ComposerTarget | null, b: ComposerTarget | null): boolean => !!a && !!b && a.key === b.key;

/** Ranges of lines [first, last] on the new side: those of the shown range threads, and the composer's. */
type LineRanges = readonly (readonly [number, number])[];

function threadRanges(byLine: Map<number, PlacedThread[]>): LineRanges {
    const ranges: [number, number][] = [];
    for (const list of byLine.values()) {
        for (const { placement } of list) {
            if (placement.startLine != null && placement.line != null) {
                ranges.push([placement.startLine, placement.line]);
            }
        }
    }
    return ranges;
}

const composerRange = (composer: ComposerTarget | null, path: string): LineRanges =>
    (composer?.kind === 'new' && composer.path === path && composer.startLine != null ? [[composer.startLine, composer.line]] : []);

/** The new-side line `line` is in one of the ranges (a removed line never is). */
const inRanges = (ranges: LineRanges, line: DiffLine | null): boolean =>
    ranges.length > 0 && !!line && line.t !== '-' && line.n != null && ranges.some(([first, last]) => line.n! >= first && line.n! <= last);

export interface LineView {
    line: DiffLine;
    /** Target of the "+" button (null: no comment possible on this line). */
    target: ComposerTarget | null;
    /** Composer open under this line. */
    composer: ComposerTarget | null;
    threads: PlacedThread[];
    /** In the range of lines of a shown thread or of the open composer (new-side lines only). */
    inRange: boolean;
    /** In the range of lines of the open composer. */
    composing: boolean;
}

export interface SplitCellView {
    side: 'old' | 'new';
    line: DiffLine | null;
    target: ComposerTarget | null;
    /** New-side cell in a range of lines (see LineView). */
    inRange: boolean;
    composing: boolean;
}

export interface SplitRowView {
    cells: [SplitCellView, SplitCellView];
    /** Composer open under the deleted line (left) or under the new-side line (right). */
    leftComposer: ComposerTarget | null;
    rightComposer: ComposerTarget | null;
    threads: PlacedThread[];
}

export interface HunkViewInput {
    path: string;
    lines: DiffLine[];
    byLine: Map<number, PlacedThread[]>;
    canComment: boolean;
    composer: ComposerTarget | null;
}

const threadsAt = (byLine: Map<number, PlacedThread[]>, line: DiffLine | null): PlacedThread[] =>
    (line && line.t !== '-' && line.n != null ? byLine.get(line.n) ?? [] : []);

/** View of a file: an added or removed file has one empty side, so it is always unified. */
export function fileView(file: Pick<FileDiff, 'status'>, view: 'unified' | 'split'): 'unified' | 'split' {
    return file.status === 'added' || file.status === 'removed' ? 'unified' : view;
}

/** Lines of a hunk in unified view, with threads and composer to insert below. */
export function unifiedRows({ path, lines, byLine, canComment, composer }: HunkViewInput): LineView[] {
    const composing = composerRange(composer, path);
    const ranges = [...threadRanges(byLine), ...composing];
    return lines.map((line) => {
        const target = canComment ? composerTargetFor(path, line, 'both') : null;
        return {
            line, target, composer: sameTarget(target, composer) ? composer : null, threads: threadsAt(byLine, line),
            inRange: inRanges(ranges, line), composing: inRanges(composing, line),
        };
    });
}

/** Lines of a hunk in side-by-side view (old on the left, new on the right). */
export function sideBySideRows({ path, lines, byLine, canComment, composer }: HunkViewInput): SplitRowView[] {
    const composing = composerRange(composer, path);
    const ranges = [...threadRanges(byLine), ...composing];
    const cell = (side: 'old' | 'new', line: DiffLine | null): SplitCellView => ({
        side, line, target: line && canComment ? composerTargetFor(path, line, side) : null,
        inRange: side === 'new' && inRanges(ranges, line), composing: side === 'new' && inRanges(composing, line),
    });
    return splitRows(lines).map(({ left, right }) => {
        const cells: [SplitCellView, SplitCellView] = [cell('old', left), cell('new', right)];
        return {
            cells,
            leftComposer: sameTarget(cells[0].target, composer) ? composer : null,
            rightComposer: sameTarget(cells[1].target, composer) ? composer : null,
            threads: threadsAt(byLine, right),
        };
    });
}

export function composerKey(kind: ComposerKind, line: number, path: string): string {
    return `${kind === 'old' ? 'o' : 'n'}${line}:${path}`;
}

/** General comment quoting a deleted line (Bitbucket cannot anchor on the old side). */
export function deletedLineComment(tr: Translator, path: string, from: number, to: number, code: string, text: string): string {
    const fence = code.includes('```') ? '~~~' : '```';
    const quote = tr.t('diff.deletedLineQuote', { path: `\`${path}\``, from: vname(from), to: vname(to) });
    return `${quote}\n${fence}\n${code}\n${fence}\n${text}`;
}

/** Heights of a diff line and of a hunk header (px, see app.css .rv-l and .rv-hunk). */
export const LINE_PX = 20;
const HUNK_HEADER_PX = 21;

/**
 * Estimated height of a file's lines (px): the size of its block while the browser skips it off screen
 * (content-visibility), until it has been rendered once.
 */
export function estimatedLinesHeight(file: Pick<FileDiff, 'hunks'>): number {
    return file.hunks.reduce((sum, hunk) => sum + HUNK_HEADER_PX + hunk.lines.length * LINE_PX, 0);
}

/** Rows of a hunk grouped in blocks: the browser skips the blocks off screen, a large file renders block by block. */
export const ROW_BLOCK = 50;

export interface RowBlock {
    /** Index of the block's first row, and the row after its last one. */
    start: number;
    end: number;
}

/** Blocks of ROW_BLOCK rows covering `count` rows. */
export function rowBlocks(count: number): RowBlock[] {
    const out: RowBlock[] = [];
    for (let start = 0; start < count; start += ROW_BLOCK) {
        out.push({ start, end: Math.min(start + ROW_BLOCK, count) });
    }
    return out;
}

/**
 * Memo key of the current search match for a block: its line and start when the block holds its row, '' otherwise.
 * The line, not the row: side by side, a removed line and the added one paired with it share a row.
 */
export function currentMatchKey(block: RowBlock, curRow: number, curLine: number, curStart: number): string {
    return curRow >= block.start && curRow < block.end ? `${curLine}:${curStart}` : '';
}

/** Distance (px) between a box from `top` to `top + height` and the window [0, viewport]: 0 when part of it shows. */
export function viewportDistance(top: number, height: number, viewport: number): number {
    if (top + height < 0) {
        return -(top + height);
    }
    return top > viewport ? top - viewport : 0;
}

/**
 * Progressive rendering: a file on screen above PROGRESSIVE_LINES lines shows its FIRST_ROWS first lines at once; the
 * rest of it, and the whole of a file off screen when its content changes, come ROWS_PER_FRAME lines per frame, shared
 * by all the files (the closest to the window first).
 */
export const PROGRESSIVE_LINES = 400;
const FIRST_ROWS = 100;
export const ROWS_PER_FRAME = 250;

/** Lines of a file rendered at once (Infinity: all of them). */
export function initialRowBudget(totalLines: number, onScreen: boolean): number {
    if (!onScreen) {
        return totalLines ? 0 : Infinity;
    }
    return totalLines > PROGRESSIVE_LINES ? FIRST_ROWS : Infinity;
}

/** Lines rendered once `rows` more are given (Infinity once the file is complete). */
export function nextRowBudget(budget: number, rows: number, totalLines: number): number {
    const next = budget + rows;
    return next >= totalLines ? Infinity : next;
}

/** Lines of each hunk within the file's budget (from 0 to all its lines): the hunks already complete keep their value. */
export function hunkRowLimits(hunks: readonly Pick<Hunk, 'lines'>[], budget: number): number[] {
    let start = 0;
    return hunks.map((hunk) => {
        const limit = Math.max(0, Math.min(hunk.lines.length, budget - start));
        start += hunk.lines.length;
        return limit;
    });
}

/** First added line (new side) of the file, to open it at the right place; null if there is none. */
export function firstChangedLine(file: Pick<FileDiff, 'hunks'>): number | null {
    for (const hunk of file.hunks) {
        const added = hunk.lines.find((line) => line.t === '+' && line.n != null);
        if (added?.n != null) {
            return added.n;
        }
    }
    return null;
}

export const FILE_STATUS_TAGS: Partial<Record<FileDiff['status'], 'file.status.added' | 'file.status.removed' | 'file.status.renamed'>> = {
    added: 'file.status.added',
    removed: 'file.status.removed',
    renamed: 'file.status.renamed',
} satisfies Partial<Record<FileDiff['status'], MessageKey>>;
