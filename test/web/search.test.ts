import { describe, expect, it, vi } from 'vitest';
import { computed, effectScope, nextTick, shallowRef } from 'vue';
import type { DiffLine, FileDiff, Hunk } from '../../src/shared/api.ts';
import { SEARCH_DEBOUNCE_MS, useDiffSearch } from '../../src/web/composables/useDiffSearch.ts';
import { mergeTokens } from '../../src/web/lib/highlight.ts';
import { fileNameMatches, findHits, lineMarks, stepHit, type SearchHit } from '../../src/web/lib/search.ts';

const line = (t: DiffLine['t'], text: string): DiffLine => ({ t, o: null, n: null, text, hl: [] });
const hunk = (...lines: DiffLine[]): Hunk => ({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, header: '', lines });
const file = (path: string, ...hunks: Hunk[]): FileDiff => ({
    path, oldPath: null, status: 'modified', category: 'code', binary: false, tooLarge: false,
    added: 0, removed: 0, contentHash: 'h', conflict: false, hunks, threads: [],
});
const hit = (fileIdx: number, hunkIdx: number, lineIdx: number, start: number, end: number, path = `f${fileIdx}`): SearchHit =>
    ({ fileIdx, path, hunk: hunkIdx, line: lineIdx, start, end });

describe('fileNameMatches', () => {
    it('fileNameMatches is case-insensitive and matches folders', () => {
        expect(fileNameMatches('src/web/components/FileList.vue', 'filelist')).toBe(true);
        expect(fileNameMatches('src/web/components/FileList.vue', 'WEB/COMP')).toBe(true);
        expect(fileNameMatches('src/web/components/FileList.vue', 'server')).toBe(false);
    });
});

describe('findHits', () => {
    it('findHits orders hits and finds several per line', () => {
        const files = [
            file('a.ts', hunk(line(' ', 'const value = 1;'), line('-', 'no match')), hunk(line('+', 'Value + VALUE'))),
            file('b.ts'),
            file('c.ts', hunk(line(' ', 'the value'))),
        ];
        expect(findHits(files, 'value')).toEqual([
            hit(0, 0, 0, 6, 11, 'a.ts'),
            hit(0, 1, 0, 0, 5, 'a.ts'),
            hit(0, 1, 0, 8, 13, 'a.ts'),
            hit(2, 0, 0, 4, 9, 'c.ts'),
        ]);
    });

    it('findHits does not overlap the hits of one line', () => {
        expect(findHits([file('a.ts', hunk(line(' ', 'aaaa')))], 'aa').map((h) => [h.start, h.end])).toEqual([[0, 2], [2, 4]]);
    });

    it('findHits ignores queries under 2 characters', () => {
        const files = [file('a.ts', hunk(line(' ', 'abc')))];
        expect(findHits(files, '')).toEqual([]);
        expect(findHits(files, 'a')).toEqual([]);
        expect(findHits(files, 'ab')).toHaveLength(1);
    });

    it('findHits takes the query as plain text, not a regular expression', () => {
        const files = [file('a.ts', hunk(line(' ', 'a.b(c) axb')))];
        expect(findHits(files, 'a.b').map((h) => h.start)).toEqual([0]);
        expect(findHits(files, 'b(c)').map((h) => h.start)).toEqual([2]);
    });
});

describe('lineMarks', () => {
    it('lineMarks returns the ranges of one line', () => {
        const hits = [hit(0, 0, 3, 1, 2), hit(1, 0, 2, 0, 4), hit(1, 0, 2, 6, 9), hit(1, 1, 2, 0, 1), hit(2, 0, 0, 5, 6)];
        expect(lineMarks(hits, 1, 0, 2)).toEqual([[0, 4], [6, 9]]);
        expect(lineMarks(hits, 1, 1, 2)).toEqual([[0, 1]]);
        expect(lineMarks(hits, 0, 0, 2)).toEqual([]);
        expect(lineMarks([], 0, 0, 0)).toEqual([]);
    });
});

describe('stepHit', () => {
    it('stepHit goes to the next / previous hit and wraps around', () => {
        expect(stepHit(-1, 3, 1)).toBe(0);
        expect(stepHit(-1, 3, -1)).toBe(2);
        expect(stepHit(2, 3, 1)).toBe(0);
        expect(stepHit(0, 3, -1)).toBe(2);
        expect(stepHit(0, 0, 1)).toBe(-1);
    });
});

describe('mergeTokens with search marks', () => {
    it('mergeTokens splits at the search marks, over the token colors and the change emphasis', () => {
        const tokens = [{ content: 'const', color: '#111111' }, { content: ' ab' }];
        expect(mergeTokens('const ab', tokens, [[4, 7]], [{ start: 2, end: 5, kind: 'hit' }, { start: 6, end: 8, kind: 'cur' }])).toEqual([
            { text: 'co', color: '#111111', hl: false },
            { text: 'ns', color: '#111111', hl: false, mark: 'hit' },
            { text: 't', color: '#111111', hl: true, mark: 'hit' },
            { text: ' ', hl: true },
            { text: 'a', hl: true, mark: 'cur' },
            { text: 'b', hl: false, mark: 'cur' },
        ]);
    });
});

describe('useDiffSearch', () => {
    function setup() {
        const compare = shallowRef([file('a.ts', hunk(line(' ', 'one value'))), file('b.ts', hunk(line('+', 'value two'), line(' ', 'values')))]);
        const shown: number[] = [];
        const scrolled = vi.fn();
        const scope = effectScope();
        const search = scope.run(() => useDiffSearch(computed(() => compare.value), {
            showFile: async (idx) => {
                shown.push(idx);
            },
            scrollToMatch: scrolled,
        }))!;
        return { compare, search, shown, scrolled, scope };
    }

    it('useDiffSearch searches after the debounce, and at once on Enter', async () => {
        vi.useFakeTimers();
        try {
            const { search, shown, scrolled, scope } = setup();
            search.input.value = 'value';
            await nextTick();
            expect(search.hits.value).toHaveLength(0);
            await search.step(1);
            expect(search.hits.value).toHaveLength(3);
            expect(search.current.value).toBe(0);
            await search.step(1);
            expect(search.currentHit.value).toMatchObject({ path: 'b.ts', line: 0 });
            expect(shown).toEqual([0, 1]);
            expect(scrolled).toHaveBeenCalledTimes(2);
            // the debounce firing later with the same text keeps the current hit
            vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
            expect(search.current.value).toBe(1);
            search.input.value = 'two';
            await nextTick();
            vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
            expect(search.query.value).toBe('two');
            expect(search.current.value).toBe(-1);
            scope.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('useDiffSearch keeps the current hit when the comparison is reloaded with the same lines', async () => {
        const { compare, search, scope } = setup();
        search.input.value = 'value';
        await search.step(-1);
        expect(search.currentHit.value).toMatchObject({ path: 'b.ts', line: 1 });
        compare.value = [file('b.ts', hunk(line('+', 'value two'), line(' ', 'values')))];
        expect(search.currentHit.value).toMatchObject({ fileIdx: 0, path: 'b.ts', line: 1 });
        compare.value = [file('a.ts', hunk(line(' ', 'one value')))];
        expect(search.current.value).toBe(-1);
        expect(search.listed(0)).toBe(true);
        search.clear();
        expect(search.active.value).toBe(false);
        scope.stop();
    });
});
