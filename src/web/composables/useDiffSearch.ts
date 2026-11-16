// Search in the diff: the box text, the debounced query, the hits of the displayed comparison and the current hit.
import { computed, onScopeDispose, ref, watch, type ComputedRef } from 'vue';
import type { FileDiff } from '../../shared/api.ts';
import { fileNameMatches, findHits, MIN_QUERY, stepHit, type SearchHit } from '../lib/search.ts';

/** Delay between the last keystroke and the search. */
export const SEARCH_DEBOUNCE_MS = 150;

const NO_HITS: readonly SearchHit[] = Object.freeze([]);

export interface DiffSearchHooks {
    /** Shows the file of a hit (expanded, current) before its line is scrolled into view. */
    showFile: (fileIdx: number) => Promise<void>;
    /** Scrolls to the element of the current hit (registered by its line). */
    scrollToMatch: () => void;
}

export function useDiffSearch(files: ComputedRef<FileDiff[]>, hooks: DiffSearchHooks) {
    /** Text of the box, as typed. */
    const input = ref('');
    /** Text searched (the box text after the debounce). */
    const query = ref('');
    /** Current hit, kept by its place (a refreshed comparison with the same lines keeps it). */
    const target = ref<Pick<SearchHit, 'path' | 'hunk' | 'line' | 'start'> | null>(null);
    let box: HTMLInputElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    /** A new query starts before its first hit. */
    function applyQuery(text: string): void {
        clearTimeout(timer);
        if (text !== query.value) {
            query.value = text;
            target.value = null;
        }
    }

    watch(input, (text) => {
        clearTimeout(timer);
        timer = setTimeout(() => applyQuery(text.trim()), SEARCH_DEBOUNCE_MS);
    });
    onScopeDispose(() => clearTimeout(timer));

    const active = computed(() => query.value.length >= MIN_QUERY);
    const hits = computed(() => findHits(files.value, query.value));
    /** Hits of each file (index in `files`), in order. */
    const hitsByFile = computed(() => {
        const out = new Map<number, SearchHit[]>();
        for (const hit of hits.value) {
            const list = out.get(hit.fileIdx);
            if (list) {
                list.push(hit);
            } else {
                out.set(hit.fileIdx, [hit]);
            }
        }
        return out;
    });
    /** Indices of the files whose path contains the query. */
    const nameMatches = computed(() => new Set(active.value
        ? files.value.flatMap((file, idx) => (fileNameMatches(file.path, query.value) ? [idx] : []))
        : []));
    /** Index of the current hit in `hits` (-1: none yet, or no longer in the comparison). */
    const current = computed(() => {
        const at = target.value;
        return at ? hits.value.findIndex((h) => h.path === at.path && h.hunk === at.hunk && h.line === at.line && h.start === at.start) : -1;
    });
    const currentHit = computed((): SearchHit | null => hits.value[current.value] ?? null);

    const fileHits = (idx: number): readonly SearchHit[] => hitsByFile.value.get(idx) ?? NO_HITS;

    /** The file appears in the filtered list: its name matches or it contains hits. */
    const listed = (idx: number): boolean => !active.value || nameMatches.value.has(idx) || hitsByFile.value.has(idx);

    /** Next (1) or previous (-1) hit across files: its file is expanded and its line scrolled under the timeline. */
    async function step(dir: 1 | -1): Promise<void> {
        // Enter right after typing: the query is applied at once, not after the debounce
        applyQuery(input.value.trim());
        const hit = hits.value[stepHit(current.value, hits.value.length, dir)];
        if (!hit) {
            return;
        }
        target.value = hit;
        await hooks.showFile(hit.fileIdx);
        hooks.scrollToMatch();
    }

    function clear(): void {
        input.value = '';
        applyQuery('');
    }

    function registerBox(el: HTMLInputElement | null): void {
        box = el;
    }

    function focus(): boolean {
        if (!box) {
            return false;
        }
        box.focus();
        box.select();
        return true;
    }

    return { input, query, active, hits, current, currentHit, nameMatches, fileHits, listed, step, clear, registerBox, focus };
}

export type DiffSearch = ReturnType<typeof useDiffSearch>;
