// Build state, "needs rebase" and merge conflicts of a PR, read from Bitbucket (statuses, branch head, merge base,
// conflicts). Never throws.
import type { BuildCheck, PrRef } from '../../shared/api.ts';
import type { BitbucketClient } from '../bitbucket/client.ts';

/**
 * Checks of the PR's head commit; null when the head is unknown (an empty prefix would match every status) or the read
 * failed. Settled checks are kept per head (see BitbucketClient.headChecks).
 */
export async function loadBuildChecks(client: BitbucketClient, ref: PrRef, headHash: string, options: { maxAgeMs?: number; recheck?: boolean; pushedAt?: string } = {}): Promise<BuildCheck[] | null> {
    if (!headHash) {
        return null;
    }
    try {
        return await client.headChecks(ref.workspace, ref.repo, ref.id, headHash, options);
    } catch {
        return null;
    }
}

const sameCommit = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

/** Head of a destination branch (the home shares one read per repository and branch between its PRs). */
export type BranchHeadReader = (branch: string) => Promise<string | null>;

/** Rebase state read from the destination branch: behind or not, and the destination head it was compared with. */
interface RebaseRead {
    needsRebase: boolean | null;
    /** Head of the destination branch (null when unknown). */
    destHead: string | null;
}

async function readRebase(client: BitbucketClient, ref: PrRef, headHash: string, destBranch: string, branchHead: BranchHeadReader): Promise<RebaseRead> {
    if (!headHash || !destBranch) {
        return { needsRebase: null, destHead: null };
    }
    try {
        const destHead = await branchHead(destBranch);
        if (!destHead) {
            return { needsRebase: null, destHead: null };
        }
        const base = await client.mergeBase(ref.workspace, ref.repo, headHash, destHead);
        return { needsRebase: base ? !sameCommit(base, destHead) : null, destHead };
    } catch {
        return { needsRebase: null, destHead: null };
    }
}

/** True when the destination branch moved since the PR's base; null when it cannot be told (unknown head, branch or merge base, read failure). */
export async function loadNeedsRebase(
    client: BitbucketClient,
    ref: PrRef,
    headHash: string,
    destBranch: string,
    branchHead: BranchHeadReader = (branch) => client.branchHead(ref.workspace, ref.repo, branch),
): Promise<boolean | null> {
    return (await readRebase(client, ref, headHash, destBranch, branchHead)).needsRebase;
}

/** Rebase state of an open PR on its page. */
export interface RebaseState {
    needsRebase: boolean | null;
    /** Paths in conflict with the destination; null when not read (not behind, or unknown) or unreadable. */
    mergeConflicts: string[] | null;
}

export const NO_REBASE_STATE: RebaseState = { needsRebase: null, mergeConflicts: null };

/**
 * Needs-rebase, then the merge conflicts only when the PR is behind its destination: a PR based on the destination's
 * head cannot conflict, so an up-to-date PR costs no conflicts read. The conflicts are kept per pair of source and
 * destination heads (read once per pair), and a slow or failed read gives null (no chip) instead of holding the page.
 */
export async function loadRebaseState(client: BitbucketClient, ref: PrRef, headHash: string, destBranch: string): Promise<RebaseState> {
    const { needsRebase, destHead } = await readRebase(client, ref, headHash, destBranch, (branch) => client.branchHead(ref.workspace, ref.repo, branch));
    if (needsRebase !== true || !destHead) {
        return { needsRebase, mergeConflicts: null };
    }
    try {
        return { needsRebase, mergeConflicts: await client.mergeConflicts(ref.workspace, ref.repo, ref.id, { sourceHead: headHash, destHead }) };
    } catch {
        return { needsRebase, mergeConflicts: null };
    }
}
