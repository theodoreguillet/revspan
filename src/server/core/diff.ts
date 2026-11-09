// Line diff (Myers) + hunk building + intra-line highlighting.
import type { DiffLine, Hunk } from '../../shared/api.ts';

/**
 * Edit segment. a = (0-based) position in the old text, b = position in the new text.
 * '=': len identical lines; '-': len lines removed from a; '+': len lines added from b.
 */
export interface DiffOp {
    op: '=' | '-' | '+';
    a: number;
    b: number;
    len: number;
}

const DEFAULT_MAX_D = 3000;
const MAX_HL_LENGTH = 2000;
const MAX_HEADER = 80;
const SECTION_LINE = /^[A-Za-z_$]/;

/**
 * Marks the last line of a text without a final newline (git's "\ No newline at end of file"),
 * so that adding or removing that newline is seen as a change to that line.
 */
export const NO_EOL = '\u0000';

export function splitLines(text: string | null | undefined): string[] {
    if (!text) {
        return [];
    }
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

export function splitDiffLines(text: string): string[] {
    const lines = splitLines(text);
    if (lines.length > 0 && !text.endsWith('\n')) {
        lines[lines.length - 1] += NO_EOL;
    }
    return lines;
}

function pushOp(ops: DiffOp[], op: DiffOp['op'], a: number, b: number, len: number): void {
    if (len <= 0) {
        return;
    }
    const last = ops[ops.length - 1];
    if (last && last.op === op) {
        last.len += len;
        return;
    }
    ops.push({ op, a, b, len });
}

export function diffLines(oldLines: readonly string[], newLines: readonly string[], { maxD = DEFAULT_MAX_D } = {}): DiffOp[] {
    let start = 0;
    while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
        start++;
    }
    let endOld = oldLines.length;
    let endNew = newLines.length;
    while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
        endOld--;
        endNew--;
    }

    const ops: DiffOp[] = [];
    pushOp(ops, '=', 0, 0, start);

    const midOld = endOld - start;
    const midNew = endNew - start;
    if (midOld > 0 || midNew > 0) {
        const ids = new Map<string, number>();
        const toIds = (lines: readonly string[], from: number, to: number): Int32Array => {
            const out = new Int32Array(to - from);
            for (let i = from; i < to; i++) {
                const line = lines[i] as string;
                let id = ids.get(line);
                if (id === undefined) {
                    id = ids.size;
                    ids.set(line, id);
                }
                out[i - from] = id;
            }
            return out;
        };
        const mid = myers(toIds(oldLines, start, endOld), toIds(newLines, start, endNew), maxD);
        if (mid === null) {
            pushOp(ops, '-', start, start, midOld);
            pushOp(ops, '+', endOld, start, midNew);
        } else {
            for (const op of mid) {
                pushOp(ops, op.op, op.a + start, op.b + start, op.len);
            }
        }
    }

    pushOp(ops, '=', endOld, endNew, oldLines.length - endOld);
    return ops;
}

// Myers O((N+M)D); stores for each d the useful slice of V (about D² integers at worst), null beyond maxD.
function myers(a: Int32Array, b: Int32Array, maxD: number): DiffOp[] | null {
    const n = a.length;
    const m = b.length;
    if (n === 0) {
        return [{ op: '+', a: 0, b: 0, len: m }];
    }
    if (m === 0) {
        return [{ op: '-', a: 0, b: 0, len: n }];
    }
    const limit = Math.min(n + m, maxD);
    const off = limit + 1;
    const v = new Int32Array(2 * limit + 3);
    const trace: (Int32Array | null)[] = [];

    for (let d = 0; d <= limit; d++) {
        // State after step d-1, for k in [-(d-1), d-1].
        trace.push(d === 0 ? null : v.slice(off - (d - 1), off + d));
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }
            v[off + k] = x;
            if (x >= n && y >= m) {
                return backtrack(trace, d, n, m);
            }
        }
    }
    return null;
}

function backtrack(trace: (Int32Array | null)[], dEnd: number, n: number, m: number): DiffOp[] {
    const reversed: DiffOp[] = [];
    let x = n;
    let y = m;
    for (let d = dEnd; d > 0; d--) {
        const prev = trace[d] as Int32Array;
        const get = (k: number): number => prev[k + (d - 1)]!;
        const k = x - y;
        const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
        const prevX = get(prevK);
        const prevY = prevX - prevK;
        const midX = prevK === k + 1 ? prevX : prevX + 1;
        const midY = midX - k;
        if (x > midX) {
            reversed.push({ op: '=', a: midX, b: midY, len: x - midX });
        }
        reversed.push({ op: prevK === k + 1 ? '+' : '-', a: prevX, b: prevY, len: 1 });
        x = prevX;
        y = prevY;
    }
    if (x > 0) {
        reversed.push({ op: '=', a: 0, b: 0, len: x });
    }
    const ops: DiffOp[] = [];
    for (let i = reversed.length - 1; i >= 0; i--) {
        const op = reversed[i]!;
        pushOp(ops, op.op, op.a, op.b, op.len);
    }
    return ops;
}

export function diffStats(ops: readonly DiffOp[]): { added: number; removed: number } {
    let added = 0;
    let removed = 0;
    for (const op of ops) {
        if (op.op === '+') {
            added += op.len;
        } else if (op.op === '-') {
            removed += op.len;
        }
    }
    return { added, removed };
}

function stripCr(text: string): string {
    return text.endsWith('\r') ? text.slice(0, -1) : text;
}

function displayLine(t: DiffLine['t'], raw: string, o: number | null, n: number | null): DiffLine {
    const noEol = raw.endsWith(NO_EOL);
    const line: DiffLine = {
        t,
        o: o === null ? null : o + 1,
        n: n === null ? null : n + 1,
        text: stripCr(noEol ? raw.slice(0, -NO_EOL.length) : raw),
        hl: [],
    };
    if (noEol) {
        line.noEol = true;
    }
    return line;
}

// Git-style section header: last non-indented line (letter, _ or $) before the hunk.
function sectionHeader(oldLines: readonly string[], beforeIndex: number): string {
    for (let i = Math.min(beforeIndex, oldLines.length) - 1; i >= 0; i--) {
        const line = oldLines[i]!;
        if (SECTION_LINE.test(line)) {
            const text = stripCr(line.endsWith(NO_EOL) ? line.slice(0, -NO_EOL.length) : line).trimEnd();
            return text.length > MAX_HEADER ? `${text.slice(0, MAX_HEADER - 1)}…` : text;
        }
    }
    return '';
}

interface OpenHunk {
    oldIndex: number;
    newIndex: number;
    lines: DiffLine[];
}

function closeHunk(open: OpenHunk, oldLines: readonly string[]): Hunk {
    let oldCount = 0;
    let newCount = 0;
    for (const line of open.lines) {
        if (line.t !== '+') {
            oldCount++;
        }
        if (line.t !== '-') {
            newCount++;
        }
    }
    highlightIntraLine(open.lines);
    return {
        // Unified convention: 1-based start, or previous position if the side is empty.
        oldStart: oldCount === 0 ? open.oldIndex : open.oldIndex + 1,
        oldLines: oldCount,
        newStart: newCount === 0 ? open.newIndex : open.newIndex + 1,
        newLines: newCount,
        header: sectionHeader(oldLines, open.oldIndex),
        lines: open.lines,
    };
}

/** Builds the hunks (unified format) with `context` lines around the changes. */
export function buildHunks(ops: readonly DiffOp[], oldLines: readonly string[], newLines: readonly string[], context = 3): Hunk[] {
    const hunks: Hunk[] = [];
    if (!ops.some((op) => op.op !== '=')) {
        return hunks;
    }
    let current: OpenHunk | null = null;
    const contextLine = (a: number, b: number): DiffLine => displayLine(' ', oldLines[a]!, a, b);

    for (let i = 0; i < ops.length; i++) {
        const op = ops[i]!;
        if (op.op !== '=') {
            current ??= { oldIndex: op.a, newIndex: op.b, lines: [] };
            for (let j = 0; j < op.len; j++) {
                current.lines.push(op.op === '-'
                    ? displayLine('-', oldLines[op.a + j]!, op.a + j, null)
                    : displayLine('+', newLines[op.b + j]!, null, op.b + j));
            }
            continue;
        }
        const hasNextChange = i < ops.length - 1;
        if (current && hasNextChange && op.len <= 2 * context) {
            for (let j = 0; j < op.len; j++) {
                current.lines.push(contextLine(op.a + j, op.b + j));
            }
            continue;
        }
        if (current) {
            for (let j = 0; j < Math.min(context, op.len); j++) {
                current.lines.push(contextLine(op.a + j, op.b + j));
            }
            hunks.push(closeHunk(current, oldLines));
            current = null;
        }
        if (hasNextChange) {
            const from = op.len - Math.min(context, op.len);
            const opened: OpenHunk = { oldIndex: op.a + from, newIndex: op.b + from, lines: [] };
            for (let j = from; j < op.len; j++) {
                opened.lines.push(contextLine(op.a + j, op.b + j));
            }
            current = opened;
        }
    }
    if (current) {
        hunks.push(closeHunk(current, oldLines));
    }
    return hunks;
}

/** Pairs the '-' then '+' runs two by two and highlights the part that differs. */
export function highlightIntraLine(lines: DiffLine[]): void {
    let i = 0;
    while (i < lines.length) {
        if (lines[i]!.t !== '-') {
            i++;
            continue;
        }
        const delStart = i;
        while (i < lines.length && lines[i]!.t === '-') {
            i++;
        }
        const addStart = i;
        while (i < lines.length && lines[i]!.t === '+') {
            i++;
        }
        const pairs = Math.min(addStart - delStart, i - addStart);
        for (let p = 0; p < pairs; p++) {
            markPair(lines[delStart + p]!, lines[addStart + p]!);
        }
    }
}

function markPair(del: DiffLine, add: DiffLine): void {
    const a = del.text;
    const b = add.text;
    if (a.length > MAX_HL_LENGTH || b.length > MAX_HL_LENGTH) {
        return;
    }
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
        prefix++;
    }
    let suffix = 0;
    while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
        suffix++;
    }
    const common = prefix + suffix;
    // Lines too different: no highlighting (unreadable).
    if (common === 0 || common < 0.2 * Math.max(a.length, b.length)) {
        return;
    }
    if (a.length - suffix > prefix) {
        del.hl = [[prefix, a.length - suffix]];
    }
    if (b.length - suffix > prefix) {
        add.hl = [[prefix, b.length - suffix]];
    }
}
