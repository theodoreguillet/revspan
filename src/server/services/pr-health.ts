// Build state and "needs rebase" of a PR, read from Bitbucket (statuses, branch head, merge base). Never throws.
import type { BuildCheck, PrRef } from '../../shared/api.ts';
import type { BitbucketClient } from '../bitbucket/client.ts';
import { toBuildChecks } from '../core/build.ts';

/** Checks of the PR's head commit; null when the head is unknown (an empty prefix would match every status) or the read failed. */
export async function loadBuildChecks(client: BitbucketClient, ref: PrRef, headHash: string): Promise<BuildCheck[] | null> {
    if (!headHash) {
        return null;
    }
    try {
        return toBuildChecks(await client.prStatuses(ref.workspace, ref.repo, ref.id), headHash);
    } catch {
        return null;
    }
}

const sameCommit = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

/** True when the destination branch moved since the PR's base; null when it cannot be told (unknown head, branch or merge base, read failure). */
export async function loadNeedsRebase(client: BitbucketClient, ref: PrRef, headHash: string, destBranch: string): Promise<boolean | null> {
    if (!headHash || !destBranch) {
        return null;
    }
    try {
        const destHead = await client.branchHead(ref.workspace, ref.repo, destBranch);
        if (!destHead) {
            return null;
        }
        const base = await client.mergeBase(ref.workspace, ref.repo, headHash, destHead);
        return base ? !sameCommit(base, destHead) : null;
    } catch {
        return null;
    }
}
