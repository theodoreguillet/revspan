// Syntax tokens of a hunk: none at first (the lines render plain), then the colors once computed in the background.
import { onBeforeUnmount, shallowRef, watch, type Ref } from 'vue';
import type { DiffLine } from '../../shared/api.ts';
import type { HunkTokens } from '../lib/highlight.ts';
import { cachedHunkTokens, highlightHunk, useCodeTheme } from '../services/highlighter.ts';

export function useHunkTokens(lines: () => readonly DiffLine[], lang: () => string | null, active: () => boolean): Readonly<Ref<HunkTokens | null>> {
    const theme = useCodeTheme();
    const tokens = shallowRef<HunkTokens | null>(null);
    let controller: AbortController | null = null;

    watch([lines, lang, active, theme], ([current, language, isActive, codeTheme]) => {
        controller?.abort();
        controller = null;
        if (!language || !isActive) {
            tokens.value = null;
            return;
        }
        // tokens of another content or theme would color wrong: plain until the right ones arrive
        tokens.value = cachedHunkTokens(current, language, codeTheme) ?? null;
        if (tokens.value) {
            return;
        }
        const request = new AbortController();
        controller = request;
        void highlightHunk(current, language, codeTheme, request.signal).then((result) => {
            if (!request.signal.aborted) {
                tokens.value = result;
            }
        });
    }, { immediate: true });

    onBeforeUnmount(() => controller?.abort());
    return tokens;
}
