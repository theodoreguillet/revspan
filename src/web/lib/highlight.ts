// Syntax highlighting rules: language of a path, theme, hunk tokenized per side, tokens merged with the change emphasis.
import type { DiffLine } from '../../shared/api.ts';
import { highlightParts } from './diff.ts';

/** A token as shiki gives it (color absent: default text color of the page). */
export interface CodeToken {
    content: string;
    color?: string;
    /** Bit flags of shiki: 1 italic, 2 bold, 4 underline. */
    fontStyle?: number;
}

/** A piece of a line: one token color, inside or outside a word-level change. */
export interface Part {
    text: string;
    color?: string;
    italic?: boolean;
    bold?: boolean;
    hl: boolean;
    /** Search match: 'cur' is the current one. */
    mark?: 'hit' | 'cur';
}

/** A search match to mark in a line: [start, end[. */
export interface TextMark {
    start: number;
    end: number;
    kind: 'hit' | 'cur';
}

export type CodeTheme = 'dark-plus' | 'light-plus';

/** Hunks longer than this stay plain (tokenizing them costs more than it helps). */
export const MAX_HIGHLIGHT_LINES = 2000;

/**
 * Lines per shiki call. A grammar compiles its rules the first time they match (up to ~100 ms for a line): small
 * chunks first, then larger ones while each stays quick, so that no chunk makes a long task.
 */
export const FIRST_CHUNK_LINES = 4;
const MAX_CHUNK_LINES = 128;
const QUICK_CHUNK_MS = 4;
const SLOW_CHUNK_MS = 16;

/** Size of the next chunk from the time the last one took. */
export function nextChunkSize(size: number, spentMs: number): number {
    if (spentMs < QUICK_CHUNK_MS) {
        return Math.min(size * 2, MAX_CHUNK_LINES);
    }
    return spentMs > SLOW_CHUNK_MS ? Math.max(1, Math.floor(size / 2)) : size;
}

/** Index of the job to run next: the lowest priority value, the first one when equal (aborted jobs give -1: dropped first). */
export function nextJob(priorities: readonly number[]): number {
    let best = 0;
    priorities.forEach((value, k) => {
        if (value < priorities[best]!) {
            best = k;
        }
    });
    return best;
}

const FONT_ITALIC = 1;
const FONT_BOLD = 2;

const LANG_BY_EXT: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', vue: 'vue',
    json: 'json', yaml: 'yaml', yml: 'yaml', md: 'markdown', css: 'css', scss: 'scss', html: 'html', py: 'python',
    java: 'java', go: 'go', rs: 'rust', sh: 'shellscript', php: 'php', rb: 'ruby', kt: 'kotlin', cs: 'csharp',
    sql: 'sql', xml: 'xml',
};

const LANG_BY_NAME: Record<string, string> = { Dockerfile: 'docker', Makefile: 'make' };

/** Shiki language of a file from its path; null: plain text, no grammar to load. */
export function languageOf(path: string): string | null {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const byName = LANG_BY_NAME[name];
    if (byName) {
        return byName;
    }
    const dot = name.lastIndexOf('.');
    if (dot <= 0) {
        return null;
    }
    return LANG_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** In VS Code the body class gives the editor theme kind; in a browser, the color scheme. */
export function codeThemeFor(bodyClasses: Pick<DOMTokenList, 'contains'>, prefersDark: boolean): CodeTheme {
    if (bodyClasses.contains('vscode-light') || bodyClasses.contains('vscode-high-contrast-light')) {
        return 'light-plus';
    }
    if (bodyClasses.contains('vscode-dark') || bodyClasses.contains('vscode-high-contrast')) {
        return 'dark-plus';
    }
    return prefersDark ? 'dark-plus' : 'light-plus';
}

interface Segment {
    text: string;
    token: CodeToken | null;
}

/** Tokens laid over the text; any mismatch makes the line plain, a text longer than the tokens ends plain. */
function tokenSegments(text: string, tokens: readonly CodeToken[]): Segment[] {
    const out: Segment[] = [];
    let pos = 0;
    for (const token of tokens) {
        if (!token.content) {
            continue;
        }
        if (!text.startsWith(token.content, pos)) {
            return [{ text, token: null }];
        }
        out.push({ text: token.content, token });
        pos += token.content.length;
    }
    if (pos < text.length) {
        out.push({ text: text.slice(pos), token: null });
    }
    return out;
}

function part(text: string, token: CodeToken | null, hl: boolean): Part {
    const out: Part = { text, hl };
    if (token?.color) {
        out.color = token.color;
    }
    if (token?.fontStyle && token.fontStyle & FONT_ITALIC) {
        out.italic = true;
    }
    if (token?.fontStyle && token.fontStyle & FONT_BOLD) {
        out.bold = true;
    }
    return out;
}

/**
 * Parts of a line: token colors, split at the boundaries of the word-level change ranges `hl`, then at the search
 * marks (sorted, not overlapping).
 */
export function mergeTokens(text: string, tokens: readonly CodeToken[], hl: readonly [number, number][], search: readonly TextMark[] = []): Part[] {
    if (!text) {
        return [];
    }
    const marks = highlightParts(text, hl);
    const segs = tokenSegments(text, tokens);
    const out: Part[] = [];
    let m = 0;
    let s = 0;
    let mOff = 0;
    let sOff = 0;
    while (m < marks.length && s < segs.length) {
        const mark = marks[m]!;
        const seg = segs[s]!;
        const len = Math.min(mark.text.length - mOff, seg.text.length - sOff);
        out.push(part(seg.text.slice(sOff, sOff + len), seg.token, mark.hl));
        mOff += len;
        sOff += len;
        if (mOff === mark.text.length) {
            m++;
            mOff = 0;
        }
        if (sOff === seg.text.length) {
            s++;
            sOff = 0;
        }
    }
    return search.length ? splitAtMarks(out, search) : out;
}

/** Cuts the parts at the boundaries of the marks and tags the pieces inside a mark. */
function splitAtMarks(parts: readonly Part[], marks: readonly TextMark[]): Part[] {
    const out: Part[] = [];
    let pos = 0;
    let m = 0;
    for (const p of parts) {
        const end = pos + p.text.length;
        let at = pos;
        while (at < end) {
            while (m < marks.length && marks[m]!.end <= at) {
                m++;
            }
            const mark = marks[m];
            const inside = !!mark && mark.start <= at;
            const stop = Math.min(end, !mark ? end : inside ? mark.end : mark.start);
            const piece: Part = { ...p, text: p.text.slice(at - pos, stop - pos) };
            if (inside) {
                piece.mark = mark.kind;
            }
            out.push(piece);
            at = stop;
        }
        pos = end;
    }
    return out;
}

/** Inline style of a part (undefined: plain text). */
export function partStyle(p: Part): string | undefined {
    const rules: string[] = [];
    if (p.color) {
        rules.push(`color:${p.color}`);
    }
    if (p.italic) {
        rules.push('font-style:italic');
    }
    if (p.bold) {
        rules.push('font-weight:bold');
    }
    return rules.length ? rules.join(';') : undefined;
}

/** Tokens of each hunk line, by index in `hunk.lines`, per side (a line exists on its side only). */
export interface HunkTokens {
    old: (readonly CodeToken[] | undefined)[];
    new: (readonly CodeToken[] | undefined)[];
}

/** Tokenizes the lines of one side as a single block of code: one token list per line. */
export type SideTokenizer = (code: readonly string[]) => Promise<readonly (readonly CodeToken[])[]>;

/**
 * Each side of the hunk is tokenized as one block (old: context + removed lines, new: context + added lines), so a
 * multi-line comment or string colors right; the tokens are then mapped back to the hunk lines.
 */
export async function tokenizeHunk(lines: readonly DiffLine[], tokenize: SideTokenizer): Promise<HunkTokens> {
    const out: HunkTokens = { old: new Array(lines.length), new: new Array(lines.length) };
    for (const side of ['old', 'new'] as const) {
        const skip = side === 'old' ? '+' : '-';
        const index: number[] = [];
        const code: string[] = [];
        lines.forEach((l, k) => {
            if (l.t !== skip) {
                index.push(k);
                // shiki would read a trailing \r as a line break: it stays plain at the end of the line
                code.push(l.text.endsWith('\r') ? l.text.slice(0, -1) : l.text);
            }
        });
        if (!code.length) {
            continue;
        }
        const tokens = await tokenize(code);
        if (tokens.length !== code.length) {
            continue;
        }
        index.forEach((k, i) => {
            out[side][k] = tokens[i];
        });
    }
    return out;
}

/** Tokens of the line `index` of a hunk on one side (undefined: plain). */
export function lineTokens(tokens: HunkTokens | null | undefined, index: number, side: 'old' | 'new'): readonly CodeToken[] | undefined {
    return tokens?.[side][index];
}

/** Cache key of a hunk's tokens: its content, language and theme. */
export function hunkCacheKey(lines: readonly DiffLine[], lang: string, theme: CodeTheme): string {
    return `${lang}\n${theme}\n${lines.map((l) => l.t + l.text).join('\n')}`;
}
