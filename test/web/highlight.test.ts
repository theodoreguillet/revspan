import { describe, expect, it, vi } from 'vitest';
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import type { DiffLine } from '../../src/shared/api.ts';
import {
    codeThemeFor, hunkCacheKey, languageOf, leadInLangs, lineTokens, mergeTokens, nextChunkSize, nextJob, partStyle, tokenizeHunk, withBands,
    type HunkTokens, type SideTokenizer,
} from '../../src/web/lib/highlight.ts';
import { cachedHunkTokens, highlightHunk, useCodeTheme } from '../../src/web/services/highlighter.ts';

const line = (t: DiffLine['t'], text: string, hl: [number, number][] = []): DiffLine => ({ t, o: null, n: null, text, hl });

const COMMENT = '#6A9955';
const KEYWORD = '#569CD6';

describe('mergeTokens', () => {
    it('mergeTokens keeps token colors and splits at hl ranges', () => {
        const tokens = [{ content: 'const', color: KEYWORD }, { content: ' a = ' }, { content: 'b', color: '#9CDCFE', fontStyle: 1 }, { content: ';' }];
        expect(mergeTokens('const a = b;', tokens, [[2, 4]])).toEqual([
            { text: 'co', color: KEYWORD, hl: false },
            { text: 'ns', color: KEYWORD, hl: true },
            { text: 't', color: KEYWORD, hl: false },
            { text: ' a = ', hl: false },
            { text: 'b', color: '#9CDCFE', italic: true, hl: false },
            { text: ';', hl: false },
        ]);
    });

    it('mergeTokens handles hl spanning two tokens', () => {
        const tokens = [{ content: 'foo', color: '#111111' }, { content: '.' }, { content: 'bar', color: '#222222', fontStyle: 2 }];
        expect(mergeTokens('foo.bar', tokens, [[1, 6]])).toEqual([
            { text: 'f', color: '#111111', hl: false },
            { text: 'oo', color: '#111111', hl: true },
            { text: '.', hl: true },
            { text: 'ba', color: '#222222', bold: true, hl: true },
            { text: 'r', color: '#222222', bold: true, hl: false },
        ]);
    });

    it('mergeTokens plain text without tokens', () => {
        expect(mergeTokens('abc', [], [])).toEqual([{ text: 'abc', hl: false }]);
        expect(mergeTokens('abc', [], [[1, 99]])).toEqual([{ text: 'a', hl: false }, { text: 'bc', hl: true }]);
        expect(mergeTokens('', [], [])).toEqual([]);
    });

    it('mergeTokens keeps a text the tokens do not cover (trailing \\r) and ignores tokens that do not match', () => {
        expect(mergeTokens('a;\r', [{ content: 'a', color: '#111111' }, { content: ';' }], [])).toEqual([
            { text: 'a', color: '#111111', hl: false }, { text: ';', hl: false }, { text: '\r', hl: false },
        ]);
        expect(mergeTokens('abc', [{ content: 'xyz', color: '#111111' }], [[0, 1]])).toEqual([{ text: 'a', hl: true }, { text: 'bc', hl: false }]);
    });

    it('withBands gathers the parts of each change range into one band, whatever their tokens', () => {
        const tokens = [{ content: 'call', color: '#111111' }, { content: '(' }, { content: 'a', color: '#222222' }, { content: ', ' }, { content: 'b', color: '#222222' }, { content: ');' }];
        const parts = mergeTokens('call(a, b);', tokens, [[0, 2], [6, 11]]);
        expect(withBands(parts)).toEqual([
            { band: [{ text: 'ca', color: '#111111', hl: true }] },
            { text: 'll', color: '#111111', hl: false },
            { text: '(', hl: false },
            { text: 'a', color: '#222222', hl: false },
            { band: [{ text: ', ', hl: true }, { text: 'b', color: '#222222', hl: true }, { text: ');', hl: true }] },
        ]);
        expect(withBands(mergeTokens('abc', [], []))).toEqual([{ text: 'abc', hl: false }]);
        expect(withBands([])).toEqual([]);
    });

    it('partStyle writes the inline style of a colored part, nothing for plain text', () => {
        expect(partStyle({ text: 'a', hl: false })).toBeUndefined();
        expect(partStyle({ text: 'a', color: '#123456', italic: true, bold: true, hl: true })).toBe('color:#123456;font-style:italic;font-weight:bold');
    });
});

describe('languageOf', () => {
    it('languageOf maps extensions and special names, unknown → null', () => {
        expect(languageOf('src/web/App.ts')).toBe('typescript');
        expect(languageOf('src/web/App.TSX')).toBe('tsx');
        expect(languageOf('bin/revspan.mjs')).toBe('javascript');
        expect(languageOf('a/b.cjs')).toBe('javascript');
        expect(languageOf('src/web/components/DiffCode.vue')).toBe('vue');
        expect(languageOf('config.yml')).toBe('yaml');
        expect(languageOf('README.md')).toBe('markdown');
        expect(languageOf('scripts/run.sh')).toBe('shellscript');
        expect(languageOf('Program.cs')).toBe('csharp');
        expect(languageOf('main.rs')).toBe('rust');
        expect(languageOf('deploy/Dockerfile')).toBe('docker');
        expect(languageOf('Makefile')).toBe('make');
        expect(languageOf('notes.txt')).toBeNull();
        expect(languageOf('LICENSE')).toBeNull();
        expect(languageOf('.gitignore')).toBeNull();
    });
});

describe('codeThemeFor', () => {
    const classes = (...names: string[]): Pick<DOMTokenList, 'contains'> => ({ contains: (c: string) => names.includes(c) });

    it('follows the VS Code body class, else the browser color scheme', () => {
        expect(codeThemeFor(classes('vscode-dark'), false)).toBe('dark-plus');
        expect(codeThemeFor(classes('vscode-high-contrast'), false)).toBe('dark-plus');
        expect(codeThemeFor(classes('vscode-light'), true)).toBe('light-plus');
        expect(codeThemeFor(classes('vscode-high-contrast', 'vscode-high-contrast-light'), true)).toBe('light-plus');
        expect(codeThemeFor(classes(), true)).toBe('dark-plus');
        expect(codeThemeFor(classes(), false)).toBe('light-plus');
    });
});

describe('useCodeTheme', () => {
    it('follows the theme changes of VS Code on the body class', async () => {
        const theme = useCodeTheme();
        expect(theme.value).toBe('light-plus');
        document.body.classList.add('vscode-dark');
        await vi.waitFor(() => expect(theme.value).toBe('dark-plus'));
        document.body.classList.replace('vscode-dark', 'vscode-light');
        await vi.waitFor(() => expect(theme.value).toBe('light-plus'));
        document.body.classList.remove('vscode-light');
    });
});

describe('tokenizeHunk', () => {
    it('tokenizeHunk maps a multi-line comment back to its lines', async () => {
        const highlighter = await createHighlighterCore({
            themes: [import('shiki/themes/dark-plus.mjs')],
            langs: [import('shiki/langs/typescript.mjs')],
            engine: createJavaScriptRegexEngine(),
        });
        const lines = [
            line(' ', '/* start'),
            line('-', 'removed'),
            line('+', 'added'),
            line(' ', 'end */'),
            line('+', 'const x = 1;'),
            line('-', 'let y;'),
        ];
        const tokens = await tokenizeHunk(lines, async (code) => highlighter.codeToTokens(code.join('\n'), { lang: 'typescript', theme: 'dark-plus' }).tokens);
        const colors = (index: number, side: 'old' | 'new'): (string | undefined)[] => (lineTokens(tokens, index, side) ?? []).map((t) => t.color);

        expect(colors(1, 'old')).toEqual([COMMENT]);
        expect(colors(2, 'new')).toEqual([COMMENT]);
        expect(colors(3, 'old')).toEqual([COMMENT]);
        expect(colors(3, 'new')).toEqual([COMMENT]);
        expect(lineTokens(tokens, 4, 'new')?.[0]).toMatchObject({ content: 'const', color: KEYWORD });
        // old side: "let y;" comes after "end */", outside the comment
        expect(lineTokens(tokens, 5, 'old')?.[0]).toMatchObject({ content: 'let', color: KEYWORD });
        // a line only exists on its own side
        expect(lineTokens(tokens, 1, 'new')).toBeUndefined();
        expect(lineTokens(tokens, 2, 'old')).toBeUndefined();
        expect(lineTokens(null, 0, 'new')).toBeUndefined();
    });
});

describe('tokenizeHunk with a lead-in', () => {
    const TYPE = '#4EC9B0';
    const vue = createHighlighterCore({
        themes: [import('shiki/themes/dark-plus.mjs')],
        langs: [import('shiki/langs/vue.mjs')],
        engine: createJavaScriptRegexEngine(),
    });
    const tokenize: SideTokenizer = async (code) => (await vue).codeToTokens(code.join('\n'), { lang: 'vue', theme: 'dark-plus' }).tokens;
    const colorOf = (tokens: HunkTokens, index: number, side: 'old' | 'new', content: string): string | undefined =>
        lineTokens(tokens, index, side)?.find((t) => t.content === content)?.color;
    const SCRIPT = '<script setup lang="ts">';

    it('tokenizeHunk reads a Vue hunk inside <script setup> as TypeScript and drops the lead-in\'s tokens', async () => {
        const lines = [line(' ', 'const count = ref<number>(0);'), line('-', 'const total = 1;'), line('+', 'const total = 2;')];

        // the bug: alone, the hunk is template text (`const` not a keyword) and `ref<number>` even an HTML tag
        const alone = await tokenizeHunk(lines, tokenize);
        expect(lineTokens(alone, 0, 'new')?.[0]).toMatchObject({ content: 'const count = ref', color: '#D4D4D4' });
        expect(colorOf(alone, 0, 'new', 'number')).toBe(KEYWORD);

        const tokens = await tokenizeHunk(lines, tokenize, { old: SCRIPT, new: SCRIPT });
        expect(lineTokens(tokens, 0, 'new')?.map((t) => t.content).join('')).toBe('const count = ref<number>(0);');
        expect(colorOf(tokens, 0, 'new', 'const')).toBe(KEYWORD);
        expect(colorOf(tokens, 0, 'new', 'count')).toBe('#4FC1FF');
        expect(colorOf(tokens, 0, 'new', 'ref')).toBe('#DCDCAA');
        expect(colorOf(tokens, 0, 'new', 'number')).toBe(TYPE);
        expect(colorOf(tokens, 0, 'old', 'number')).toBe(TYPE);
        expect(colorOf(tokens, 1, 'old', 'const')).toBe(KEYWORD);
        expect(colorOf(tokens, 2, 'new', 'const')).toBe(KEYWORD);
        expect(lineTokens(tokens, 1, 'new')).toBeUndefined();

        // each side has its own lead-in
        const newOnly = await tokenizeHunk(lines, tokenize, { new: SCRIPT });
        expect(colorOf(newOnly, 2, 'new', 'const')).toBe(KEYWORD);
        expect(colorOf(newOnly, 1, 'old', 'const')).toBeUndefined();
    });

    it('a template line needs no lead-in: alone, its Vue directives keep their colors (inside <template> they would not)', async () => {
        const lines = [line('+', '    <li v-if="ok">{{ item }}</li>')];
        expect(colorOf(await tokenizeHunk(lines, tokenize), 0, 'new', 'v-if')).toBe('#C586C0');
        expect(colorOf(await tokenizeHunk(lines, tokenize, { new: '<template>' }), 0, 'new', 'v-if')).toBe('#9CDCFE');
    });

    it('hunkCacheKey tells the lead-ins apart', () => {
        const lines = [line('+', 'const a = 1;')];
        const keys = [
            hunkCacheKey(lines, 'vue', 'dark-plus'),
            hunkCacheKey(lines, 'vue', 'dark-plus', { new: SCRIPT }),
            hunkCacheKey(lines, 'vue', 'dark-plus', { old: SCRIPT }),
            hunkCacheKey(lines, 'vue', 'dark-plus', { old: SCRIPT, new: SCRIPT }),
            hunkCacheKey(lines, 'vue', 'dark-plus', { new: '<script lang="ts">' }),
        ];
        expect(new Set(keys).size).toBe(keys.length);
        expect(hunkCacheKey(lines, 'vue', 'dark-plus', {})).toBe(keys[0]);
    });

    it('leadInLangs gives the languages the lead-ins name, known ones only', () => {
        expect(leadInLangs({ old: '<style scoped lang="scss">', new: "<script setup lang='ts'>" })).toEqual(['scss', 'typescript']);
        expect(leadInLangs({ old: '<style lang="scss">', new: '<style lang="scss">' })).toEqual(['scss']);
        expect(leadInLangs({ new: '<style lang="stylus">' })).toEqual([]);
        expect(leadInLangs({ new: '<script setup>' })).toEqual([]);
        expect(leadInLangs(undefined)).toEqual([]);
    });
});

describe('nextChunkSize', () => {
    it('grows the chunks while they stay quick, shrinks them when one is slow', () => {
        expect(nextChunkSize(4, 1)).toBe(8);
        expect(nextChunkSize(128, 1)).toBe(128);
        expect(nextChunkSize(16, 10)).toBe(16);
        expect(nextChunkSize(16, 40)).toBe(8);
        expect(nextChunkSize(1, 90)).toBe(1);
    });
});

describe('nextJob', () => {
    it('runs the hunk closest to the window first, the oldest request when equal', () => {
        expect(nextJob([900, 0, 0, 40])).toBe(1);
        expect(nextJob([0, 0])).toBe(0);
        expect(nextJob([500, -1, 0])).toBe(1);
        expect(nextJob([7])).toBe(0);
    });
});

describe('highlighter service', () => {
    it('colors a TypeScript hunk with the theme, without the default text color, then serves it from the cache', async () => {
        const lines = [line(' ', '// note'), line('+', 'const label = "a";\r')];
        expect(cachedHunkTokens({ lines }, 'typescript', 'light-plus')).toBeUndefined();
        const tokens = await highlightHunk({ lines }, 'typescript', 'light-plus');
        expect(lineTokens(tokens, 0, 'new')?.[0]?.color).toBe('#008000');
        const added = lineTokens(tokens, 1, 'new') ?? [];
        expect(added[0]).toMatchObject({ content: 'const', color: '#0000FF' });
        // the default text of the theme takes the page color
        expect(added.find((t) => t.content.includes('='))?.color).toBeUndefined();
        expect(mergeTokens(lines[1]!.text, added, []).map((p) => p.text).join('')).toBe(lines[1]!.text);
        expect(cachedHunkTokens({ lines }, 'typescript', 'light-plus')).toBe(tokens);
        expect(cachedHunkTokens({ lines }, 'typescript', 'dark-plus')).toBeUndefined();
    });

    it('carries a multi-line comment across chunks of a long hunk', async () => {
        const lines = [line('+', '/*'), ...Array.from({ length: 300 }, (_, k) => line('+', `comment ${k}`)), line('+', '*/'), line('+', 'let z;')];
        const tokens = await highlightHunk({ lines }, 'typescript', 'dark-plus');
        expect(lineTokens(tokens, 250, 'new')?.[0]?.color).toBe(COMMENT);
        expect(lineTokens(tokens, 302, 'new')?.[0]).toMatchObject({ content: 'let', color: KEYWORD });
    });

    it('colors a Vue hunk with its lead-in (the block\'s grammar loaded), cached apart from the same lines without it', async () => {
        const lines = [line(' ', '.record-list {'), line('+', '    margin: 0;'), line(' ', '}')];
        const hunk = { lines, leadIn: { old: '<style scoped lang="scss">', new: '<style scoped lang="scss">' } };
        const tokens = await highlightHunk(hunk, 'vue', 'dark-plus');
        expect(lineTokens(tokens, 1, 'new')?.find((t) => t.content === 'margin')?.color).toBe('#9CDCFE');
        expect(lineTokens(tokens, 0, 'old')?.[0]).toMatchObject({ content: '.record-list', color: '#D7BA7D' });
        expect(cachedHunkTokens(hunk, 'vue', 'dark-plus')).toBe(tokens);
        expect(cachedHunkTokens({ lines }, 'vue', 'dark-plus')).toBeUndefined();
    });

    it('leaves very large hunks plain', async () => {
        const lines = Array.from({ length: 2001 }, (_, k) => line('+', `const a${k} = ${k};`));
        expect(await highlightHunk({ lines }, 'typescript', 'dark-plus')).toBeNull();
    });

    it('colors the hunk closest to the window before those requested earlier', async () => {
        const order: string[] = [];
        const far = [line('+', 'const far = 1;')];
        const near = [line('+', 'const near = 2;')];
        const other = [line('+', 'const other = 3;')];
        // the first request starts at once; the two others wait, and the nearest one goes first
        const first = highlightHunk({ lines: other }, 'typescript', 'light-plus', undefined, () => 0).then(() => order.push('other'));
        const late = highlightHunk({ lines: far }, 'typescript', 'light-plus', undefined, () => 5000).then(() => order.push('far'));
        const soon = highlightHunk({ lines: near }, 'typescript', 'light-plus', undefined, () => 0).then(() => order.push('near'));
        await Promise.all([first, late, soon]);
        expect(order).toEqual(['other', 'near', 'far']);
    });

    it('stops when the request is aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        expect(await highlightHunk({ lines: [line('+', 'const b = 2;')] }, 'typescript', 'dark-plus', controller.signal)).toBeNull();
    });
});
