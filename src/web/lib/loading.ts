// What the diff area shows while a comparison the user asked for is computed.

/** Below this, the current diff stays (with the progress bar): a fast answer never flashes a skeleton. */
export const SKELETON_DELAY_MS = 200;

export interface DiffDisplayState {
    /** A comparison the user asked for is being computed. */
    loading: boolean;
    /** When that computation started (ms), null when none. */
    since: number | null;
    now: number;
    /** A comparison is already shown. */
    hasCompare: boolean;
}

/**
 * `diff`: the comparison; `progress`: the current comparison kept, the bar says a new one is coming (under
 * SKELETON_DELAY_MS); `skeleton`: placeholder files, from SKELETON_DELAY_MS or when nothing is shown yet.
 */
export function diffDisplay({ loading, since, now, hasCompare }: DiffDisplayState): 'diff' | 'progress' | 'skeleton' {
    if (!hasCompare) {
        return 'skeleton';
    }
    if (!loading) {
        return 'diff';
    }
    return since !== null && now - since >= SKELETON_DELAY_MS ? 'skeleton' : 'progress';
}
