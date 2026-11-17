import { describe, expect, it } from 'vitest';
import type { DiffLine } from '../../src/shared/api.ts';
import { buildHunks, diffLines, diffStats, highlightIntraLine, splitLines, type DiffOp } from '../../src/server/core/diff.ts';

/** Replays the segments to rebuild the new text and checks the consistency of the "=" ones. */
function apply(ops: readonly DiffOp[], oldLines: readonly string[], newLines: readonly string[]): string[] {
    const out: string[] = [];
    for (const op of ops) {
        for (let i = 0; i < op.len; i++) {
            if (op.op === '=') {
                expect(oldLines[op.a + i]).toBe(newLines[op.b + i]);
                out.push(oldLines[op.a + i]!);
            } else if (op.op === '+') {
                out.push(newLines[op.b + i]!);
            }
        }
    }
    return out;
}

function lcsLength(a: readonly string[], b: readonly string[]): number {
    const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
        }
    }
    return dp[a.length]![b.length]!;
}

function seeded(seed: number): () => number {
    let s = seed;
    return () => {
        s = (s * 1103515245 + 12345) % 2147483648;
        return s / 2147483648;
    };
}

describe('splitLines', () => {
    it('ignores the final line break', () => {
        expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
        expect(splitLines('a\nb')).toEqual(['a', 'b']);
        expect(splitLines('')).toEqual([]);
        expect(splitLines(null)).toEqual([]);
    });
});

describe('diffLines', () => {
    it('identical texts: a single "=" segment and no hunk', () => {
        const ops = diffLines(['a', 'b'], ['a', 'b']);
        expect(ops).toEqual([{ op: '=', a: 0, b: 0, len: 2 }]);
        expect(buildHunks(ops, ['a', 'b'], ['a', 'b'])).toEqual([]);
    });

    it('minimal diff on 300 random cases (optimal LCS length, exact reconstruction)', () => {
        const rand = seeded(42);
        const pick = (n: number): string[] => Array.from({ length: n }, () => ['x', 'y', 'z', 'w'][Math.floor(rand() * 4)]!);
        for (let iter = 0; iter < 300; iter++) {
            const a = pick(Math.floor(rand() * 30));
            const b = pick(Math.floor(rand() * 30));
            const ops = diffLines(a, b);
            expect(apply(ops, a, b)).toEqual(b);
            const lcs = lcsLength(a, b);
            expect(diffStats(ops)).toEqual({ added: b.length - lcs, removed: a.length - lcs });
        }
    });

    it('beyond the distance cap, the block fallback is still correct', () => {
        const a = Array.from({ length: 200 }, (_, i) => `a${i}`);
        const b = Array.from({ length: 200 }, (_, i) => `b${i}`);
        const ops = diffLines(a, b, { maxD: 10 });
        expect(apply(ops, a, b)).toEqual(b);
        expect(diffStats(ops)).toEqual({ added: 200, removed: 200 });
    });

    it('stays fast on a large, lightly modified file', () => {
        const a = Array.from({ length: 40000 }, (_, i) => `"dep-${i}": "1.0.${i % 7}",`);
        const b = a.slice();
        b[100] = '"dep-100": "2.0.0",';
        b.splice(20000, 0, '"new-dep": "1.0.0",');
        const start = Date.now();
        expect(diffStats(diffLines(a, b))).toEqual({ added: 2, removed: 1 });
        expect(Date.now() - start).toBeLessThan(1000);
    });
});

describe('buildHunks', () => {
    it('context, line numbers and intra-line highlighting', () => {
        const oldLines = ['l1', 'l2', 'l3', 'l4', 'const id = recordData.labels?.slug;', 'l6', 'l7', 'l8', 'l9'];
        const newLines = oldLines.map((l) => (l.startsWith('const') ? 'const id = recordData.labels?.name;' : l));
        const hunks = buildHunks(diffLines(oldLines, newLines), oldLines, newLines, 3);
        expect(hunks).toHaveLength(1);
        const [hunk] = hunks;
        expect(hunk).toMatchObject({ oldStart: 2, newStart: 2, oldLines: 7, newLines: 7 });
        const del = hunk!.lines.find((l) => l.t === '-')!;
        const add = hunk!.lines.find((l) => l.t === '+')!;
        expect(del).toMatchObject({ o: 5, n: null, hl: [[30, 34]] });
        expect(add).toMatchObject({ o: null, n: 5, hl: [[30, 34]] });
    });

    it('two distant changes give two hunks, close ones a single one', () => {
        const oldLines = Array.from({ length: 30 }, (_, i) => `l${i + 1}`);
        const far = oldLines.map((l, i) => (i === 2 || i === 25 ? `${l}!` : l));
        const near = oldLines.map((l, i) => (i === 2 || i === 7 ? `${l}!` : l));
        expect(buildHunks(diffLines(oldLines, far), oldLines, far)).toHaveLength(2);
        expect(buildHunks(diffLines(oldLines, near), oldLines, near)).toHaveLength(1);
    });

    it('added file: hunk with oldStart 0', () => {
        expect(buildHunks(diffLines([], ['a', 'b']), [], ['a', 'b'])[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 });
    });

    it('git-style section header (last non-indented line before the hunk)', () => {
        const oldLines = ['import x from "y";', '', 'export default class CreateRecord {', '    a() {', '        return 1;', '    }', '    b() {', '        return 2;', '    }', '}'];
        const newLines = oldLines.map((l) => (l === '        return 2;' ? '        return 3;' : l));
        expect(buildHunks(diffLines(oldLines, newLines), oldLines, newLines, 1)[0]!.header).toBe('export default class CreateRecord {');
        expect(buildHunks(diffLines(['a', 'b'], ['x', 'b']), ['a', 'b'], ['x', 'b'])[0]!.header).toBe('');
    });
});

describe('highlightIntraLine', () => {
    const line = (t: '-' | '+', text: string): DiffLine => ({ t, o: null, n: null, text, hl: [] });
    /** Runs the highlighting on a "-" run followed by a "+" run. */
    function highlight(removed: readonly string[], added: readonly string[]): { del: DiffLine[]; add: DiffLine[] } {
        const del = removed.map((text) => line('-', text));
        const add = added.map((text) => line('+', text));
        highlightIntraLine([...del, ...add]);
        return { del, add };
    }
    const marked = (l: DiffLine): string[] => l.hl.map(([start, end]) => l.text.slice(start, end));

    it('marks only the changed words, in several ranges', () => {
        const { del, add } = highlight(['const ok = validateData(this.payload);'], ['const ok = validatePayloadData(this.payload, options);']);
        expect(add[0]!.hl).toEqual([[19, 26], [43, 52]]);
        expect(marked(add[0]!)).toEqual(['Payload', ', options']);
        expect(del[0]!.hl).toEqual([]);
    });

    it('a replaced word is marked whole, a part of it only at a camelCase, snake_case or digit boundary', () => {
        const flag = highlight(['const enabled = true;'], ['const enabled = false;']);
        expect(flag.del[0]!.hl).toEqual([[16, 20]]);
        expect(flag.add[0]!.hl).toEqual([[16, 21]]);
        const getter = highlight(['const label = user.getName() + user_id + item10;'], ['const label = user.getTitle() + user_name + item11;']);
        expect(marked(getter.del[0]!)).toEqual(['Name', 'id', '10']);
        expect(marked(getter.add[0]!)).toEqual(['Title', 'name', '11']);
    });

    it('joins two changed words separated by a space only', () => {
        const { del, add } = highlight(['    await this.store.save(left + right, id);'], ['    await this.store.save(top - bottom, id);']);
        expect(marked(del[0]!)).toEqual(['left + right']);
        expect(marked(add[0]!)).toEqual(['top - bottom']);
        const apart = highlight(['const sum = add(first, second);'], ['const sum = add(one, two);']);
        expect(marked(apart.del[0]!)).toEqual(['first', 'second']);
        expect(marked(apart.add[0]!)).toEqual(['one', 'two']);
    });

    it('pairs a removed line with the most similar added line of the run, the others stay unmarked', () => {
        const { del, add } = highlight(
            ['    const user = await this.users.findById(userId, { withRoles: true });'],
            ['    const options = { withRoles: true };', '    const user = await this.users.findById(userId, options);'],
        );
        expect(marked(del[0]!)).toEqual(['{ withRoles: true }']);
        expect(add[0]!.hl).toEqual([]);
        expect(marked(add[1]!)).toEqual(['options']);
    });

    it('never crosses two pairings: the most similar pair wins', () => {
        const { del, add } = highlight(
            ['const first = load(alpha, 1);', 'const second = load(beta, 2);'],
            ['const second = load(beta, 2, true);', 'const first = load(alpha, 10);'],
        );
        expect(marked(del[0]!)).toEqual(['1']);
        expect(marked(add[1]!)).toEqual(['10']);
        expect(del[1]!.hl).toEqual([]);
        expect(add[0]!.hl).toEqual([]);
    });

    it('no highlight when the lines are too different (the line background says it all)', () => {
        const { del, add } = highlight(['        return a.b(c);', 'const id = recordData.labels?.slug;'], ['        throw new Error(x.y);', 'const id = this.repo.buildIdFromPayload(recordData);']);
        expect([...del, ...add].map((l) => l.hl)).toEqual([[], [], [], []]);
    });

    it('marks an indentation or trailing space change', () => {
        const { del, add } = highlight(['    run();', 'stop();  '], ['        run();', 'stop();']);
        expect(add[0]!.hl).toEqual([[4, 8]]);
        expect(del[0]!.hl).toEqual([]);
        expect(del[1]!.hl).toEqual([[7, 9]]);
        expect(add[1]!.hl).toEqual([]);
    });

    it('long lines fall back to one range between the common prefix and suffix', () => {
        const filler = 'v'.repeat(1000);
        const long = highlight([`${filler} foo bar baz`], [`${filler} qux bar quux`]);
        expect(long.del[0]!.hl).toEqual([[1001, 1012]]);
        expect(long.add[0]!.hl).toEqual([[1001, 1013]]);
        // Short enough, but too many tokens to compare word by word.
        const dense = highlight([`${'p'.repeat(60)} ${'a,'.repeat(101)}X`], [`${'p'.repeat(60)} ${'a;'.repeat(101)}Y`]);
        expect(dense.del[0]!.hl).toEqual([[62, 264]]);
        expect(dense.add[0]!.hl).toEqual([[62, 264]]);
        const huge = highlight([`${'w'.repeat(2001)}a`], [`${'w'.repeat(2001)}b`]);
        expect(huge.del[0]!.hl).toEqual([]);
        expect(huge.add[0]!.hl).toEqual([]);
    });

    it('stays fast on a long run of changed lines', () => {
        const removed = Array.from({ length: 400 }, (_, i) => `    const value${i} = compute(input, ${i}, 'label ${i}');`);
        const added = removed.map((text) => text.replace('compute(input', 'computeAll(input, options'));
        const start = Date.now();
        const { del, add } = highlight(removed, added);
        expect(Date.now() - start).toBeLessThan(1000);
        expect(marked(del[399]!)).toEqual([]);
        expect(marked(add[399]!)).toEqual(['All', ', options']);
    });
});
