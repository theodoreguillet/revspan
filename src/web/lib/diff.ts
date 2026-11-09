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

/** Left/right pairs of a hunk: the - then + runs are aligned line by line. */
export function splitRows(lines: DiffLine[]): SplitRow[] {
    const rows: SplitRow[] = [];
    let dels: DiffLine[] = [];
    let adds: DiffLine[] = [];
    const flush = (): void => {
        const count = Math.max(dels.length, adds.length);
        for (let k = 0; k < count; k++) {
            rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
        }
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
export function highlightParts(text: string, ranges: [number, number][] | undefined): TextPart[] {
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
    key: string;
    path: string;
    kind: ComposerKind;
    /** Line number on the new (new) or old (old) side. */
    line: number;
    code: string;
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

const sameTarget = (a: ComposerTarget | null, b: ComposerTarget | null): boolean => !!a && !!b && a.key === b.key;

export interface LineView {
    line: DiffLine;
    /** Target of the "+" button (null: no comment possible on this line). */
    target: ComposerTarget | null;
    /** Composer open under this line. */
    composer: ComposerTarget | null;
    threads: PlacedThread[];
}

export interface SplitCellView {
    side: 'old' | 'new';
    line: DiffLine | null;
    target: ComposerTarget | null;
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

/** Lines of a hunk in unified view, with threads and composer to insert below. */
export function unifiedRows({ path, lines, byLine, canComment, composer }: HunkViewInput): LineView[] {
    return lines.map((line) => {
        const target = canComment ? composerTargetFor(path, line, 'both') : null;
        return { line, target, composer: sameTarget(target, composer) ? composer : null, threads: threadsAt(byLine, line) };
    });
}

/** Lines of a hunk in side-by-side view (old on the left, new on the right). */
export function sideBySideRows({ path, lines, byLine, canComment, composer }: HunkViewInput): SplitRowView[] {
    const cell = (side: 'old' | 'new', line: DiffLine | null): SplitCellView =>
        ({ side, line, target: line && canComment ? composerTargetFor(path, line, side) : null });
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
