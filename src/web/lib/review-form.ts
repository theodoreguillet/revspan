// Review section of the settings form: rows as typed in the page -> ReviewSettings, or the message to show.
import { normalizeRepo } from '../../shared/repos.ts';
import { MAX_APPROVALS, MAX_REFRESH_MINUTES, type ReviewSettings } from '../../shared/review-settings.ts';
import type { MessageKey } from '../i18n/index.ts';

/** Messages without placeholders. */
export type ReviewFormError = Extract<MessageKey, 'settings.invalidApprovals' | 'settings.invalidRefresh' | 'settings.invalidByRepo'>;

export interface ByRepoRow {
    repo: string;
    approvals: number | string | null;
}

export interface ReviewForm {
    requiredApprovals: number | string | null;
    byRepo: ByRepoRow[];
    refreshMinutes: number | string | null;
    followed: ReviewSettings['followed'];
    notifications: ReviewSettings['notifications'];
}

/** A whole number from 1 to max (the number field gives a number, or a string when the text is not numeric). */
function wholeNumber(value: number | string | null, max: number): number | null {
    const number = typeof value === 'string' ? (value.trim() === '' ? NaN : Number(value)) : value;
    return typeof number === 'number' && Number.isInteger(number) && number >= 1 && number <= max ? number : null;
}

export type ReviewFormResult = { ok: true; review: ReviewSettings } | { ok: false; error: ReviewFormError };

/** Blank override rows are ignored; any other invalid input is reported instead of being silently replaced. */
export function reviewFromForm(form: ReviewForm): ReviewFormResult {
    const requiredApprovals = wholeNumber(form.requiredApprovals, MAX_APPROVALS);
    if (requiredApprovals === null) {
        return { ok: false, error: 'settings.invalidApprovals' };
    }
    const refreshMinutes = wholeNumber(form.refreshMinutes, MAX_REFRESH_MINUTES);
    if (refreshMinutes === null) {
        return { ok: false, error: 'settings.invalidRefresh' };
    }
    const requiredApprovalsByRepo: Record<string, number> = {};
    for (const row of form.byRepo) {
        if (!row.repo.trim() && (row.approvals === null || row.approvals === '')) {
            continue;
        }
        const repo = normalizeRepo(row.repo);
        const approvals = wholeNumber(row.approvals, MAX_APPROVALS);
        if (repo === null || approvals === null || repo in requiredApprovalsByRepo) {
            return { ok: false, error: 'settings.invalidByRepo' };
        }
        requiredApprovalsByRepo[repo] = approvals;
    }
    return {
        ok: true,
        review: { requiredApprovals, requiredApprovalsByRepo, followed: form.followed, notifications: { ...form.notifications }, refreshMinutes },
    };
}

/** Rows to display for the saved overrides, sorted by repository. */
export const byRepoRows = (byRepo: Record<string, number>): ByRepoRow[] =>
    Object.entries(byRepo).sort(([a], [b]) => a.localeCompare(b)).map(([repo, approvals]) => ({ repo, approvals }));
