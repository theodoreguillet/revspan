import { describe, expect, it } from 'vitest';
import { buildHunks, diffLines, diffStats, splitLines, type DiffOp } from '../../src/server/core/diff.ts';

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
        const newLines = oldLines.map((l) => (l.startsWith('const') ? 'const id = this.repo.buildIdFromPayload(recordData);' : l));
        const hunks = buildHunks(diffLines(oldLines, newLines), oldLines, newLines, 3);
        expect(hunks).toHaveLength(1);
        const [hunk] = hunks;
        expect(hunk).toMatchObject({ oldStart: 2, newStart: 2, oldLines: 7, newLines: 7 });
        const del = hunk!.lines.find((l) => l.t === '-')!;
        const add = hunk!.lines.find((l) => l.t === '+')!;
        expect(del).toMatchObject({ o: 5, n: null, hl: [[11, 34]] });
        expect(add.n).toBe(5);
        expect(add.text.slice(...add.hl[0]!)).toBe('this.repo.buildIdFromPayload(recordData)');
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
