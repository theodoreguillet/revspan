import { describe, expect, it } from 'vitest';
import type { DiffLine, FileDiff, Thread } from '../../src/shared/api.ts';
import {
    composerKey, composerTargetFor, currentMatchKey, deletedLineComment, estimatedLinesHeight, fileThreadCount, fileView, firstChangedLine, highlightParts, hunkRange,
    hunkRowLimits, initialRowBudget, lastTouched, nextRowBudget, nextUnseenIndex, placeFileThreads, PROGRESSIVE_LINES, rangeTarget, ROW_BLOCK, rowBlocks, ROWS_PER_FRAME,
    sideBySideRows, splitRows, unifiedRows, viewedStatus, viewportDistance, type ComposerTarget,
} from '../../src/web/lib/diff.ts';
import { prLong } from './fixtures.ts';
import { createTranslator } from '../../src/web/i18n/translator.ts';

// French, the language these expectations are written in (English is covered by test/web/i18n.test.ts and below).
const fr = createTranslator('fr');

const line = (t: DiffLine['t'], o: number | null, n: number | null, text = ''): DiffLine => ({ t, o, n, text, hl: [] });

describe('nextUnseenIndex', () => {
    const seen = (flags: string): { seen: boolean }[] => [...flags].map((c) => ({ seen: c === 's' }));

    it('first unseen file after the current one', () => {
        expect(nextUnseenIndex(seen('susu'), 1)).toBe(3);
        expect(nextUnseenIndex(seen('uuu'), 0)).toBe(1);
    });

    it('none after: the first unseen one before it', () => {
        expect(nextUnseenIndex(seen('uss'), 2)).toBe(0);
        expect(nextUnseenIndex(seen('usu'), 2)).toBe(0);
    });

    it('nothing unseen left (the current file counts as seen): null', () => {
        expect(nextUnseenIndex(seen('ss'), 0)).toBeNull();
        expect(nextUnseenIndex(seen('u'), 0)).toBeNull();
        expect(nextUnseenIndex([], 0)).toBeNull();
    });
});

describe('viewedStatus', () => {
    const file = { path: 'a.ts', contentHash: 'h2' };

    it('never seen / seen with this content / modified since seen', () => {
        expect(viewedStatus(file, {})).toBe('none');
        expect(viewedStatus(file, { 'a.ts': 'h2' })).toBe('seen');
        expect(viewedStatus(file, { 'a.ts': 'h1' })).toBe('changed');
    });
});

describe('splitRows', () => {
    it('aligns the - then + runs line by line, context on both sides', () => {
        const rows = splitRows([line(' ', 1, 1), line('-', 2, null), line('-', 3, null), line('+', null, 2), line(' ', 4, 3), line('+', null, 4)]);
        expect(rows.map((r) => [r.left?.o ?? null, r.right?.n ?? null])).toEqual([[1, 1], [2, 2], [3, null], [4, 3], [null, 4]]);
    });

    it('a - after some + opens a new pair', () => {
        const rows = splitRows([line('+', null, 1), line('-', 1, null)]);
        expect(rows.map((r) => [r.left?.o ?? null, r.right?.n ?? null])).toEqual([[null, 1], [1, null]]);
    });

    const paired = (o: number, pair?: number): DiffLine => ({ ...line('-', o, null), ...(pair === undefined ? {} : { pair }) });
    const sides = (rows: ReturnType<typeof splitRows>): [number | null, number | null][] => rows.map((r) => [r.left?.o ?? null, r.right?.n ?? null]);

    it('puts a removed line and the added line it was compared with on one row', () => {
        // 10 was split into 20 + 21 and compared with 21: the unpaired 20 gets its own row before it
        expect(sides(splitRows([paired(10, 21), line('+', null, 20), line('+', null, 21)]))).toEqual([[null, 20], [10, 21]]);
    });

    it('lines up the unpaired lines before, between and after the pairs by position', () => {
        const rows = splitRows([
            paired(1), paired(2, 12), paired(3), paired(4), paired(5, 15), paired(6),
            line('+', null, 10), line('+', null, 11), line('+', null, 12), line('+', null, 13), line('+', null, 14), line('+', null, 15), line('+', null, 16), line('+', null, 17),
        ]);
        expect(sides(rows)).toEqual([[1, 10], [null, 11], [2, 12], [3, 13], [4, 14], [5, 15], [6, 16], [null, 17]]);
    });

    it('without pairing information (or with a partner out of the run, or going back), the runs line up by position as before', () => {
        const plain = [line(' ', 1, 1), line('-', 2, null), line('-', 3, null), line('+', null, 2), line(' ', 4, 3), line('+', null, 4)];
        expect(sides(splitRows(plain))).toEqual([[1, 1], [2, 2], [3, null], [4, 3], [null, 4]]);
        expect(sides(splitRows([paired(2, 99), paired(3), line('+', null, 2), line('+', null, 3)]))).toEqual([[2, 2], [3, 3]]);
        // the second pairing would cross the first one: ignored
        expect(sides(splitRows([paired(2, 3), paired(3, 2), line('+', null, 2), line('+', null, 3)]))).toEqual([[null, 2], [2, 3], [3, null]]);
    });
});

describe('highlightParts / hunkRange / composerKey', () => {
    it('splits according to the ranges to highlight', () => {
        expect(highlightParts('const a = b;', [[10, 11]])).toEqual([
            { text: 'const a = ', hl: false }, { text: 'b', hl: true }, { text: ';', hl: false },
        ]);
        expect(highlightParts('abc', [])).toEqual([{ text: 'abc', hl: false }]);
        expect(highlightParts('abc', [[1, 99]])).toEqual([{ text: 'a', hl: false }, { text: 'bc', hl: true }]);
    });

    it('git-style hunk range and composer key', () => {
        expect(hunkRange({ oldStart: 37, oldLines: 7, newStart: 37, newLines: 7 })).toBe('@@ -37,7 +37,7 @@');
        expect(composerKey('new', 41, 'src/a.ts')).toBe('n41:src/a.ts');
        expect(composerKey('old', 40, 'src/a.ts')).toBe('o40:src/a.ts');
    });
});

// A file with a hunk (line 5 modified) and threads: open inline, resolved inline, outside a hunk, file level, unknown.
const thread = (id: number, resolved: boolean): Thread => ({
    id, path: 'src/Action.ts', anchor: { to: 5, from: null, startTo: null, startFrom: null }, version: 2, resolved, resolvedBy: null, comments: [],
});
const threads = new Map<number, Thread>([[1, thread(1, false)], [2, thread(2, true)], [3, thread(3, false)], [4, thread(4, false)]]);
const file: FileDiff = {
    path: 'src/Action.ts', oldPath: 'src/Action.ts', status: 'modified', category: 'code', binary: false, tooLarge: false,
    added: 1, removed: 1, contentHash: 'h5', conflict: false,
    hunks: [{
        oldStart: 4, oldLines: 4, newStart: 4, newLines: 4, header: 'export class Action {',
        lines: [line(' ', 4, 4, 'if (!id) {'), line('-', 5, null, '    return false;'), line('+', null, 5, '    return null;'), line(' ', 6, 6, '}'), line(' ', 7, 7, 'return this.save(id);')],
    }],
    threads: [
        { threadId: 1, line: 5, startLine: null, moved: false, outOfHunks: false },
        { threadId: 2, line: 7, startLine: null, moved: true, outOfHunks: false },
        { threadId: 3, line: 40, startLine: null, moved: false, outOfHunks: true },
        { threadId: 4, line: null, startLine: null, moved: false, outOfHunks: false },
        { threadId: 99, line: 5, startLine: null, moved: false, outOfHunks: false },
    ],
};
const ids = (list: { thread: Thread }[]): number[] => list.map((t) => t.thread.id);

describe('placeFileThreads', () => {
    it('open thread on its "to" side line; outside a hunk or file level at the top; unknown thread ignored', () => {
        const placed = placeFileThreads(file, threads, false);
        expect([...placed.byLine.keys()]).toEqual([5]);
        expect(ids(placed.byLine.get(5) ?? [])).toEqual([1]);
        expect(ids(placed.fileLevel)).toEqual([3, 4]);
    });

    it('resolved threads omitted, unless shown', () => {
        expect(ids(placeFileThreads(file, threads, true).byLine.get(7) ?? [])).toEqual([2]);
        expect(fileThreadCount(file, threads, false)).toBe(3);
        expect(fileThreadCount(file, threads, true)).toBe(4);
    });
});

describe('hunk lines (unified and side-by-side views)', () => {
    const hunk = file.hunks[0]?.lines ?? [];
    const byLine = placeFileThreads(file, threads, false).byLine;
    const deleted = composerTargetFor(file.path, line('-', 5, null, '    return false;'), 'both');

    it('"+" targets: new-side line, or quoted deleted line', () => {
        expect(deleted).toEqual({ key: 'o5:src/Action.ts', path: 'src/Action.ts', kind: 'old', line: 5, code: '    return false;' });
        expect(composerTargetFor(file.path, line('+', null, 5, 'x'), 'both')).toMatchObject({ kind: 'new', line: 5 });
        expect(composerTargetFor(file.path, line('-', 5, null, 'x'), 'new')).toBeNull();
        expect(composerTargetFor(file.path, line(' ', 6, 6, '}'), 'old')).toBeNull();
    });

    it('unified view: threads under their line, open composer, no "+" outside the latest version', () => {
        const rows = unifiedRows({ path: file.path, lines: hunk, byLine, canComment: true, composer: deleted });
        expect(rows.map((r) => r.target?.key ?? null)).toEqual(['n4:src/Action.ts', 'o5:src/Action.ts', 'n5:src/Action.ts', 'n6:src/Action.ts', 'n7:src/Action.ts']);
        expect(rows.map((r) => ids(r.threads))).toEqual([[], [], [1], [], []]);
        expect(rows.map((r) => r.composer?.key ?? null)).toEqual([null, 'o5:src/Action.ts', null, null, null]);
        expect(unifiedRows({ path: file.path, lines: hunk, byLine, canComment: false, composer: null }).every((r) => r.target === null)).toBe(true);
    });

    it('side-by-side view: the deleted line and the added line face to face', () => {
        const rows = sideBySideRows({ path: file.path, lines: hunk, byLine, canComment: true, composer: deleted });
        expect(rows).toHaveLength(4);
        const [, changed] = rows;
        expect(changed?.cells.map((c) => c.target?.key ?? null)).toEqual(['o5:src/Action.ts', 'n5:src/Action.ts']);
        expect(changed?.leftComposer?.key).toBe('o5:src/Action.ts');
        expect(changed?.rightComposer).toBeNull();
        expect(ids(changed?.threads ?? [])).toEqual([1]);
    });
});

describe('range of lines (Shift+click on a second "+")', () => {
    const target = (path: string, n: number): ComposerTarget => composerTargetFor(path, line(' ', n, n, `line ${n}`), 'both')!;
    const removed = composerTargetFor('src/Action.ts', line('-', 5, null, 'x'), 'both')!;

    it('same file, two new-side lines: the target of the last line, starting at the first (either click order)', () => {
        const range = rangeTarget(target('src/Action.ts', 4), target('src/Action.ts', 7));
        expect(range).toEqual({ ...target('src/Action.ts', 7), startLine: 4 });
        // the composer stays under the last line, whose key (and draft) it keeps
        expect(range?.key).toBe('n7:src/Action.ts');
        expect(rangeTarget(target('src/Action.ts', 7), target('src/Action.ts', 4))).toEqual(range);
        // a range is extended from its anchor line: the ends of a range given as the first target are ignored
        expect(rangeTarget({ ...target('src/Action.ts', 9), startLine: 7 }, target('src/Action.ts', 4))).toEqual({ ...target('src/Action.ts', 9), startLine: 4 });
    });

    it('the same line twice: that line alone', () => {
        expect(rangeTarget(target('src/Action.ts', 4), target('src/Action.ts', 4))).toEqual(target('src/Action.ts', 4));
        expect(rangeTarget({ ...target('src/Action.ts', 6), startLine: 4 }, target('src/Action.ts', 6))).toEqual(target('src/Action.ts', 6));
    });

    it('another file or a removed line: no range', () => {
        expect(rangeTarget(target('src/Action.ts', 4), target('src/Other.ts', 7))).toBeNull();
        expect(rangeTarget(target('src/Action.ts', 4), removed)).toBeNull();
        expect(rangeTarget(removed, target('src/Action.ts', 7))).toBeNull();
    });

    // Two hunks of the same file (lines 4-7 and 40-42) and a thread on 6-7.
    const hunkA = [line(' ', 4, 4), line('-', 5, null), line('+', null, 5), line(' ', 6, 6), line(' ', 7, 7)];
    const hunkB = [line(' ', 39, 40), line('+', null, 41), line(' ', 40, 42)];
    const rangeThread = { ...thread(7, false), anchor: { to: 7, from: null, startTo: 6, startFrom: null } };
    const ranged: FileDiff = {
        ...file,
        hunks: [{ oldStart: 4, oldLines: 4, newStart: 4, newLines: 4, header: '', lines: hunkA }, { oldStart: 39, oldLines: 2, newStart: 40, newLines: 3, header: '', lines: hunkB }],
        threads: [{ threadId: 7, line: 7, startLine: 6, moved: false, outOfHunks: false }, { threadId: 1, line: 5, startLine: null, moved: false, outOfHunks: false }],
    };
    const placed = placeFileThreads(ranged, new Map([[7, rangeThread], [1, thread(1, false)]]), false);

    it('the lines of a shown thread\'s range are marked; a thread on one line marks nothing', () => {
        const rows = unifiedRows({ path: ranged.path, lines: hunkA, byLine: placed.byLine, canComment: true, composer: null });
        expect(rows.map((r) => [r.line.n, r.inRange, r.composing])).toEqual([[4, false, false], [null, false, false], [5, false, false], [6, true, false], [7, true, false]]);
    });

    it('composer on a range: its new-side lines are marked in every hunk of the file (not the removed ones, not another file)', () => {
        const composer = rangeTarget(target(ranged.path, 5), target(ranged.path, 41));
        const rowsA = unifiedRows({ path: ranged.path, lines: hunkA, byLine: placed.byLine, canComment: true, composer });
        const rowsB = unifiedRows({ path: ranged.path, lines: hunkB, byLine: placed.byLine, canComment: true, composer });
        expect(rowsA.map((r) => [r.line.n, r.composing])).toEqual([[4, false], [null, false], [5, true], [6, true], [7, true]]);
        expect(rowsB.map((r) => [r.line.n, r.composing, r.composer?.startLine ?? null])).toEqual([[40, true, null], [41, true, 5], [42, false, null]]);
        expect(rowsA.map((r) => r.inRange)).toEqual([false, false, true, true, true]);
        const other = unifiedRows({ path: 'src/Other.ts', lines: hunkA, byLine: new Map(), canComment: true, composer });
        expect(other.some((r) => r.inRange || r.composing)).toBe(false);
        // a single-line composer marks nothing
        const single = unifiedRows({ path: ranged.path, lines: hunkA, byLine: new Map(), canComment: true, composer: target(ranged.path, 5) });
        expect(single.some((r) => r.inRange || r.composing)).toBe(false);
    });

    it('side by side: only the new-side cells are marked', () => {
        const composer = rangeTarget(target(ranged.path, 4), target(ranged.path, 5));
        const rows = sideBySideRows({ path: ranged.path, lines: hunkA, byLine: placed.byLine, canComment: true, composer });
        expect(rows.map((r) => r.cells.map((c) => [c.line?.o ?? c.line?.n ?? null, c.inRange, c.composing]))).toEqual([
            [[4, false, false], [4, true, true]],
            [[5, false, false], [5, true, true]],
            [[6, false, false], [6, true, false]],
            [[7, false, false], [7, true, false]],
        ]);
        expect(rows[1]?.rightComposer?.startLine).toBe(4);
    });
});

describe('firstChangedLine', () => {
    it('first added line on the new side, otherwise null', () => {
        expect(firstChangedLine(file)).toBe(5);
        expect(firstChangedLine({ hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, header: '', lines: [line('-', 1, null, 'x')] }] })).toBeNull();
        expect(firstChangedLine({ hunks: [] })).toBeNull();
    });
});

describe('large diffs (blocks of rows, progressive rendering)', () => {
    const lines = (count: number): DiffLine[] => Array.from({ length: count }, (_, k) => line(' ', k + 1, k + 1));
    const hunk = (count: number) => ({ oldStart: 1, oldLines: count, newStart: 1, newLines: count, header: '', lines: lines(count) });

    it('estimates the height of the lines: a header and 20 px per line for each hunk', () => {
        expect(estimatedLinesHeight({ hunks: [hunk(3), hunk(10)] })).toBe(21 + 60 + 21 + 200);
        expect(estimatedLinesHeight({ hunks: [] })).toBe(0);
    });

    it('cuts the rows in blocks of ROW_BLOCK, the last one shorter', () => {
        expect(rowBlocks(ROW_BLOCK * 2 + 3)).toEqual([
            { start: 0, end: ROW_BLOCK }, { start: ROW_BLOCK, end: ROW_BLOCK * 2 }, { start: ROW_BLOCK * 2, end: ROW_BLOCK * 2 + 3 },
        ]);
        expect(rowBlocks(0)).toEqual([]);
    });

    it('renders a small file on screen at once, a large one from its first lines, a file off screen from none', () => {
        expect(initialRowBudget(PROGRESSIVE_LINES, true)).toBe(Infinity);
        expect(initialRowBudget(30, false)).toBe(0);
        expect(initialRowBudget(0, false)).toBe(Infinity);
        const first = initialRowBudget(5000, true);
        expect(first).toBeLessThan(PROGRESSIVE_LINES);
        let budget = first;
        let frames = 0;
        while (budget !== Infinity) {
            const next = nextRowBudget(budget, ROWS_PER_FRAME, 5000);
            expect(next).toBeGreaterThan(budget);
            budget = next;
            frames++;
        }
        expect(frames).toBe(Math.ceil((5000 - first) / ROWS_PER_FRAME));
        expect(nextRowBudget(0, 10, 10)).toBe(Infinity);
    });

    it('keys the current match of a block by its line: side by side, the paired removed and added lines share a row', () => {
        const block = { start: 50, end: 100 };
        // the same row 60, the same column 8: the removed line 12, then the added line 13
        expect(currentMatchKey(block, 60, 12, 8)).not.toBe(currentMatchKey(block, 60, 13, 8));
        expect(currentMatchKey(block, 60, 12, 8)).toBe('12:8');
        expect(currentMatchKey(block, 120, 70, 8)).toBe('');
        expect(currentMatchKey(block, -1, -1, -1)).toBe('');
    });

    it('measures how far a box is from the window, 0 when part of it shows', () => {
        expect(viewportDistance(100, 50, 800)).toBe(0);
        expect(viewportDistance(-500, 600, 800)).toBe(0);
        expect(viewportDistance(1000, 50, 800)).toBe(200);
        expect(viewportDistance(-300, 100, 800)).toBe(200);
    });

    it("gives each hunk its share of the file's budget, from 0 to all its lines", () => {
        const hunks = [hunk(30), hunk(50), hunk(40)];
        expect(hunkRowLimits(hunks, 60)).toEqual([30, 30, 0]);
        expect(hunkRowLimits(hunks, Infinity)).toEqual([30, 50, 40]);
        expect(hunkRowLimits(hunks, 0)).toEqual([0, 0, 0]);
    });
});

describe('lastTouched', () => {
    const { sums } = prLong();

    it('latest version of the range (from, to] that modified the file', () => {
        expect(lastTouched(sums, 7, 10, 'package-lock.json')).toBe(9);
        expect(lastTouched(sums, 7, 10, 'coverage.config.json')).toBe(10);
        expect(lastTouched(sums, 0, 3, 'coverage.config.json')).toBe(1);
        expect(lastTouched(sums, 4, 8, 'coverage.config.json')).toBeNull();
    });
});

describe('deletedLineComment', () => {
    it('general comment quoting the deleted line', () => {
        expect(deletedLineComment(fr, 'src/a.ts', 9, 10, '    return x;', 'Pourquoi ?'))
            .toBe('`src/a.ts` — ligne supprimée (v9 → v10) :\n```\n    return x;\n```\nPourquoi ?');
        expect(deletedLineComment(fr, 'src/a.ts', 0, 10, 'x', 'y')).toContain('(master → v10)');
    });

    it('code containing ```: other fence', () => {
        expect(deletedLineComment(fr, 'README.md', 1, 2, '```js', 'ok')).toBe('`README.md` — ligne supprimée (v1 → v2) :\n~~~\n```js\n~~~\nok');
    });
});

describe('fileView', () => {
    it('keeps split for a modified file', () => {
        expect(fileView({ status: 'modified' }, 'split')).toBe('split');
        expect(fileView({ status: 'renamed' }, 'split')).toBe('split');
        expect(fileView({ status: 'modified' }, 'unified')).toBe('unified');
    });

    it('renders an added file unified in split view', () => {
        expect(fileView({ status: 'added' }, 'split')).toBe('unified');
    });

    it('renders a removed file unified in split view', () => {
        expect(fileView({ status: 'removed' }, 'split')).toBe('unified');
    });
});
