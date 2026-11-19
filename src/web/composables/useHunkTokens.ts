// Syntax tokens of a hunk: none at first (the lines render plain), then the colors once computed in the background.
import { onBeforeUnmount, shallowRef, watch, type Ref } from 'vue';
import type { HunkCode, HunkTokens } from '../lib/highlight.ts';
import { cachedHunkTokens, highlightHunk, useCodeTheme } from '../services/highlighter.ts';

/**
 * hunk: its lines and lead-ins (Vue or HTML block). distance: how far the hunk is from the window (px), so that the
 * hunks on screen get their colors first.
 */
export function useHunkTokens(
    hunk: () => HunkCode, lang: () => string | null, active: () => boolean, distance?: () => number,
): Readonly<Ref<HunkTokens | null>> {
    const theme = useCodeTheme();
    const tokens = shallowRef<HunkTokens | null>(null);
    let controller: AbortController | null = null;

    watch([() => hunk().lines, () => hunk().leadIn, lang, active, theme], ([lines, leadIn, language, isActive, codeTheme]) => {
        controller?.abort();
        controller = null;
        if (!language || !isActive) {
            tokens.value = null;
            return;
        }
        // tokens of another content or theme would color wrong: plain until the right ones arrive
        const current = { lines, leadIn };
        tokens.value = cachedHunkTokens(current, language, codeTheme) ?? null;
        if (tokens.value) {
            return;
        }
        const request = new AbortController();
        controller = request;
        void highlightHunk(current, language, codeTheme, request.signal, distance).then((result) => {
            if (!request.signal.aborted) {
                tokens.value = result;
            }
        });
    }, { immediate: true });

    onBeforeUnmount(() => controller?.abort());
    return tokens;
}
