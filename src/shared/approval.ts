// When an approval still active on Bitbucket counts for the latest version. One rule for the server (home page and
// VS Code tree) and for the PR page, so they never disagree on "Re-approve" versus "Remove approval".
import type { VersionKind } from './api.ts';

/**
 * Versions with no author change: an approval given before remains valid. A version erased by Bitbucket
 * (unavailable) cannot be compared, so it does not invalidate the approval on its own.
 */
const NEUTRAL_KINDS: ReadonlySet<VersionKind> = new Set(['rebase-only', 'message-only', 'none', 'unavailable']);

/**
 * An approval still active on Bitbucket counts for the latest version if all versions that arrived since the
 * approved version are known and neutral. kinds[i] = type of version i + 1 (undefined if not yet computed).
 * Approved version unknown (null): Bitbucket's state is authoritative, the approval holds.
 */
export function approvalHoldsSince(approvedVersion: number | null, kinds: readonly (VersionKind | undefined)[]): boolean {
    if (approvedVersion === null) {
        return true;
    }
    return kinds.slice(approvedVersion).every((kind) => kind !== undefined && NEUTRAL_KINDS.has(kind));
}
