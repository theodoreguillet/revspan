// Intra-line highlighting: pairs the removed and added lines of each run, then marks the words that differ in a pair.
import type { DiffLine } from '../../shared/api.ts';

/** Lines longer than this are never highlighted. */
const MAX_HL_LENGTH = 2000;
/** Above this length (or this many token comparisons), a pair gets one range between common prefix and suffix. */
const MAX_WORD_DIFF_LENGTH = 1000;
const MAX_WORD_DIFF_CELLS = 40_000;
/** Runs with more line pairs than this are paired by position (pairing by similarity compares every pair). */
const MAX_PAIRING_CELLS = 10_000;
/**
 * Work allowed for the highlighting of one file, counted in token comparisons (a tokenized character counts
 * TOKENIZE_COST). Once spent, the remaining runs are paired by position and their pairs get the prefix/suffix range.
 */
export const WORK_BUDGET = 6_000_000;
const TOKENIZE_COST = 8;
/** Below this share of common characters (spaces aside) in the longer line, a pair is too different to highlight. */
const MIN_SIMILARITY = 0.4;
/** Same rule for the prefix/suffix fallback, whose common part is only a lower bound. */
const MIN_EDGE_SIMILARITY = 0.2;
const WORD_CHAR = /[\p{L}\p{M}\p{N}_$]/u;
const SPACE_CHAR = /\s/;
const DIGIT = /\p{N}/u;
const UPPER = /\p{Lu}/u;
const LOWER = /\p{Ll}/u;
const BLANK = /^\s*$/;
const WORD = 0;
const SPACE = 1;
const OTHER = 2;

/** Work spent on the highlighting of one file (its hunks share it). */
export interface WorkBudget {
    spent: number;
}

export function workBudget(): WorkBudget {
    return { spent: 0 };
}

/** Takes `cost` from the budget when it is left, otherwise takes nothing. */
function afford(budget: WorkBudget, cost: number): boolean {
    if (budget.spent + cost > WORK_BUDGET) {
        return false;
    }
    budget.spent += cost;
    return true;
}

/** Ids of the tokens of a run: equal tokens share an id. */
class Vocabulary {
    private readonly index = new Map<string, number>();
    /** Length and space flag of each id. */
    readonly lengths: number[] = [];
    readonly spaces: boolean[] = [];

    idOf(word: string, space: boolean): number {
        let id = this.index.get(word);
        if (id === undefined) {
            id = this.lengths.length;
            this.index.set(word, id);
            this.lengths.push(word.length);
            this.spaces.push(space);
        }
        return id;
    }
}

/** A line cut into words (identifier runs), space runs and single punctuation characters. */
interface Tokens {
    vocabulary: Vocabulary;
    ids: number[];
    /** Start of each token in the line, then the line length. */
    starts: number[];
    /** Characters outside space runs. */
    solid: number;
    /** Non-space token ids, sorted, and their counts. */
    bagIds: Int32Array;
    bagCounts: Int32Array;
}

function kindAt(text: string, i: number): number {
    const c = text.charCodeAt(i);
    if (c < 128) {
        if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36) {
            return WORD;
        }
        return c === 32 || (c >= 9 && c <= 13) ? SPACE : OTHER;
    }
    const char = String.fromCodePoint(text.codePointAt(i)!);
    if (WORD_CHAR.test(char)) {
        return WORD;
    }
    return SPACE_CHAR.test(char) ? SPACE : OTHER;
}

/** UTF-16 length of the character at i (2 for a surrogate pair). */
function charLength(text: string, i: number): number {
    const c = text.charCodeAt(i);
    return c >= 0xd800 && c <= 0xdbff && i + 1 < text.length ? 2 : 1;
}

function tokenize(text: string, vocabulary: Vocabulary): Tokens {
    const ids: number[] = [];
    const starts: number[] = [];
    let solid = 0;
    let i = 0;
    while (i < text.length) {
        const start = i;
        const kind = kindAt(text, i);
        i += charLength(text, i);
        while (kind !== OTHER && i < text.length && kindAt(text, i) === kind) {
            i += charLength(text, i);
        }
        ids.push(vocabulary.idOf(text.slice(start, i), kind === SPACE));
        starts.push(start);
        if (kind !== SPACE) {
            solid += i - start;
        }
    }
    starts.push(text.length);
    const sorted = Int32Array.from(ids.filter((id) => !vocabulary.spaces[id])).sort();
    const bagIds: number[] = [];
    const bagCounts: number[] = [];
    sorted.forEach((id, k) => {
        if (k > 0 && sorted[k - 1] === id) {
            bagCounts[bagCounts.length - 1]!++;
        } else {
            bagIds.push(id);
            bagCounts.push(1);
        }
    });
    return { vocabulary, ids, starts, solid, bagIds: Int32Array.from(bagIds), bagCounts: Int32Array.from(bagCounts) };
}

/** Characters of the words both lines contain, order aside: an upper bound of their common part in order. */
function sharedChars(a: Tokens, b: Tokens): number {
    const lengths = a.vocabulary.lengths;
    let common = 0;
    let x = 0;
    let y = 0;
    while (x < a.bagIds.length && y < b.bagIds.length) {
        const ida = a.bagIds[x]!;
        const idb = b.bagIds[y]!;
        if (ida === idb) {
            common += Math.min(a.bagCounts[x]!, b.bagCounts[y]!) * lengths[ida]!;
            x++;
            y++;
        } else if (ida < idb) {
            x++;
        } else {
            y++;
        }
    }
    return common;
}

/**
 * Whether two lines are worth comparing word by word: similar enough, or the words of one are all in the other (an
 * insertion or a deletion inside a line, such as `foo()` → `foo(a, b)`, however small the line).
 */
function worthComparing(a: Tokens, b: Tokens, shared: number): boolean {
    return shared > 0 && (shared >= MIN_SIMILARITY * Math.max(a.solid, b.solid) || shared === a.solid || shared === b.solid);
}

/**
 * Highlights the words that differ in the changed lines of a hunk: each '-' run is paired with the '+' run that
 * follows it, and a removed line notes its partner (`pair`) for the side-by-side view. One budget per file.
 */
export function highlightIntraLine(lines: DiffLine[], budget: WorkBudget = workBudget()): void {
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
            highlightRun(lines.slice(delStart, addStart), lines.slice(addStart, i), budget);
        }
    }
}

interface Pair {
    del: DiffLine;
    add: DiffLine;
    tokens?: [Tokens, Tokens];
}

function highlightRun(dels: readonly DiffLine[], adds: readonly DiffLine[], budget: WorkBudget): void {
    const pairs = (dels.length * adds.length <= MAX_PAIRING_CELLS ? pairBySimilarity(dels, adds, budget) : null)
        ?? Array.from({ length: Math.min(dels.length, adds.length) }, (_, p): Pair => ({ del: dels[p]!, add: adds[p]! }));
    for (const { del, add, tokens } of pairs) {
        if (add.n !== null) {
            del.pair = add.n;
        }
        markPair(del, add, budget, tokens);
    }
}

/**
 * Pairs each removed line with the most similar added line, the most similar pairs first, a pairing never crossing
 * another (order kept); unpaired lines get no highlight. Null when the budget cannot pay for it (then by position).
 */
function pairBySimilarity(dels: readonly DiffLine[], adds: readonly DiffLine[], budget: WorkBudget): Pair[] | null {
    const fits = (line: DiffLine): boolean => line.text.length <= MAX_HL_LENGTH;
    const chars = [...dels, ...adds].reduce((sum, line) => sum + (fits(line) ? line.text.length : 0), 0);
    if (!afford(budget, chars * TOKENIZE_COST)) {
        return null;
    }
    const vocabulary = new Vocabulary();
    const delTokens = dels.map((line) => (fits(line) ? tokenize(line.text, vocabulary) : null));
    const addTokens = adds.map((line) => (fits(line) ? tokenize(line.text, vocabulary) : null));
    const bags = (list: (Tokens | null)[]): number => list.reduce((sum, t) => sum + (t?.bagIds.length ?? 0), 0);
    if (!afford(budget, adds.length * bags(delTokens) + dels.length * bags(addTokens))) {
        return null;
    }
    const candidates: { i: number; j: number; similarity: number }[] = [];
    delTokens.forEach((a, i) => {
        addTokens.forEach((b, j) => {
            const shared = a && b ? sharedChars(a, b) : 0;
            if (a && b && worthComparing(a, b, shared)) {
                // how much of each line the other explains: a line inside another ranks above a partial overlap
                candidates.push({ i, j, similarity: (shared / a.solid + shared / b.solid) / 2 });
            }
        });
    });
    // Equal similarity: the closest positions first.
    candidates.sort((x, y) => y.similarity - x.similarity || Math.abs(x.i - x.j) - Math.abs(y.i - y.j) || x.i - y.i);
    const addOf = new Int32Array(dels.length).fill(-1);
    const taken = new Uint8Array(adds.length);
    for (const { i, j } of candidates) {
        if (addOf[i] === -1 && !taken[j] && !crosses(addOf, i, j)) {
            addOf[i] = j;
            taken[j] = 1;
        }
    }
    const pairs: Pair[] = [];
    addOf.forEach((j, i) => {
        if (j !== -1) {
            pairs.push({ del: dels[i]!, add: adds[j]!, tokens: [delTokens[i]!, addTokens[j]!] });
        }
    });
    return pairs;
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
function markPair(del: DiffLine, add: DiffLine, budget: WorkBudget, tokens?: [Tokens, Tokens]): void {
    const a = del.text;
    const b = add.text;
    if (a.length > MAX_HL_LENGTH || b.length > MAX_HL_LENGTH) {
        return;
    }
    if (a.length > MAX_WORD_DIFF_LENGTH || b.length > MAX_WORD_DIFF_LENGTH) {
        markEdges(del, add);
        return;
    }
    let pair = tokens;
    if (!pair) {
        if (!afford(budget, (a.length + b.length) * TOKENIZE_COST)) {
            markEdges(del, add);
            return;
        }
        const vocabulary = new Vocabulary();
        pair = [tokenize(a, vocabulary), tokenize(b, vocabulary)];
    }
    const [ta, tb] = pair;
    // Cheap bound first: most too-different pairs stop here, before the comparison in order.
    if (!worthComparing(ta, tb, sharedChars(ta, tb))) {
        return;
    }
    const matches = matchWords(ta, tb, budget);
    if (!matches) {
        markEdges(del, add);
        return;
    }
    const ranges = changedRanges(a, ta, b, tb, matches);
    if (ranges) {
        [del.hl, add.hl] = ranges;
    }
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

/**
 * Common tokens of two lines in order (longest common subsequence, spaces weighing little so that the alignment
 * favors the code and the longer words), as [index in a, index in b] pairs. Null when the part between the common
 * prefix and suffix needs more than MAX_WORD_DIFF_CELLS comparisons or more than the budget left.
 */
function matchWords(ta: Tokens, tb: Tokens, budget: WorkBudget): [number, number][] | null {
    const a = ta.ids;
    const b = tb.ids;
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
    if (n * m > MAX_WORD_DIFF_CELLS || !afford(budget, n * m)) {
        return null;
    }
    const out: [number, number][] = [];
    for (let k = 0; k < pre; k++) {
        out.push([k, k]);
    }
    if (n > 0 && m > 0) {
        const { lengths, spaces } = ta.vocabulary;
        const weights = Int32Array.from({ length: n }, (_, k) => {
            const id = a[pre + k]!;
            return spaces[id] ? 1 : 2 * lengths[id]!;
        });
        const width = m + 1;
        const best = new Int32Array((n + 1) * width);
        for (let i = 1; i <= n; i++) {
            const id = a[pre + i - 1]!;
            const w = weights[i - 1]!;
            for (let j = 1; j <= m; j++) {
                const up = best[(i - 1) * width + j]!;
                const left = best[i * width + j - 1]!;
                let value = up > left ? up : left;
                if (b[pre + j - 1] === id) {
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
            if (a[pre + i - 1] === b[pre + j - 1] && best[i * width + j] === best[(i - 1) * width + j - 1]! + weights[i - 1]!) {
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
 * Ranges of both lines from their common tokens; null when too different: under MIN_SIMILARITY common characters,
 * unless one line is left unmarked (the other only gained or lost words: an insertion is shown however small).
 */
function changedRanges(a: string, ta: Tokens, b: string, tb: Tokens, matches: readonly [number, number][]): [[number, number][], [number, number][]] | null {
    const { lengths, spaces } = ta.vocabulary;
    let common = 0;
    for (const [i] of matches) {
        const id = ta.ids[i]!;
        if (!spaces[id]) {
            common += lengths[id]!;
        }
    }
    if (common === 0) {
        return null;
    }
    const delRanges: [number, number][] = [];
    const addRanges: [number, number][] = [];
    let nextA = 0;
    let nextB = 0;
    const end: [number, number] = [ta.ids.length, tb.ids.length];
    // The last "match" stands for the end of both lines.
    for (const [i, j] of [...matches, end]) {
        const [sa, sb] = trimSpans(a, { from: ta.starts[nextA]!, to: ta.starts[i]! }, b, { from: tb.starts[nextB]!, to: tb.starts[j]! });
        if (sa.from < sa.to) {
            delRanges.push([sa.from, sa.to]);
        }
        if (sb.from < sb.to) {
            addRanges.push([sb.from, sb.to]);
        }
        nextA = i + 1;
        nextB = j + 1;
    }
    const oneSided = !delRanges.length || !addRanges.length;
    if (!oneSided && common < MIN_SIMILARITY * Math.max(ta.solid, tb.solid)) {
        return null;
    }
    return [joinRanges(a, delRanges), joinRanges(b, addRanges)];
}

/** [from, to[ in a line. */
interface Span {
    from: number;
    to: number;
}

/**
 * A changed span of each line (between two common tokens), trimmed: when both sides changed, the common start and
 * end of the two texts stay unmarked if they end at a word boundary (camelCase, snake_case, digits), so that
 * `validateData` → `validatePayloadData` marks `Payload` but `true` → `false` marks the whole words.
 */
function trimSpans(a: string, sa: Span, b: string, sb: Span): [Span, Span] {
    if (sa.from === sa.to || sb.from === sb.to) {
        return [sa, sb];
    }
    let head = 0;
    while (sa.from + head < sa.to && sb.from + head < sb.to && a[sa.from + head] === b[sb.from + head]) {
        head++;
    }
    while (head > 0 && !(isBoundary(a, sa.from + head, sa) && isBoundary(b, sb.from + head, sb))) {
        head--;
    }
    let tail = 0;
    while (sa.from + head < sa.to - tail && sb.from + head < sb.to - tail && a[sa.to - 1 - tail] === b[sb.to - 1 - tail]) {
        tail++;
    }
    while (tail > 0 && !(isBoundary(a, sa.to - tail, sa) && isBoundary(b, sb.to - tail, sb))) {
        tail--;
    }
    return [{ from: sa.from + head, to: sa.to - tail }, { from: sb.from + head, to: sb.to - tail }];
}

/** Whether position k of s, inside the span, separates two words or two parts of a word. */
function isBoundary(s: string, k: number, span: Span): boolean {
    if (k <= span.from || k >= span.to) {
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
    return UPPER.test(y) && (LOWER.test(x) || (UPPER.test(x) && k + 1 < span.to && LOWER.test(s[k + 1]!)));
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
