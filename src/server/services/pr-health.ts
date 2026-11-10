// Build state and "needs rebase" of a PR, read from Bitbucket (statuses, branch head, merge base). Never throws.
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

/** True when the destination branch moved since the PR's base; null when it cannot be told (unknown head, branch or merge base, read failure). */
export async function loadNeedsRebase(
    client: BitbucketClient,
    ref: PrRef,
    headHash: string,
    destBranch: string,
    branchHead: BranchHeadReader = (branch) => client.branchHead(ref.workspace, ref.repo, branch),
): Promise<boolean | null> {
    if (!headHash || !destBranch) {
        return null;
    }
    try {
        const destHead = await branchHead(destBranch);
        if (!destHead) {
            return null;
        }
        const base = await client.mergeBase(ref.workspace, ref.repo, headHash, destHead);
        return base ? !sameCommit(base, destHead) : null;
    } catch {
        return null;
    }
}
