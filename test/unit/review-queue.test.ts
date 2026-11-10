import { describe, expect, it } from 'vitest';
import { classifyPr, needsReview, type QueueInput } from '../../src/server/core/review-queue.ts';

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
