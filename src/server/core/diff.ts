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

// ---------- Intra-line highlighting ----------

/** Above this length (or this many token comparisons), a pair falls back to one range between common prefix and suffix. */
const MAX_WORD_DIFF_LENGTH = 1000;
const MAX_WORD_DIFF_CELLS = 40_000;
/** Runs with more line pairs than this are paired by position (pairing by similarity compares every pair). */
const MAX_PAIRING_CELLS = 10_000;
/** Below this share of common characters (spaces aside) in the longer line, a pair is too different to highlight. */
const MIN_SIMILARITY = 0.4;
/** Same rule for the prefix/suffix fallback, whose common part is only a lower bound. */
const MIN_EDGE_SIMILARITY = 0.2;
/** Words (identifier runs), space runs, single punctuation characters. */
const TOKEN = /[\p{L}\p{M}\p{N}_$]+|\s+|[\s\S]/gu;
const WORD_CHAR = /[\p{L}\p{M}\p{N}_$]/u;
const SPACE = /^\s/;
const BLANK = /^\s*$/;
const DIGIT = /\p{N}/u;
const UPPER = /\p{Lu}/u;
const LOWER = /\p{Ll}/u;

/** A line cut into tokens. */
interface Tokens {
    words: string[];
    /** Start of each token in the line, then the line length. */
    starts: number[];
    /** Characters outside space runs. */
    solid: number;
}

function tokenize(text: string): Tokens {
    const words: string[] = [];
    const starts: number[] = [];
    let solid = 0;
    for (const match of text.matchAll(TOKEN)) {
        words.push(match[0]);
        starts.push(match.index);
        if (!SPACE.test(match[0])) {
            solid += match[0].length;
        }
    }
    starts.push(text.length);
    return { words, starts, solid };
}

/** Pairs the '-' run with the '+' run that follows it and highlights the words that differ in each pair. */
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
        if (i > addStart) {
            highlightRun(lines.slice(delStart, addStart), lines.slice(addStart, i));
        }
    }
}

interface Candidate {
    tokens: Tokens;
    /** Non-space words and their counts. */
    bag: Map<string, number>;
}

function candidateOf(line: DiffLine): Candidate | null {
    if (line.text.length > MAX_HL_LENGTH) {
        return null;
    }
    const tokens = tokenize(line.text);
    const bag = new Map<string, number>();
    for (const word of tokens.words) {
        if (!SPACE.test(word)) {
            bag.set(word, (bag.get(word) ?? 0) + 1);
        }
    }
    return { tokens, bag };
}

/** Share of the longer line made of words both lines contain, order aside (an upper bound of the in-order share). */
function bagSimilarity(a: Candidate, b: Candidate): number {
    const longer = Math.max(a.tokens.solid, b.tokens.solid);
    if (longer === 0) {
        return 0;
    }
    const [small, large] = a.bag.size <= b.bag.size ? [a.bag, b.bag] : [b.bag, a.bag];
    let common = 0;
    for (const [word, count] of small) {
        common += Math.min(count, large.get(word) ?? 0) * word.length;
    }
    return common / longer;
}

/**
 * Pairs each removed line with the most similar added line, the most similar pairs first, a pairing never crossing
 * another (order kept); unpaired lines get no highlight. Very long runs are paired by position.
 */
function highlightRun(dels: readonly DiffLine[], adds: readonly DiffLine[]): void {
    if (dels.length * adds.length > MAX_PAIRING_CELLS) {
        for (let p = 0; p < Math.min(dels.length, adds.length); p++) {
            markPair(dels[p]!, adds[p]!);
        }
        return;
    }
    const delCandidates = dels.map(candidateOf);
    const addCandidates = adds.map(candidateOf);
    const pairs: { i: number; j: number; similarity: number }[] = [];
    delCandidates.forEach((del, i) => {
        addCandidates.forEach((add, j) => {
            const similarity = del && add ? bagSimilarity(del, add) : 0;
            if (similarity >= MIN_SIMILARITY) {
                pairs.push({ i, j, similarity });
            }
        });
    });
    // Equal similarity: the closest positions first.
    pairs.sort((x, y) => y.similarity - x.similarity || Math.abs(x.i - x.j) - Math.abs(y.i - y.j) || x.i - y.i);
    const addOf = new Int32Array(dels.length).fill(-1);
    const taken = new Uint8Array(adds.length);
    for (const { i, j } of pairs) {
        if (addOf[i] === -1 && !taken[j] && !crosses(addOf, i, j)) {
            addOf[i] = j;
            taken[j] = 1;
        }
    }
    addOf.forEach((j, i) => {
        if (j !== -1) {
            markPair(dels[i]!, adds[j]!, delCandidates[i]!.tokens, addCandidates[j]!.tokens);
        }
    });
}

/** Whether pairing removed line i with added line j would cross a pairing already made (those never cross each other). */
function crosses(addOf: Int32Array, i: number, j: number): boolean {
    for (let k = i - 1; k >= 0; k--) {
        if (addOf[k] !== -1) {
            if (addOf[k]! > j) {
                return true;
            }
            break;
        }
    }
    for (let k = i + 1; k < addOf.length; k++) {
        if (addOf[k] !== -1) {
            return addOf[k]! < j;
        }
    }
    return false;
}

/** Highlights the words that differ in a pair, or nothing when the lines are too different. */
function markPair(del: DiffLine, add: DiffLine, delTokens?: Tokens, addTokens?: Tokens): void {
    const a = del.text;
    const b = add.text;
    if (a.length > MAX_HL_LENGTH || b.length > MAX_HL_LENGTH) {
        return;
    }
    if (a.length > MAX_WORD_DIFF_LENGTH || b.length > MAX_WORD_DIFF_LENGTH) {
        markEdges(del, add);
        return;
    }
    const ta = delTokens ?? tokenize(a);
    const tb = addTokens ?? tokenize(b);
    const matches = matchWords(ta.words, tb.words);
    if (!matches) {
        markEdges(del, add);
        return;
    }
    let common = 0;
    for (const [i] of matches) {
        const word = ta.words[i]!;
        if (!SPACE.test(word)) {
            common += word.length;
        }
    }
    if (common === 0 || common < MIN_SIMILARITY * Math.max(ta.solid, tb.solid)) {
        return;
    }
    const delRanges: [number, number][] = [];
    const addRanges: [number, number][] = [];
    let nextA = 0;
    let nextB = 0;
    const end: [number, number] = [ta.words.length, tb.words.length];
    // The last "match" stands for the end of both lines.
    for (const [i, j] of [...matches, end]) {
        changedSpan(a, ta.starts[nextA]!, ta.starts[i]!, b, tb.starts[nextB]!, tb.starts[j]!, delRanges, addRanges);
        nextA = i + 1;
        nextB = j + 1;
    }
    del.hl = joinRanges(a, delRanges);
    add.hl = joinRanges(b, addRanges);
}

/** Old rule for long lines: one range between the common prefix and suffix, if they are long enough. */
function markEdges(del: DiffLine, add: DiffLine): void {
    const a = del.text;
    const b = add.text;
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
        prefix++;
    }
    let suffix = 0;
    while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
        suffix++;
    }
    const common = prefix + suffix;
    if (common === 0 || common < MIN_EDGE_SIMILARITY * Math.max(a.length, b.length)) {
        return;
    }
    if (a.length - suffix > prefix) {
        del.hl = [[prefix, a.length - suffix]];
    }
    if (b.length - suffix > prefix) {
        add.hl = [[prefix, b.length - suffix]];
    }
}

/** Spaces weigh little: the alignment favors the code, the longer words first. */
function weight(word: string): number {
    return SPACE.test(word) ? 1 : 2 * word.length;
}

/**
 * Common tokens of two lines in order (weighted longest common subsequence), as [index in a, index in b] pairs;
 * null when the part between the common prefix and suffix needs more than MAX_WORD_DIFF_CELLS comparisons.
 */
function matchWords(a: readonly string[], b: readonly string[]): [number, number][] | null {
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) {
        pre++;
    }
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) {
        suf++;
    }
    const n = a.length - pre - suf;
    const m = b.length - pre - suf;
    if (n * m > MAX_WORD_DIFF_CELLS) {
        return null;
    }
    const out: [number, number][] = [];
    for (let k = 0; k < pre; k++) {
        out.push([k, k]);
    }
    if (n > 0 && m > 0) {
        const ids = new Map<string, number>();
        const idOf = (word: string): number => {
            let id = ids.get(word);
            if (id === undefined) {
                id = ids.size;
                ids.set(word, id);
            }
            return id;
        };
        const idsA = Int32Array.from({ length: n }, (_, k) => idOf(a[pre + k]!));
        const idsB = Int32Array.from({ length: m }, (_, k) => idOf(b[pre + k]!));
        const weights = Int32Array.from({ length: n }, (_, k) => weight(a[pre + k]!));
        const width = m + 1;
        const best = new Int32Array((n + 1) * width);
        for (let i = 1; i <= n; i++) {
            const id = idsA[i - 1]!;
            const w = weights[i - 1]!;
            for (let j = 1; j <= m; j++) {
                const up = best[(i - 1) * width + j]!;
                const left = best[i * width + j - 1]!;
                let value = up > left ? up : left;
                if (idsB[j - 1] === id) {
                    const diagonal = best[(i - 1) * width + j - 1]! + w;
                    if (diagonal > value) {
                        value = diagonal;
                    }
                }
                best[i * width + j] = value;
            }
        }
        const middle: [number, number][] = [];
        let i = n;
        let j = m;
        while (i > 0 && j > 0) {
            if (idsA[i - 1] === idsB[j - 1] && best[i * width + j] === best[(i - 1) * width + j - 1]! + weights[i - 1]!) {
                middle.push([pre + i - 1, pre + j - 1]);
                i--;
                j--;
            } else if (best[(i - 1) * width + j]! >= best[i * width + j - 1]!) {
                i--;
            } else {
                j--;
            }
        }
        out.push(...middle.reverse());
    }
    for (let k = 0; k < suf; k++) {
        out.push([a.length - suf + k, b.length - suf + k]);
    }
    return out;
}

/**
 * Ranges of a changed span (between two common tokens): when both sides changed, the common start and end of the two
 * texts stay unmarked if they end at a word boundary (camelCase, snake_case, digits), so that `validateData` →
 * `validatePayloadData` marks `Payload` but `true` → `false` marks the whole words.
 */
function changedSpan(a: string, aFrom: number, aTo: number, b: string, bFrom: number, bTo: number, aOut: [number, number][], bOut: [number, number][]): void {
    if (aFrom < aTo && bFrom < bTo) {
        let head = 0;
        while (aFrom + head < aTo && bFrom + head < bTo && a[aFrom + head] === b[bFrom + head]) {
            head++;
        }
        while (head > 0 && !(isBoundary(a, aFrom + head, aFrom, aTo) && isBoundary(b, bFrom + head, bFrom, bTo))) {
            head--;
        }
        let tail = 0;
        while (aFrom + head < aTo - tail && bFrom + head < bTo - tail && a[aTo - 1 - tail] === b[bTo - 1 - tail]) {
            tail++;
        }
        while (tail > 0 && !(isBoundary(a, aTo - tail, aFrom, aTo) && isBoundary(b, bTo - tail, bFrom, bTo))) {
            tail--;
        }
        aFrom += head;
        bFrom += head;
        aTo -= tail;
        bTo -= tail;
    }
    if (aFrom < aTo) {
        aOut.push([aFrom, aTo]);
    }
    if (bFrom < bTo) {
        bOut.push([bFrom, bTo]);
    }
}

/** Whether position k of s, inside [from, to], separates two words or two parts of a word. */
function isBoundary(s: string, k: number, from: number, to: number): boolean {
    if (k <= from || k >= to) {
        return true;
    }
    const code = s.charCodeAt(k);
    if (code >= 0xdc00 && code <= 0xdfff) {
        return false; // inside a surrogate pair
    }
    const x = s[k - 1]!;
    const y = s[k]!;
    if (!WORD_CHAR.test(x) || !WORD_CHAR.test(y) || x === '_' || x === '$' || y === '_' || y === '$') {
        return true;
    }
    if (DIGIT.test(x) !== DIGIT.test(y)) {
        return true;
    }
    // fooBar → foo|Bar, XMLParser → XML|Parser
    return UPPER.test(y) && (LOWER.test(x) || (UPPER.test(x) && k + 1 < to && LOWER.test(s[k + 1]!)));
}

/** Ranges in order, those separated by nothing or by spaces only joined into one. */
function joinRanges(text: string, ranges: readonly [number, number][]): [number, number][] {
    const out: [number, number][] = [];
    for (const [start, end] of ranges) {
        const last = out[out.length - 1];
        if (last && BLANK.test(text.slice(last[1], start))) {
            last[1] = end;
        } else {
            out.push([start, end]);
        }
    }
    return out;
}
