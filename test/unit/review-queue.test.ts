import { describe, expect, it } from 'vitest';
import { classifyPr, needsReview, ownGroup, type QueueInput } from '../../src/server/core/review-queue.ts';

/** Someone else's PR, me known, with no approval or review of mine, minimum already reached. */
const input = (over: Partial<QueueInput>): QueueInput => ({
    isMine: false,
    meKnown: true,
    needsReview: false,
    designatedReviewer: false,
    changesRequested: false,
    draft: false,
    myApprovalCurrent: false,
    approvalHolds: false,
    reviewedOrApproved: false,
    newCodeVersions: null,
    followed: false,
    followFilter: false,
    ...over,
});

describe('needsReview', () => {
    it('true while the approvals are below the minimum', () => {
        expect(needsReview(0, 2)).toBe(true);
        expect(needsReview(1, 2)).toBe(true);
        expect(needsReview(2, 2)).toBe(false);
        expect(needsReview(3, 2)).toBe(false);
    });
});

describe('classifyPr', () => {
    it('me unknown: every PR in "others", whatever else is true', () => {
        expect(classifyPr(input({ meKnown: false, isMine: true, needsReview: true, designatedReviewer: true }))).toBe('others');
    });

    it('M7: a draft is never "to-do" (nor "waiting"): "others"; my own draft stays "mine"', () => {
        expect(classifyPr(input({ draft: true, needsReview: true, designatedReviewer: true }))).toBe('others');
        expect(classifyPr(input({ draft: true, reviewedOrApproved: true, newCodeVersions: 2 }))).toBe('others');
        expect(classifyPr(input({ draft: true, myApprovalCurrent: true, reviewedOrApproved: true }))).toBe('others');
        expect(classifyPr(input({ draft: true, isMine: true }))).toBe('mine');
    });

    it('my PR: "mine"', () => {
        expect(classifyPr(input({ isMine: true, needsReview: true, designatedReviewer: true }))).toBe('mine');
    });

    it('approved and my approval still holds (or is on the latest version): "waiting"', () => {
        expect(classifyPr(input({ approvalHolds: true, reviewedOrApproved: true, needsReview: true, designatedReviewer: true, newCodeVersions: 0 }))).toBe('waiting');
        expect(classifyPr(input({ myApprovalCurrent: true, reviewedOrApproved: true, needsReview: true, newCodeVersions: null }))).toBe('waiting');
    });

    it('designated reviewer who has not approved: "to-do", even when the minimum is reached', () => {
        expect(classifyPr(input({ designatedReviewer: true, needsReview: false }))).toBe('to-do');
        expect(classifyPr(input({ designatedReviewer: true, reviewedOrApproved: true, newCodeVersions: 0 }))).toBe('to-do');
    });

    it('M8: designated reviewer who requested changes, then only neutral versions: "waiting" on the author', () => {
        expect(classifyPr(input({ designatedReviewer: true, changesRequested: true, reviewedOrApproved: true, needsReview: true, newCodeVersions: 0 }))).toBe('waiting');
        // New code (or types not computed yet) since the change request: back to "to-do".
        expect(classifyPr(input({ designatedReviewer: true, changesRequested: true, reviewedOrApproved: true, newCodeVersions: 1 }))).toBe('to-do');
        expect(classifyPr(input({ designatedReviewer: true, changesRequested: true, reviewedOrApproved: true, newCodeVersions: null }))).toBe('to-do');
        // A designated reviewer who only commented stays in "to-do" (Bitbucket asks for the approval).
        expect(classifyPr(input({ designatedReviewer: true, reviewedOrApproved: true, newCodeVersions: 0 }))).toBe('to-do');
    });

    it('reviewed, then only neutral versions: "waiting"', () => {
        expect(classifyPr(input({ reviewedOrApproved: true, needsReview: true, newCodeVersions: 0 }))).toBe('waiting');
    });

    it('needs approvals and I have not reviewed it: "to-do"', () => {
        expect(classifyPr(input({ needsReview: true }))).toBe('to-do');
        expect(classifyPr(input({ needsReview: true, reviewedOrApproved: true, newCodeVersions: null }))).toBe('to-do');
    });

    it('minimum reached and I am not involved: "others"', () => {
        expect(classifyPr(input({}))).toBe('others');
    });

    it('stale approval or new code since my review: "to-do", even when the minimum is reached', () => {
        expect(classifyPr(input({ reviewedOrApproved: true, approvalHolds: false, newCodeVersions: 2 }))).toBe('to-do');
        // Types of the new versions not computed yet: assume code, so the PR is not hidden.
        expect(classifyPr(input({ reviewedOrApproved: true, newCodeVersions: null }))).toBe('to-do');
    });
});

describe('"To review" limited to followed contributors (3.2.0)', () => {
    /** Someone's PR that needs review, while I follow at least one contributor. */
    const filtered = (over: Partial<QueueInput>): QueueInput => input({ needsReview: true, followFilter: true, ...over });

    it('nobody followed: every PR needing review is "to-do", as before', () => {
        expect(classifyPr(input({ needsReview: true, followFilter: false }))).toBe('to-do');
    });

    it('someone followed: a PR needing review goes to "to-do" only if its author is followed', () => {
        expect(classifyPr(filtered({ followed: true }))).toBe('to-do');
        expect(classifyPr(filtered({ followed: false }))).toBe('others');
    });

    it('someone followed: a designated reviewer still gets the PR in "to-do", followed author or not', () => {
        expect(classifyPr(filtered({ designatedReviewer: true }))).toBe('to-do');
        expect(classifyPr(filtered({ designatedReviewer: true, needsReview: false }))).toBe('to-do');
    });

    it('someone followed: a PR I reviewed or approved with code since stays in "to-do" (I am engaged)', () => {
        expect(classifyPr(filtered({ reviewedOrApproved: true, newCodeVersions: 1 }))).toBe('to-do');
        expect(classifyPr(filtered({ reviewedOrApproved: true, newCodeVersions: null }))).toBe('to-do');
        // Only neutral versions since my review: still waiting on the author.
        expect(classifyPr(filtered({ reviewedOrApproved: true, newCodeVersions: 0 }))).toBe('waiting');
    });

    it('someone followed: a followed author\'s PR with enough approvals asks nothing: "others"', () => {
        expect(classifyPr(filtered({ followed: true, needsReview: false }))).toBe('others');
    });

    it('my own PRs and drafts are not affected by the filter', () => {
        expect(classifyPr(filtered({ isMine: true }))).toBe('mine');
        expect(classifyPr(filtered({ draft: true, followed: true }))).toBe('others');
    });
});

describe('ownGroup', () => {
    it('my open PR whose destination moved: "to-rebase"; otherwise (or unknown) "mine"', () => {
        expect(ownGroup(true)).toBe('to-rebase');
        expect(ownGroup(false)).toBe('mine');
        expect(ownGroup(null)).toBe('mine');
    });
});
