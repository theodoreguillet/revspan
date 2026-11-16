// Capped prefetch of the range presets: computed in the background so that a click shows them at once.
import type { Comparison, Summary } from '../../shared/api.ts';
import type { Preset, PresetKey, Range } from './selection.ts';

/** Larger PRs are never prefetched: each comparison costs Bitbucket requests per file. */
export const PREFETCH_MAX_FILES = 30;

/** Only the default diff context (3 lines) is prefetched: "whole file" never prefetches the presets again. */
export const PREFETCH_CONTEXT = 3;

const ORDER: readonly PresetKey[] = ['last', 'since', 'all'];

/**
 * Ranges of the presets to compute in the background, in the order "Last version", "Since my review", "All vs master":
 * those not cached yet (`cached` holds `keyOf` keys), each once. Empty when the PR size is unknown or above
 * PREFETCH_MAX_FILES.
 */
export function prefetchQueue(presets: readonly Preset[], cached: ReadonlySet<string>, keyOf: (r: Range) => string, fileCount: number | null): Range[] {
    if (fileCount === null || fileCount > PREFETCH_MAX_FILES) {
        return [];
    }
    const seen = new Set(cached);
    const out: Range[] = [];
    for (const key of ORDER) {
        const preset = presets.find((p) => p.key === key);
        if (!preset) {
            continue;
        }
        const range = { from: preset.from, to: preset.to };
        const k = keyOf(range);
        if (!seen.has(k)) {
            seen.add(k);
            out.push(range);
        }
    }
    return out;
}

/**
 * Size of the PR used to cap the prefetch, never a lower bound (a small "since my review" diff says nothing of the
 * whole PR): the file count of the comparison against master (from 0 to the last version) when it is cached;
 * otherwise the number of distinct files the author touched across all versions, from the version summary the page
 * loads anyway; null until that summary is loaded (no prefetch).
 */
export function prefetchFileCount(summary: Summary | null, known: Iterable<Pick<Comparison, 'from' | 'to' | 'stats'>>, last: number): number | null {
    for (const cmp of known) {
        if (cmp.from === 0 && cmp.to === last) {
            return cmp.stats.files;
        }
    }
    if (!summary) {
        return null;
    }
    return new Set(summary.versions.flatMap((v) => v.files.map((f) => f.path))).size;
}
