import { describe, expect, it } from 'vitest';
import type { DiffLine, FileDiff, Thread } from '../../src/shared/api.ts';
import {
    composerKey, composerTargetFor, deletedLineComment, fileThreadCount, firstChangedLine, highlightParts, hunkRange, lastTouched,
    placeFileThreads, sideBySideRows, splitRows, unifiedRows, viewedStatus,
} from '../../src/web/lib/diff.ts';
import { prLong } from './fixtures.ts';

const line = (t: DiffLine['t'], o: number | null, n: number | null, text = ''): DiffLine => ({ t, o, n, text, hl: [] });

describe('viewedStatus', () => {
    const file = { path: 'a.ts', contentHash: 'h2' };

    it('jamais vu / vu avec ce contenu / modifié depuis vu', () => {
        expect(viewedStatus(file, {})).toBe('none');
        expect(viewedStatus(file, { 'a.ts': 'h2' })).toBe('seen');
        expect(viewedStatus(file, { 'a.ts': 'h1' })).toBe('changed');
    });
});

describe('splitRows', () => {
    it('aligne les suites - puis + ligne à ligne, contexte des deux côtés', () => {
        const rows = splitRows([line(' ', 1, 1), line('-', 2, null), line('-', 3, null), line('+', null, 2), line(' ', 4, 3), line('+', null, 4)]);
        expect(rows.map((r) => [r.left?.o ?? null, r.right?.n ?? null])).toEqual([[1, 1], [2, 2], [3, null], [4, 3], [null, 4]]);
    });

    it('un - après des + ouvre une nouvelle paire', () => {
        const rows = splitRows([line('+', null, 1), line('-', 1, null)]);
        expect(rows.map((r) => [r.left?.o ?? null, r.right?.n ?? null])).toEqual([[null, 1], [1, null]]);
    });
});

describe('highlightParts / hunkRange / composerKey', () => {
    it('découpe selon les plages à surligner', () => {
        expect(highlightParts('const a = b;', [[10, 11]])).toEqual([
            { text: 'const a = ', hl: false }, { text: 'b', hl: true }, { text: ';', hl: false },
        ]);
        expect(highlightParts('abc', [])).toEqual([{ text: 'abc', hl: false }]);
        expect(highlightParts('abc', [[1, 99]])).toEqual([{ text: 'a', hl: false }, { text: 'bc', hl: true }]);
    });

    it('plage de hunk façon git et clé de composeur', () => {
        expect(hunkRange({ oldStart: 37, oldLines: 7, newStart: 37, newLines: 7 })).toBe('@@ -37,7 +37,7 @@');
        expect(composerKey('new', 41, 'src/a.ts')).toBe('n41:src/a.ts');
        expect(composerKey('old', 40, 'src/a.ts')).toBe('o40:src/a.ts');
    });
});

// Un fichier avec un hunk (ligne 5 modifiée) et des fils : ouvert en ligne, résolu en ligne, hors hunk, niveau fichier, inconnu.
const thread = (id: number, resolved: boolean): Thread => ({
    id, path: 'src/Action.ts', anchor: { to: 5, from: null }, version: 2, resolved, resolvedBy: null, comments: [],
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
        { threadId: 1, line: 5, moved: false, outOfHunks: false },
        { threadId: 2, line: 7, moved: true, outOfHunks: false },
        { threadId: 3, line: 40, moved: false, outOfHunks: true },
        { threadId: 4, line: null, moved: false, outOfHunks: false },
        { threadId: 99, line: 5, moved: false, outOfHunks: false },
    ],
};
const ids = (list: { thread: Thread }[]): number[] => list.map((t) => t.thread.id);

describe('placeFileThreads', () => {
    it('fil ouvert sur sa ligne côté « to » ; hors hunk ou niveau fichier en tête ; fil inconnu ignoré', () => {
        const placed = placeFileThreads(file, threads, false);
        expect([...placed.byLine.keys()]).toEqual([5]);
        expect(ids(placed.byLine.get(5) ?? [])).toEqual([1]);
        expect(ids(placed.fileLevel)).toEqual([3, 4]);
    });

    it('fils résolus omis, sauf si on les affiche', () => {
        expect(ids(placeFileThreads(file, threads, true).byLine.get(7) ?? [])).toEqual([2]);
        expect(fileThreadCount(file, threads, false)).toBe(3);
        expect(fileThreadCount(file, threads, true)).toBe(4);
    });
});

describe('lignes de hunk (vues unifiée et côte à côte)', () => {
    const hunk = file.hunks[0]?.lines ?? [];
    const byLine = placeFileThreads(file, threads, false).byLine;
    const deleted = composerTargetFor(file.path, line('-', 5, null, '    return false;'), 'both');

    it('cibles du « + » : ligne côté nouveau, ou ligne supprimée citée', () => {
        expect(deleted).toEqual({ key: 'o5:src/Action.ts', path: 'src/Action.ts', kind: 'old', line: 5, code: '    return false;' });
        expect(composerTargetFor(file.path, line('+', null, 5, 'x'), 'both')).toMatchObject({ kind: 'new', line: 5 });
        expect(composerTargetFor(file.path, line('-', 5, null, 'x'), 'new')).toBeNull();
        expect(composerTargetFor(file.path, line(' ', 6, 6, '}'), 'old')).toBeNull();
    });

    it('vue unifiée : fils sous leur ligne, composeur ouvert, pas de « + » hors dernière version', () => {
        const rows = unifiedRows({ path: file.path, lines: hunk, byLine, canComment: true, composer: deleted });
        expect(rows.map((r) => r.target?.key ?? null)).toEqual(['n4:src/Action.ts', 'o5:src/Action.ts', 'n5:src/Action.ts', 'n6:src/Action.ts', 'n7:src/Action.ts']);
        expect(rows.map((r) => ids(r.threads))).toEqual([[], [], [1], [], []]);
        expect(rows.map((r) => r.composer?.key ?? null)).toEqual([null, 'o5:src/Action.ts', null, null, null]);
        expect(unifiedRows({ path: file.path, lines: hunk, byLine, canComment: false, composer: null }).every((r) => r.target === null)).toBe(true);
    });

    it('vue côte à côte : la ligne supprimée et la ligne ajoutée face à face', () => {
        const rows = sideBySideRows({ path: file.path, lines: hunk, byLine, canComment: true, composer: deleted });
        expect(rows).toHaveLength(4);
        const [, changed] = rows;
        expect(changed?.cells.map((c) => c.target?.key ?? null)).toEqual(['o5:src/Action.ts', 'n5:src/Action.ts']);
        expect(changed?.leftComposer?.key).toBe('o5:src/Action.ts');
        expect(changed?.rightComposer).toBeNull();
        expect(ids(changed?.threads ?? [])).toEqual([1]);
    });
});

describe('firstChangedLine', () => {
    it('première ligne ajoutée côté nouveau, sinon null', () => {
        expect(firstChangedLine(file)).toBe(5);
        expect(firstChangedLine({ hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, header: '', lines: [line('-', 1, null, 'x')] }] })).toBeNull();
        expect(firstChangedLine({ hunks: [] })).toBeNull();
    });
});

describe('lastTouched', () => {
    const { sums } = prLong();

    it('dernière version de la plage (from, to] qui a modifié le fichier', () => {
        expect(lastTouched(sums, 7, 10, 'package-lock.json')).toBe(9);
        expect(lastTouched(sums, 7, 10, 'coverage.config.json')).toBe(10);
        expect(lastTouched(sums, 0, 3, 'coverage.config.json')).toBe(1);
        expect(lastTouched(sums, 4, 8, 'coverage.config.json')).toBeNull();
    });
});

describe('deletedLineComment', () => {
    it('commentaire général citant la ligne supprimée', () => {
        expect(deletedLineComment('src/a.ts', 9, 10, '    return x;', 'Pourquoi ?'))
            .toBe('`src/a.ts` — ligne supprimée (v9 → v10) :\n```\n    return x;\n```\nPourquoi ?');
        expect(deletedLineComment('src/a.ts', 0, 10, 'x', 'y')).toContain('(master → v10)');
    });

    it('code contenant ``` : autre clôture', () => {
        expect(deletedLineComment('README.md', 1, 2, '```js', 'ok')).toBe('`README.md` — ligne supprimée (v1 → v2) :\n~~~\n```js\n~~~\nok');
    });
});
