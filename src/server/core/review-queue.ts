// Review queue: which home group a PR belongs to, from what it still needs and what I already did on it.
import type { HomeGroupKey } from '../../shared/api.ts';

/** A PR needs review while it has fewer approvals (other than its author's) than the required minimum. */
export function needsReview(approvals: number, required: number): boolean {
    return approvals < required;
}

export interface QueueInput {
    isMine: boolean;
    /** false: the token cannot read the profile, so nothing can be attributed to me. */
    meKnown: boolean;
    needsReview: boolean;
    /** I am among the reviewers designated on Bitbucket. */
    designatedReviewer: boolean;
    /** My current review state on Bitbucket is "changes requested". */
    changesRequested: boolean;
    /** Draft PR: asks no review yet. */
    draft: boolean;
    /** My approval is on the latest version. */
    myApprovalCurrent: boolean;
    /** My approval is still active and only neutral versions arrived since (approvalHoldsSince). */
    approvalHolds: boolean;
    /** I reviewed the PR (local mark, comment, approval or change request) or approved it. */
    reviewedOrApproved: boolean;
    /** Versions with code or dependencies since my review; null: their types are not computed yet. */
    newCodeVersions: number | null;
    /** The author is one of my followed contributors. */
    followed: boolean;
    /** At least one contributor is followed: a PR needing review then goes to "to-do" only from a followed author. */
    followFilter: boolean;
}

/** Rules applied in order: the first that matches gives the group. */
export function classifyPr(input: QueueInput): HomeGroupKey {
    if (!input.meKnown) {
        return 'others';
    }
    if (input.isMine) {
        return 'mine';
    }
    // A draft asks no review yet: nothing to do, nothing to wait for.
    if (input.draft) {
        return 'others';
    }
    if (input.myApprovalCurrent || input.approvalHolds) {
        return 'waiting';
    }
    // I asked for changes and nothing but neutral versions arrived since: the next move is the author's.
    if (input.designatedReviewer && input.changesRequested && input.reviewedOrApproved && input.newCodeVersions === 0) {
        return 'waiting';
    }
    if (input.designatedReviewer) {
        return 'to-do';
    }
    if (input.reviewedOrApproved && input.newCodeVersions === 0) {
        return 'waiting';
    }
    // While nobody is followed, every PR needing review is proposed, so a new user never sees an empty queue.
    if (input.needsReview && (!input.followFilter || input.followed)) {
        return 'to-do';
    }
    // Stale approval or new code since my review (unknown types count as code, so the PR is not hidden): I am engaged
    // with it, followed author or not.
    if (input.reviewedOrApproved && (input.newCodeVersions ?? 1) > 0) {
        return 'to-do';
    }
    return 'others';
}

/** Group of one of my PRs once its rebase state is known: the ones whose destination moved since their base come first. */
export function ownGroup(needsRebase: boolean | null): HomeGroupKey {
    return needsRebase === true ? 'to-rebase' : 'mine';
}
