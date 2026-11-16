import { describe, expect, it } from 'vitest';
import { PREFETCH_MAX_FILES, prefetchFileCount, prefetchQueue } from '../../src/web/lib/prefetch.ts';
import { presets, type Range } from '../../src/web/lib/selection.ts';

const keyOf = (r: Range): string => `${r.from}-${r.to}-3`;
// 6 versions, last reviewed v2: since = v2 → v6, last = v5 → v6, all = master → v6
const sixVersions = presets(6, 2);

describe('prefetchQueue', () => {
    it('orders last, since, all', () => {
        expect(PREFETCH_MAX_FILES).toBe(30);
        expect(prefetchQueue(sixVersions, new Set(), keyOf, 12)).toEqual([{ from: 5, to: 6 }, { from: 2, to: 6 }, { from: 0, to: 6 }]);
    });

    it('skips cached ranges', () => {
        expect(prefetchQueue(sixVersions, new Set(['2-6-3', '0-6-3']), keyOf, 12)).toEqual([{ from: 5, to: 6 }]);
        expect(prefetchQueue(sixVersions, new Set(['5-6-3', '2-6-3', '0-6-3']), keyOf, 12)).toEqual([]);
        // reviewed v5 of 6: "since" and "last" are the same range, asked once
        expect(prefetchQueue(presets(6, 5), new Set(), keyOf, 12)).toEqual([{ from: 5, to: 6 }, { from: 0, to: 6 }]);
    });

    it('is empty above 30 files or when the size is unknown', () => {
        expect(prefetchQueue(sixVersions, new Set(), keyOf, 30)).toHaveLength(3);
        expect(prefetchQueue(sixVersions, new Set(), keyOf, 31)).toEqual([]);
        expect(prefetchQueue(sixVersions, new Set(), keyOf, null)).toEqual([]);
    });
});

describe('prefetchFileCount', () => {
    const cmp = (from: number, to: number, files: number) => ({ from, to, stats: { files, added: 0, removed: 0 } });
    const version = (index: number, paths: string[]) => ({
        index, kind: 'code' as const, added: 0, removed: 0, masterFiles: 0, conflicts: 0,
        files: paths.map((path) => ({ path, added: 1, removed: 0, category: 'code' as const })),
    });
    const summary = { versions: [version(1, ['a.ts', 'b.ts']), version(2, ['b.ts', 'c.ts']), version(3, [])] };

    it('takes the comparison against master when it is known', () => {
        expect(prefetchFileCount(null, [cmp(5, 6, 40), cmp(0, 6, 8)], 6)).toBe(8);
    });

    it('otherwise counts the distinct files of every version in the summary', () => {
        expect(prefetchFileCount(summary, [cmp(2, 3, 1)], 3)).toBe(3);
    });

    it('is unknown until the summary is loaded, whatever the size of the diffs shown', () => {
        expect(prefetchFileCount(null, [cmp(5, 6, 3), cmp(2, 6, 9), cmp(0, 5, 4)], 6)).toBeNull();
        expect(prefetchFileCount(null, [], 6)).toBeNull();
    });
});
