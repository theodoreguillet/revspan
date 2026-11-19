// Go to definition, level 1 (no language server, no request): the identifier under the pointer, its definition among
// the lines of the displayed comparison found by a small pattern table per language family, else its import in the
// same file, and the file of the PR that import points to.
import type { DiffLine, FileDiff } from '../../shared/api.ts';
import { languageOf } from './highlight.ts';

/** Languages sharing the same definition syntax. */
export type CodeFamily = 'js' | 'python' | 'other';

const FAMILY_BY_LANG: Readonly<Record<string, CodeFamily>> = {
    typescript: 'js', tsx: 'js', javascript: 'js', jsx: 'js', vue: 'js',
    python: 'python',
    java: 'other', kotlin: 'other', csharp: 'other', go: 'other', rust: 'other', php: 'other', ruby: 'other',
};

/** Family of a file from its path; null: no definition to look for (JSON, Markdown, CSS, shell...). */
export function familyOf(path: string): CodeFamily | null {
    const lang = languageOf(path);
    return lang ? FAMILY_BY_LANG[lang] ?? null : null;
}

const wordSet = (list: string): ReadonlySet<string> => new Set(list.split(' '));

/** Keywords and built-in types: never a symbol to look for, even on a line without syntax colors. */
const KEYWORDS: Readonly<Record<CodeFamily, ReadonlySet<string>>> = {
    js: wordSet('abstract any as async await bigint boolean break case catch class const continue debugger declare default '
        + 'delete do else enum export extends false finally for function if implements import in infer instanceof interface is '
        + 'keyof let namespace never new null number private protected public readonly return satisfies static string super '
        + 'switch symbol this throw true try typeof undefined unknown var void while with yield'),
    python: wordSet('and as assert async await break class continue def del elif else except False finally for from global if '
        + 'import in is lambda None nonlocal not or pass raise return self True try while with yield'),
    other: wordSet('abstract bool boolean break byte case catch char class const continue def default defer do double else '
        + 'end enum extends false final finally float fn for func fun function go if impl implements import in int interface is '
        + 'let long mod module mut new nil null object override package private protected pub public return self Self short '
        + 'static string struct super switch this throw throws trait true try type use val var void when where while'),
};

/**
 * Token colors of the two themes of the page (shiki Dark+ and Light+) that are never symbols: strings, comments,
 * regular expressions, numbers and keywords (the same keyword color covers `this`, `true`, HTML tags...).
 */
const NOT_SYMBOL_COLORS: ReadonlySet<string> = new Set([
    '#CE9178', '#6A9955', '#D16969', '#646695', '#B5CEA8', '#569CD6', '#C586C0', '#D7BA7D',
    '#A31515', '#008000', '#811F3F', '#098658', '#0000FF', '#AF00DB', '#EE0000',
    // shiki writes them in capitals; the lower case too, so that no token is converted on each render
].flatMap((color) => [color, color.toLowerCase()]));

const ID_CHAR = /[\p{L}\p{N}_$]/u;
const WHOLE_ID = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;
/** Before / after a name: no identifier character (and, before a definition, no dot: `x.name` is a use). */
const BEFORE_NAME = '(?<![\\p{L}\\p{N}_$])';
const BEFORE = '(?<![\\p{L}\\p{N}_$.])';
const AFTER = '(?![\\p{L}\\p{N}_$])';

const isSymbolName = (name: string, family: CodeFamily): boolean => WHOLE_ID.test(name) && !KEYWORDS[family].has(name);

/** An identifier of a line: [start, end[. */
export interface Word {
    name: string;
    start: number;
    end: number;
}

/**
 * The identifier at a caret offset of a line (the pointer on either half of a character: the character after the
 * caret, else the one before), or null on punctuation, a number or a keyword.
 */
export function identifierAt(text: string, offset: number, family: CodeFamily): Word | null {
    if (offset < 0 || offset > text.length) {
        return null;
    }
    const isId = (k: number): boolean => k >= 0 && k < text.length && ID_CHAR.test(text[k]!);
    const at = isId(offset) ? offset : offset - 1;
    if (!isId(at)) {
        return null;
    }
    let start = at;
    while (isId(start - 1)) {
        start--;
    }
    let end = at + 1;
    while (isId(end)) {
        end++;
    }
    const name = text.slice(start, end);
    return isSymbolName(name, family) ? { name, start, end } : null;
}

/**
 * Class of a colored syntax token: 'sym' for a whole identifier (underlined while the modifier is held), 'nosym' for a
 * string, a comment, a number or a keyword (a click there never looks for a definition), none otherwise.
 */
export function tokenClass(text: string, color: string | undefined, family: CodeFamily | null): 'sym' | 'nosym' | undefined {
    if (!family || !color) {
        return undefined;
    }
    if (NOT_SYMBOL_COLORS.has(color)) {
        return 'nosym';
    }
    return isSymbolName(text, family) ? 'sym' : undefined;
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lines skipped by the definition search: comments, imports. */
const COMMENT_LINE: Readonly<Record<CodeFamily, RegExp>> = {
    js: /^\s*(?:\/\/|\/\*|\*(?:\s|\/|$))/,
    python: /^\s*#/,
    other: /^\s*(?:\/\/|\/\*|\*(?:\s|\/|$)|#)/,
};
const IMPORT_LINE: Readonly<Record<CodeFamily, RegExp>> = {
    js: /^\s*import\b|^\s*export\b[^=]*\bfrom\s*['"]|\brequire\s*\(\s*['"]/,
    python: /^\s*(?:from\s+\S+\s+)?import\b/,
    other: /^\s*(?:import|use|using|package|require|include)\b/,
};

const isQuote = (c: string): boolean => c === '\'' || c === '"' || c === '`';
/** Characters a backslash cannot escape (`.` of a regex does not match them). */
const isLineBreak = (c: string | undefined): boolean => c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';

/**
 * End of the string literal opened by the quote at `open`: `closed` with the index of its closing quote, or not closed
 * with the index where the scan stopped (the end of the line, or a backslash before a line break).
 */
function stringEnd(text: string, open: number): { closed: boolean; at: number } {
    const quote = text[open];
    let i = open + 1;
    while (i < text.length) {
        const c = text[i];
        if (c === quote) {
            return { closed: true, at: i };
        }
        if (c === '\\') {
            if (i + 1 >= text.length || isLineBreak(text[i + 1])) {
                return { closed: false, at: i };
            }
            i += 2;
        } else {
            i++;
        }
    }
    return { closed: false, at: i };
}

/**
 * A line with its strings emptied ('', "", ``; escapes included; the quotes stay): a quoted name is neither defined nor
 * imported there. A quote left open stays as is and the scan goes on after it, as a regex would. Linear time: a quote
 * of a kind already found open up to some place opens nothing before that place either (the scan from it would read
 * the same characters the same way), so a line full of escaped quotes left open is read once.
 */
export function emptyStrings(text: string): string {
    /** Per quote kind: where the scan of a string of that kind left open stopped. */
    const openUntil = new Map<string, number>();
    let out = '';
    let copied = 0;
    for (let i = 0; i < text.length; i++) {
        const quote = text[i]!;
        if (!isQuote(quote) || i < (openUntil.get(quote) ?? -1)) {
            continue;
        }
        const end = stringEnd(text, i);
        if (!end.closed) {
            openUntil.set(quote, end.at);
            continue;
        }
        out += text.slice(copied, i) + quote + quote;
        copied = end.at + 1;
        i = end.at;
    }
    return out + text.slice(copied);
}

/** Longer lines (minified code, data) are not matched: some patterns cost more than linear time on them. */
export const MAX_PATTERN_LINE = 2000;

/** A line without its string contents and trailing comment: a name quoted or commented is not defined there. */
function codeOf(text: string, family: CodeFamily): string {
    const bare = emptyStrings(text).replace(/\/\*.*?\*\//g, '');
    return family === 'python' ? bare.replace(/#.*$/, '') : bare.replace(/\/\/.*$/, '');
}

/**
 * Definition patterns of a name, per family:
 * - js (TS, JS, Vue): `class|interface|type|enum|namespace|module|const|let|var|function|function*` + name; a class
 *   member after a modifier (`private name(`, `get name(`, `static name =`...); a method `name(...) {`; a property set
 *   to a function (`name = (...) =>`, `name: function`).
 * - python: `def name`, `class name`, `name =` at the start of the line (module level).
 * - other (Java, Kotlin, C#, Go, Rust, PHP, Ruby): `class|interface|enum|record|struct|trait|object|type|module|fun|
 *   func|fn|def|function|val|var|let|const` + name (Go receiver, Kotlin extension, Ruby `self.` allowed); a field after a
 *   modifier; in Java and C# only (see signaturePattern), a method signature `Type name(`.
 */
function definitionPatterns(name: string, family: CodeFamily): RegExp[] {
    const n = escapeRe(name);
    switch (family) {
        case 'js': {
            const params = '\\((?:[^()]|\\([^()]*\\))*\\)';
            return [
                new RegExp(`${BEFORE}(?:(?:class|interface|type|enum|namespace|module|const|let|var)\\s+|function(?:\\s*\\*\\s*|\\s+))${n}${AFTER}`, 'u'),
                new RegExp(`^\\s*(?:(?:public|private|protected|static|readonly|abstract|override|async|declare|accessor|get|set)\\s+)+(?:\\*\\s*)?${n}\\s*[?!]?\\s*[(<:=;]`, 'u'),
                new RegExp(`^\\s*(?:\\*\\s*)?${n}\\s*(?:<[^>]*>)?\\s*${params}\\s*(?::[^{};=]*)?\\{\\s*$`, 'u'),
                new RegExp(`^\\s*${n}\\s*[?!]?\\s*(?::[^=]*?)?[:=]\\s*(?:async\\s+)?(?:function\\b|${params}\\s*(?::[^=]*?)?=>|[\\p{L}_$][\\p{L}\\p{N}_$]*\\s*=>)`, 'u'),
            ];
        }
        case 'python':
            return [
                new RegExp(`^\\s*(?:async\\s+)?def\\s+${n}${AFTER}`, 'u'),
                new RegExp(`^\\s*class\\s+${n}${AFTER}`, 'u'),
                new RegExp(`^${n}\\s*(?::[^=]+)?=(?!=)`, 'u'),
            ];
        case 'other':
            return [
                new RegExp(`${BEFORE}(?:class|interface|enum|record|struct|trait|object|typealias|type|module|mod|fun|func|fn|def|function|val|var|let|const)\\s+(?:mut\\s+)?(?:<[^>]*>\\s*)?(?:\\([^)]*\\)\\s*)?(?:[\\p{L}\\p{N}_]+\\.)?${n}${AFTER}`, 'u'),
                new RegExp(`^\\s*(?:(?:public|private|protected|internal|static|final|readonly|const|override|open|lateinit|volatile|transient)\\s+)+${TYPE_WORD}\\s+${n}\\s*[=;{]`, 'u'),
            ];
    }
}

/** A type or modifier word of the `other` family (generics, arrays, nullable, annotation). */
const TYPE_WORD = '@?[\\p{L}\\p{N}_<>\\[\\],.?]+';

/**
 * Languages whose methods are declared without a keyword (`Type name(`). Elsewhere a word before a call is a call
 * (Ruby `assert_equal valid(x), y`, Kotlin infix `a to valid(x)`), so the signature pattern stays off.
 */
const SIGNATURE_LANGS: ReadonlySet<string> = new Set(['java', 'csharp']);
const hasSignatures = (path: string): boolean => SIGNATURE_LANGS.has(languageOf(path) ?? '');

/**
 * Method signature `Type name(`: the first word is a type or a modifier, never a statement keyword (`return valid(x);`,
 * or paren-less control flow `if valid(x) {` calls `valid`).
 */
const signaturePattern = (name: string): RegExp => new RegExp(`^\\s*(?!(?:${NOT_A_TYPE})\\b)(?:${TYPE_WORD}\\s+)+${escapeRe(name)}\\s*(?:<[^>]*>)?\\s*\\(`, 'u');

/** Words that start a statement, not a method signature `Type name(`: calls follow them. */
const NOT_A_TYPE = ['return', 'new', 'throw', 'else', 'await', 'yield', 'go', 'defer', 'case', 'echo', 'print', 'puts',
    'raise', 'assert', 'not', 'and', 'or', 'in', 'is', 'when', 'using', 'if', 'elif', 'elsif', 'unless', 'until', 'while',
    'for', 'foreach', 'switch', 'match', 'select', 'loop', 'catch', 'lock', 'with', 'guard', 'do', 'try'].join('|');

/** Tests the lines of a file (`path`) for a definition of `name` (patterns compiled once per search). */
function definitionMatcher(name: string, family: CodeFamily): (text: string, path: string) => boolean {
    const patterns = definitionPatterns(name, family);
    const signature = family === 'other' ? signaturePattern(name) : null;
    return (text, path) => {
        if (text.length > MAX_PATTERN_LINE || !text.includes(name) || COMMENT_LINE[family].test(text) || IMPORT_LINE[family].test(text)) {
            return false;
        }
        const code = codeOf(text, family);
        return patterns.some((re) => re.test(code)) || (signature !== null && hasSignatures(path) && signature.test(code));
    };
}

/** True if the line, in the file `path`, defines `name`. */
export function definesSymbol(text: string, name: string, path: string): boolean {
    const family = familyOf(path);
    return family !== null && definitionMatcher(name, family)(text, path);
}

/** A line of the displayed comparison: file (index and path), hunk, index in the hunk and the side it is read on. */
export interface LineRef {
    fileIdx: number;
    path: string;
    hunk: number;
    index: number;
    side: 'old' | 'new';
    line: DiffLine;
}

type FileLines = Pick<FileDiff, 'path' | 'hunks'>;

/** Lines of the new side (context and added), or the removed lines. */
const onSide = (line: DiffLine, side: 'old' | 'new'): boolean => (side === 'new' ? line.t !== '-' : line.t === '-');

/**
 * Definitions of `name` in the displayed lines of the files of the same family as the clicked one (`from`), or of
 * the file `only`: the new side (context and added lines) first, the removed lines only when the new side has none;
 * the clicked file first, then the others in list order.
 */
export function findDefinitions(files: readonly FileLines[], name: string, from: number, only?: string): LineRef[] {
    const family = files[from] ? familyOf(files[from].path) : null;
    if (!family) {
        return [];
    }
    const defines = definitionMatcher(name, family);
    const order = [from, ...files.keys()].filter((idx, k) => (k === 0 || idx !== from)
        && (only === undefined ? familyOf(files[idx]!.path) === family : files[idx]!.path === only));
    for (const side of ['new', 'old'] as const) {
        const refs: LineRef[] = [];
        for (const fileIdx of order) {
            const file = files[fileIdx]!;
            file.hunks.forEach((hunk, h) => hunk.lines.forEach((line, index) => {
                if (onSide(line, side) && defines(line.text, file.path)) {
                    refs.push({ fileIdx, path: file.path, hunk: h, index, side, line });
                }
            }));
        }
        if (refs.length) {
            return refs;
        }
    }
    return [];
}

/** A line of an import statement: the path it imports from (null: not resolvable) and the names it binds. */
interface ImportPart {
    spec: string | null;
    names: string;
}

const JS_SPEC = /(?:\bfrom\s*|\brequire\s*\(\s*)(['"])([^'"]+)\1/;
const JS_STATEMENT = /^\s*(?:import|export)\b|^\s*(?:const|let|var)\b[^=]*=\s*require\s*\(|^\s*(?:const|let|var)\s*\{/;
/**
 * A name list left open at the end of the line: `import {`, `import type {`, `import Foo, {`, `export {` (re-export) or
 * `const {` (require). Not `export function x() {` nor `export default {`: their braces hold code.
 */
const JS_OPEN_LIST = /^\s*(?:import\b[^'"=(]*|export\s+(?:type\s+)?|(?:const|let|var)\s*)\{[^}]*$/;
const JS_MEMBER = /^\s*(?:type\s+)?[\p{L}_$][\p{L}\p{N}_$]*(?:\s+as\s+[\p{L}_$][\p{L}\p{N}_$]*)?\s*,?\s*$/u;
/** A multi-line statement longer than this is not an import list (an unclosed brace, a cut hunk). */
const MAX_IMPORT_LINES = 80;

const beforeSpec = (text: string): string => emptyStrings(text.replace(/(?:\bfrom|\brequire)\b.*$/, ''));

/** Import lines of a run of consecutive lines (one side of a hunk), TS / JS. */
function jsImports(texts: readonly string[]): (ImportPart | null)[] {
    const out: (ImportPart | null)[] = texts.map(() => null);
    let open = -1;
    texts.forEach((text, i) => {
        const spec = JS_SPEC.exec(text)?.[2] ?? null;
        if (open >= 0) {
            if (text.includes('}') || i - open > MAX_IMPORT_LINES) {
                if (spec !== null) {
                    for (let k = open; k <= i; k++) {
                        out[k] = { spec, names: beforeSpec(texts[k]!) };
                    }
                }
                open = -1;
            }
            return;
        }
        if (JS_STATEMENT.test(text)) {
            if (spec !== null) {
                out[i] = { spec, names: beforeSpec(text) };
            } else if (JS_OPEN_LIST.test(text)) {
                open = i;
            }
            return;
        }
        // a statement cut by the start of the hunk: member lines, then `} from '...'`
        if (spec !== null && /^\s*\}/.test(text)) {
            let k = i;
            while (k > 0 && JS_MEMBER.test(texts[k - 1]!) && !out[k - 1]) {
                k--;
            }
            for (let m = k; m <= i; m++) {
                out[m] = { spec, names: beforeSpec(texts[m]!) };
            }
        }
    });
    return out;
}

/** Import lines of a run of consecutive lines, Python: `from x import a, b` (or a parenthesized list), `import x`. */
function pythonImports(texts: readonly string[]): (ImportPart | null)[] {
    const out: (ImportPart | null)[] = texts.map(() => null);
    let open = -1;
    texts.forEach((text, i) => {
        if (open >= 0) {
            out[i] = { spec: null, names: emptyStrings(text.replace(/#.*$/, '')) };
            if (text.includes(')') || i - open > MAX_IMPORT_LINES) {
                open = -1;
            }
            return;
        }
        const from = /^\s*from\s+\S+\s+import\s+(.*)$/.exec(text);
        const plain = /^\s*import\s+(.*)$/.exec(text);
        const names = from?.[1] ?? plain?.[1];
        if (names !== undefined) {
            out[i] = { spec: null, names: names.replace(/#.*$/, '') };
            if (from && names.includes('(') && !names.includes(')')) {
                open = i;
            }
        }
    });
    return out;
}

/** Import lines, Java / Kotlin (`import a.b.Name`), PHP / Rust (`use`); Go imports only quoted paths: none bind a name. */
function otherImports(texts: readonly string[]): (ImportPart | null)[] {
    return texts.map((text) => {
        const match = /^\s*(?:import|use)\b(.*)$/.exec(text);
        return match ? { spec: null, names: emptyStrings(match[1]!) } : null;
    });
}

const IMPORTS: Readonly<Record<CodeFamily, (texts: readonly string[]) => (ImportPart | null)[]>> = {
    js: jsImports, python: pythonImports, other: otherImports,
};

/**
 * The import of `name` in a file, among its displayed lines: the new side first, then the removed lines. `spec` is the
 * imported path (TS / JS only), to look for the file of the PR it points to.
 */
export function findImport(file: FileLines, fileIdx: number, name: string): (LineRef & { spec: string | null }) | null {
    const family = familyOf(file.path);
    if (!family) {
        return null;
    }
    const named = new RegExp(`${BEFORE_NAME}${escapeRe(name)}${AFTER}`, 'u');
    for (const side of ['new', 'old'] as const) {
        for (const [h, hunk] of file.hunks.entries()) {
            // one side of the hunk read as consecutive lines (an import list spans several)
            const lines = hunk.lines.map((line, index) => ({ line, index })).filter(({ line }) => line.t !== (side === 'new' ? '-' : '+'));
            // a line too long for the patterns reads as empty, as for the definition search
            const parts = IMPORTS[family](lines.map(({ line }) => (line.text.length > MAX_PATTERN_LINE ? '' : line.text)));
            const at = parts.findIndex((part, k) => part !== null && onSide(lines[k]!.line, side) && named.test(part.names));
            if (at >= 0) {
                const { line, index } = lines[at]!;
                return { fileIdx, path: file.path, hunk: h, index, side, line, spec: parts[at]!.spec };
            }
        }
    }
    return null;
}

const IMPORT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.mjs', '.cjs'];

/**
 * File of the PR a relative TS / JS import points to: the path as is, with an extension, a `.js` written for a `.ts`
 * (ES modules in TypeScript), or a folder's `index.*`. Packages and aliases (`vue`, `@/x`): null.
 */
export function resolveImport(from: string, spec: string, paths: readonly string[]): string | null {
    if (!/^\.\.?(?:\/|$)/.test(spec)) {
        return null;
    }
    const parts = from.split('/').slice(0, -1);
    for (const segment of spec.split('/')) {
        if (segment === '..') {
            if (!parts.length) {
                return null;
            }
            parts.pop();
        } else if (segment !== '.' && segment !== '') {
            parts.push(segment);
        }
    }
    const base = parts.join('/');
    const stem = base.replace(/\.[mc]?jsx?$/, '');
    const candidates = [
        base,
        ...IMPORT_EXTENSIONS.map((ext) => base + ext),
        ...(stem !== base ? ['.ts', '.tsx', '.mts', '.cts'].map((ext) => stem + ext) : []),
        ...IMPORT_EXTENSIONS.map((ext) => `${base}/index${ext}`),
    ];
    const known = new Set(paths);
    return candidates.find((path) => known.has(path)) ?? null;
}

/** What a Ctrl/⌘+click on a name leads to. */
export type GotoResult =
    /** The clicked line is a definition of the name. */
    | { kind: 'none' }
    | { kind: 'jump'; target: LineRef }
    | { kind: 'choose'; targets: LineRef[] }
    /** No definition shown: its import in the same file (`here`: the clicked line), and the file of the PR it points to. */
    | { kind: 'import'; target: LineRef; file: string | null; here: boolean }
    | { kind: 'notFound' };

/** Definition of `name` clicked on `line` of the file `fileIdx`: see findDefinitions, then findImport. */
export function gotoDefinition(files: readonly FileLines[], name: string, clicked: { fileIdx: number; line: DiffLine }): GotoResult {
    const file = files[clicked.fileIdx];
    if (!file) {
        return { kind: 'notFound' };
    }
    const defs = findDefinitions(files, name, clicked.fileIdx);
    if (defs.some((ref) => ref.fileIdx === clicked.fileIdx && ref.line === clicked.line)) {
        return { kind: 'none' };
    }
    if (defs.length) {
        return defs.length === 1 ? { kind: 'jump', target: defs[0]! } : { kind: 'choose', targets: defs };
    }
    const imported = findImport(file, clicked.fileIdx, name);
    if (!imported) {
        return { kind: 'notFound' };
    }
    const { spec, ...target } = imported;
    const resolved = spec === null ? null : resolveImport(file.path, spec, files.map((f) => f.path));
    return { kind: 'import', target, file: resolved === file.path ? null : resolved, here: target.line === clicked.line };
}

/** A displayed line by its file, side and number (a context line is found from either side). */
export function findLine(files: readonly FileLines[], path: string, side: 'old' | 'new', number: number): LineRef | null {
    const fileIdx = files.findIndex((f) => f.path === path);
    const file = files[fileIdx];
    if (!file) {
        return null;
    }
    for (const [h, hunk] of file.hunks.entries()) {
        const index = hunk.lines.findIndex((line) => (side === 'new' ? line.t !== '-' && line.n === number : line.t !== '+' && line.o === number));
        if (index >= 0) {
            return { fileIdx, path, hunk: h, index, side, line: hunk.lines[index]! };
        }
    }
    return null;
}

/** Number of a line on the side it is read on. */
export const lineNumber = (ref: Pick<LineRef, 'side' | 'line'>): number => (ref.side === 'new' ? ref.line.n : ref.line.o) ?? 0;
