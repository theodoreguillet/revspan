import { describe, expect, it } from 'vitest';
import {
    clickSelection, defaultSelection, floorAvailable, isValidSelection, parseRangeQuery, presets, readout, repairSelection, singleVersion,
    unavailableVersions,
} from '../../src/web/lib/selection.ts';
import { makeVersions, prLong } from './fixtures.ts';
import { createTranslator } from '../../src/web/i18n/translator.ts';

// French, the language these expectations are written in (English is covered by test/web/i18n.test.ts and below).
const fr = createTranslator('fr');

describe('unavailable versions (commit erased by Bitbucket)', () => {
    // v2 and v3 erased out of 6 versions.
    const gone = new Set([2, 3]);

    it('detected from the versions; a "from" bound moves back to the last readable one (or master)', () => {
        expect([...unavailableVersions(makeVersions(6, { unavailable: [2, 3] }))]).toEqual([2, 3]);
        expect(floorAvailable(3, gone)).toBe(1);
        expect(floorAvailable(5, gone)).toBe(5);
        expect(floorAvailable(1, new Set([1]))).toBe(0);
    });

    it('click: nothing on an unavailable version; otherwise "from" = last readable before', () => {
        expect(clickSelection({ from: 4, to: 6 }, 3, false, gone)).toEqual({ from: 4, to: 6 });
        expect(clickSelection({ from: 4, to: 6 }, 4, false, gone)).toEqual({ from: 1, to: 4 });
        expect(clickSelection({ from: 5, to: 6 }, 4, true, gone)).toEqual({ from: 1, to: 6 });
    });

    it('default range, presets, single version and validity avoid unavailable versions', () => {
        expect(defaultSelection(6, 3, gone)).toEqual({ from: 1, to: 6 });
        expect(defaultSelection(3, 1, new Set([1]))).toEqual({ from: 0, to: 3 });
        expect(presets(6, 3, gone).map((p) => [p.key, p.from, p.to])).toEqual([['since', 1, 6], ['last', 5, 6], ['all', 0, 6]]);
        expect(singleVersion(6, 4, gone)).toEqual({ from: 1, to: 4 });
        expect(isValidSelection(6, 2, 6, gone)).toBe(false);
        expect(isValidSelection(6, 1, 3, gone)).toBe(false);
        expect(isValidSelection(6, 1, 4, gone)).toBe(true);
    });

    it('single version (Versions tab, [ ]): PR #48, v1 erased -> v2 alone starts from the base', () => {
        expect(singleVersion(3, 2, new Set([1]))).toEqual({ from: 0, to: 2 });
    });

    it('version discovered erased afterwards: range kept if possible, "from" moved back, otherwise default range', () => {
        expect(repairSelection(6, { from: 4, to: 6 }, 3, gone)).toEqual({ from: 4, to: 6 });
        expect(repairSelection(6, { from: 3, to: 6 }, 3, gone)).toEqual({ from: 1, to: 6 });
        expect(repairSelection(6, { from: 1, to: 3 }, 3, gone)).toEqual({ from: 1, to: 6 });
    });
});

describe('clickSelection', () => {
    it('simple click: what the version changed (N-1 -> N)', () => {
        expect(clickSelection({ from: 7, to: 10 }, 4, false)).toEqual({ from: 3, to: 4 });
    });

    it('click on master: full "to" version (from = 0, to unchanged)', () => {
        expect(clickSelection({ from: 3, to: 8 }, 0, false)).toEqual({ from: 0, to: 8 });
        expect(clickSelection({ from: 3, to: 8 }, 0, true)).toEqual({ from: 0, to: 8 });
    });

    it('Shift+click beyond "to": extends to the right', () => {
        expect(clickSelection({ from: 3, to: 8 }, 10, true)).toEqual({ from: 3, to: 10 });
    });

    it('Shift+click before or on "from": extends to the left (from = N-1)', () => {
        expect(clickSelection({ from: 3, to: 10 }, 2, true)).toEqual({ from: 1, to: 10 });
        expect(clickSelection({ from: 3, to: 10 }, 3, true)).toEqual({ from: 2, to: 10 });
    });

    it('Shift+click inside the range: moves the closest bound', () => {
        // 5 - 3 = 2 <= 10 - 5 = 5 -> "from" is closer
        expect(clickSelection({ from: 3, to: 10 }, 5, true)).toEqual({ from: 4, to: 10 });
        // 7 - 3 = 4 > 10 - 7 = 3 -> "to" is closer
        expect(clickSelection({ from: 3, to: 10 }, 7, true)).toEqual({ from: 3, to: 7 });
    });

    it('Shift+click at equal distance: the "from" bound wins', () => {
        expect(clickSelection({ from: 2, to: 8 }, 5, true)).toEqual({ from: 4, to: 8 });
    });
});

describe('defaultSelection', () => {
    it('reviewed before the latest version: since my review', () => {
        expect(defaultSelection(10, 7)).toEqual({ from: 7, to: 10 });
    });

    it('up to date: latest version alone', () => {
        expect(defaultSelection(10, 10)).toEqual({ from: 9, to: 10 });
    });

    it('never reviewed: everything against master', () => {
        expect(defaultSelection(10, null)).toEqual({ from: 0, to: 10 });
    });

    it('single version: full v1', () => {
        expect(defaultSelection(1, null)).toEqual({ from: 0, to: 1 });
        expect(defaultSelection(1, 1)).toEqual({ from: 0, to: 1 });
    });
});

describe('isValidSelection / singleVersion / parseRangeQuery', () => {
    it('valid 0 <= from < to <= n', () => {
        expect(isValidSelection(10, 0, 10)).toBe(true);
        expect(isValidSelection(10, 7, 10)).toBe(true);
        expect(isValidSelection(10, 10, 10)).toBe(false);
        expect(isValidSelection(10, 3, 11)).toBe(false);
        expect(isValidSelection(10, -1, 4)).toBe(false);
        expect(isValidSelection(10, null, 4)).toBe(false);
    });

    it('single version clamped to 1..n', () => {
        expect(singleVersion(10, 4)).toEqual({ from: 3, to: 4 });
        expect(singleVersion(10, 0)).toEqual({ from: 0, to: 1 });
        expect(singleVersion(10, 12)).toEqual({ from: 9, to: 10 });
    });

    it('reads from/to (digits only)', () => {
        expect(parseRangeQuery({ from: '7', to: '10' })).toEqual({ from: 7, to: 10 });
        expect(parseRangeQuery({ from: '-1', to: 'x' })).toEqual({ from: null, to: null });
        expect(parseRangeQuery({ from: ['7'] })).toEqual({ from: null, to: null });
    });
});

describe('presets', () => {
    it('"Since my review" only if lastReviewed < n', () => {
        expect(presets(10, 7).map((p) => [p.key, p.from, p.to])).toEqual([['since', 7, 10], ['last', 9, 10], ['all', 0, 10]]);
        expect(presets(10, 10).map((p) => p.key)).toEqual(['last', 'all']);
        expect(presets(10, null).map((p) => p.key)).toEqual(['last', 'all']);
        expect(presets(1, null).map((p) => p.key)).toEqual(['all']);
    });
});

describe('readout', () => {
    const { data, sums } = prLong();
    const versions = data.versions;

    it('range since my review (#212, v7 -> v10)', () => {
        expect(readout(fr, { from: 7, to: 10, versions, sums, stats: null })).toEqual({
            bold: 'Changements de v8 à v10',
            rest: '· par rapport à v7 · code modifié en v10 · 1 rebase',
        });
    });

    it('range with several code versions and rebases', () => {
        expect(readout(fr, { from: 3, to: 10, versions, sums, stats: null }).rest).toBe('· par rapport à v3 · code modifié en v4, v10 · 3 rebases');
    });

    it('single version: without code, or with rebase', () => {
        expect(readout(fr, { from: 3, to: 4, versions, sums, stats: null })).toEqual({ bold: 'Changements de v4', rest: '· par rapport à v3' });
        expect(readout(fr, { from: 7, to: 8, versions, sums, stats: null }).rest).toBe('· par rapport à v7 · aucun changement de code · 1 rebase');
    });

    it('range without code', () => {
        expect(readout(fr, { from: 4, to: 9, versions, sums, stats: null }).rest).toBe('· par rapport à v4 · aucun changement de code · 3 rebases');
    });

    it('full version against master, with stats when the diff is loaded', () => {
        expect(readout(fr, { from: 0, to: 10, versions, sums, stats: null })).toEqual({ bold: 'v10 complète', rest: '· par rapport à sa base sur master' });
        expect(readout(fr, { from: 0, to: 10, versions, sums, stats: { files: 10, added: 580, removed: 17 } }).rest)
            .toBe('· par rapport à sa base sur master · 10 fichiers, +580 −17');
    });

    it('summary not loaded yet: no claim about the code', () => {
        expect(readout(fr, { from: 7, to: 10, versions, sums: new Map(), stats: null }).rest).toBe('· par rapport à v7 · 1 rebase');
    });
});

describe('readout in English', () => {
    const en = createTranslator('en');
    const { data, sums } = prLong();

    it('range and full version', () => {
        expect(readout(en, { from: 3, to: 10, versions: data.versions, sums, stats: null }))
            .toEqual({ bold: 'Changes from v4 to v10', rest: '· against v3 · code changed in v4, v10 · 3 rebases' });
        expect(readout(en, { from: 0, to: 10, versions: data.versions, sums, stats: { files: 10, added: 580, removed: 17 } }))
            .toEqual({ bold: 'Full v10', rest: '· against its base on master · 10 files, +580 −17' });
    });
});
