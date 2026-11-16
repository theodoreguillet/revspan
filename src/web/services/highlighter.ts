// Syntax highlighting with shiki, loaded on first use: JavaScript regex engine (no WASM, fits the page CSP), the two
// default VS Code themes, one lazy chunk per language. Tokenizing runs one hunk at a time and yields to the page.
import { computed, ref, type ComputedRef } from 'vue';
import type { GrammarState, HighlighterCore, LanguageRegistration, ThemeRegistration } from 'shiki/core';
import type { DiffLine } from '../../shared/api.ts';
import {
    FIRST_CHUNK_LINES, MAX_HIGHLIGHT_LINES, codeThemeFor, hunkCacheKey, nextChunkSize, tokenizeHunk, type CodeTheme, type CodeToken, type HunkTokens, type SideTokenizer,
} from '../lib/highlight.ts';

type LangModule = Promise<{ default: LanguageRegistration[] }>;

// Literal imports: Vite emits one lazy chunk per grammar (embedded grammars are shared chunks).
const LANGS: Record<string, () => LangModule> = {
    typescript: () => import('shiki/langs/typescript.mjs'),
    tsx: () => import('shiki/langs/tsx.mjs'),
    javascript: () => import('shiki/langs/javascript.mjs'),
    jsx: () => import('shiki/langs/jsx.mjs'),
    vue: () => import('shiki/langs/vue.mjs'),
    json: () => import('shiki/langs/json.mjs'),
    yaml: () => import('shiki/langs/yaml.mjs'),
    markdown: () => import('shiki/langs/markdown.mjs'),
    css: () => import('shiki/langs/css.mjs'),
    scss: () => import('shiki/langs/scss.mjs'),
    html: () => import('shiki/langs/html.mjs'),
    python: () => import('shiki/langs/python.mjs'),
    java: () => import('shiki/langs/java.mjs'),
    go: () => import('shiki/langs/go.mjs'),
    rust: () => import('shiki/langs/rust.mjs'),
    shellscript: () => import('shiki/langs/shellscript.mjs'),
    php: () => import('shiki/langs/php.mjs'),
    ruby: () => import('shiki/langs/ruby.mjs'),
    kotlin: () => import('shiki/langs/kotlin.mjs'),
    csharp: () => import('shiki/langs/csharp.mjs'),
    sql: () => import('shiki/langs/sql.mjs'),
    xml: () => import('shiki/langs/xml.mjs'),
    docker: () => import('shiki/langs/docker.mjs'),
    make: () => import('shiki/langs/make.mjs'),
};

const THEMES: Record<CodeTheme, () => Promise<{ default: ThemeRegistration }>> = {
    'dark-plus': () => import('shiki/themes/dark-plus.mjs'),
    'light-plus': () => import('shiki/themes/light-plus.mjs'),
};

/** Work time after which the next chunk waits for the page (rendering, input). */
const SLICE_MS = 12;
/** Lines longer than this stay plain, like VS Code's tokenization limit. */
const MAX_LINE_LENGTH = 5000;
const CACHE_SIZE = 400;

let core: Promise<HighlighterCore> | null = null;
const loads = new Map<string, Promise<void>>();
const cache = new Map<string, HunkTokens>();
let queue: Promise<unknown> = Promise.resolve();
let sliceStart = 0;
let warned = false;

function highlighter(): Promise<HighlighterCore> {
    core ??= Promise.all([import('shiki/core'), import('shiki/engine/javascript')])
        .then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
            createHighlighterCore({ themes: [], langs: [], engine: createJavaScriptRegexEngine() }));
    return core;
}

function loadOnce(key: string, load: () => Promise<void>): Promise<void> {
    let loading = loads.get(key);
    if (!loading) {
        loading = load();
        loads.set(key, loading);
    }
    return loading;
}

async function ready(lang: string, theme: CodeTheme): Promise<HighlighterCore> {
    const hl = await highlighter();
    await Promise.all([
        loadOnce(`theme:${theme}`, () => hl.loadTheme(THEMES[theme]())),
        loadOnce(`lang:${lang}`, () => hl.loadLanguage(LANGS[lang]!())),
    ]);
    return hl;
}

/** Gives the page a turn (rendering, input) once the current work slice is used up, between hunks too. */
async function yieldIfBusy(): Promise<void> {
    if (performance.now() - sliceStart > SLICE_MS) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        sliceStart = performance.now();
    }
}

class Aborted extends Error {}

function sideTokenizer(hl: HighlighterCore, lang: string, theme: CodeTheme, signal: AbortSignal | undefined): SideTokenizer {
    // the theme's default text color is left out: that text takes the page color
    const fg = hl.getTheme(theme).fg.toLowerCase();
    return async (code) => {
        const out: CodeToken[][] = [];
        let grammarState: GrammarState | undefined;
        let size = FIRST_CHUNK_LINES;
        for (let i = 0; i < code.length;) {
            await yieldIfBusy();
            if (signal?.aborted) {
                throw new Aborted();
            }
            // chunks of lines, the grammar state carried from one to the next
            const start = performance.now();
            const result = hl.codeToTokens(code.slice(i, i + size).join('\n'), { lang, theme, grammarState, tokenizeMaxLineLength: MAX_LINE_LENGTH });
            i += size;
            size = nextChunkSize(size, performance.now() - start);
            grammarState = result.grammarState;
            for (const line of result.tokens) {
                out.push(line.map((t) => ({
                    content: t.content,
                    color: t.color && t.color.toLowerCase() !== fg ? t.color : undefined,
                    fontStyle: t.fontStyle || undefined,
                })));
            }
        }
        return out;
    };
}

function remember(key: string, tokens: HunkTokens): void {
    cache.delete(key);
    cache.set(key, tokens);
    if (cache.size > CACHE_SIZE) {
        cache.delete(cache.keys().next().value!);
    }
}

/** Tokens already computed for this hunk content, language and theme (no work started). */
export function cachedHunkTokens(lines: readonly DiffLine[], lang: string, theme: CodeTheme): HunkTokens | undefined {
    return cache.get(hunkCacheKey(lines, lang, theme));
}

/**
 * Tokens of a hunk, computed in the background (one hunk at a time, yielding to the page between chunks).
 * null: stays plain (unknown language, hunk too large, aborted, or shiki could not load).
 */
export function highlightHunk(lines: readonly DiffLine[], lang: string, theme: CodeTheme, signal?: AbortSignal): Promise<HunkTokens | null> {
    if (lines.length > MAX_HIGHLIGHT_LINES || !LANGS[lang] || signal?.aborted) {
        return Promise.resolve(null);
    }
    const key = hunkCacheKey(lines, lang, theme);
    const hit = cache.get(key);
    if (hit) {
        return Promise.resolve(hit);
    }
    const job = queue.then(async (): Promise<HunkTokens | null> => {
        const done = cache.get(key);
        if (done || signal?.aborted) {
            return done ?? null;
        }
        const hl = await ready(lang, theme);
        const tokens = await tokenizeHunk(lines, sideTokenizer(hl, lang, theme, signal));
        remember(key, tokens);
        return tokens;
    }).catch((error: unknown) => {
        if (!(error instanceof Aborted) && !warned) {
            warned = true;
            console.warn('Revspan: syntax highlighting unavailable', error);
        }
        return null;
    });
    queue = job;
    return job;
}

const theme = ref<CodeTheme>('light-plus');
let watchingTheme = false;

/** Code theme of the page, following VS Code theme changes (body class) or the browser color scheme. */
export function useCodeTheme(): ComputedRef<CodeTheme> {
    if (!watchingTheme && typeof document !== 'undefined') {
        watchingTheme = true;
        const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
        const update = (): void => {
            theme.value = codeThemeFor(document.body.classList, media?.matches ?? false);
        };
        update();
        media?.addEventListener('change', update);
        new MutationObserver(update).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
    return computed(() => theme.value);
}
