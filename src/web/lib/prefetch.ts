// Capped prefetch of the range presets: computed in the background so that a click shows them at once.
import type { Comparison } from '../../shared/api.ts';
import type { Preset, PresetKey, Range } from './selection.ts';

/** Larger PRs are never prefetched: each comparison costs Bitbucket requests per file. */
export const PREFETCH_MAX_FILES = 30;

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
 * Size of the PR used to cap the prefetch: the file count of the comparison against master (from 0 to the last
 * version) when it is known, the widest range; otherwise the largest file count among the known comparisons, a lower
 * bound (the first diff shown is usually "since my review"), accepted; null when nothing is known yet (no prefetch).
 */
export function prefetchFileCount(known: Iterable<Pick<Comparison, 'from' | 'to' | 'stats'>>, last: number): number | null {
    let largest: number | null = null;
    for (const cmp of known) {
        if (cmp.from === 0 && cmp.to === last) {
            return cmp.stats.files;
        }
        largest = Math.max(largest ?? 0, cmp.stats.files);
    }
    return largest;
}
