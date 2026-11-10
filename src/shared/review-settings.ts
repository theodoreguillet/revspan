// Review queue settings (rule shared by the server, the extension and the page).
import { normalizeRepo } from './repos.ts';

export interface FollowedUser {
    uuid: string;
    displayName: string;
}

export interface NotificationPrefs {
    newPullRequest: boolean;
    newVersion: boolean;
    buildFailed: boolean;
}

export interface ReviewSettings {
    /** Approvals a PR needs before it leaves the review queue. */
    requiredApprovals: number;
    /** Override per repository, key "workspace/repo". */
    requiredApprovalsByRepo: Record<string, number>;
    followed: FollowedUser[];
    /** Hide the PRs of contributors I do not follow (mine, designated and reviewed ones stay); only while someone is followed. */
    hideUnfollowed: boolean;
    notifications: NotificationPrefs;
    refreshMinutes: number;
}

export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = {
    requiredApprovals: 2,
    requiredApprovalsByRepo: {},
    followed: [],
    hideUnfollowed: true,
    notifications: { newPullRequest: true, newVersion: true, buildFailed: false },
    refreshMinutes: 5,
};

export const MAX_APPROVALS = 20;
export const MAX_REFRESH_MINUTES = 120;
const MAX_FOLLOWED = 200;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function intInRange(value: unknown, max: number): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max ? value : null;
}

function normalizeByRepo(raw: unknown): Record<string, number> {
    const result: Record<string, number> = {};
    if (!isRecord(raw)) {
        return result;
    }
    for (const [key, value] of Object.entries(raw)) {
        const approvals = intInRange(value, MAX_APPROVALS);
        if (approvals !== null && normalizeRepo(key) === key) {
            result[key] = approvals;
        }
    }
    return result;
}

function normalizeFollowed(raw: unknown): FollowedUser[] {
    const users: FollowedUser[] = [];
    if (!Array.isArray(raw)) {
        return users;
    }
    for (const entry of raw) {
        if (!isRecord(entry) || typeof entry.uuid !== 'string' || !entry.uuid.trim()) {
            continue;
        }
        const uuid = entry.uuid.trim();
        if (users.length < MAX_FOLLOWED && !users.some((u) => u.uuid === uuid)) {
            const displayName = typeof entry.displayName === 'string' && entry.displayName.trim() ? entry.displayName.trim() : uuid;
            users.push({ uuid, displayName });
        }
    }
    return users;
}

/** A complete, valid ReviewSettings from any input: each invalid value falls back to its default. */
export function normalizeReviewSettings(raw: unknown): ReviewSettings {
    const source = isRecord(raw) ? raw : {};
    const defaults = DEFAULT_REVIEW_SETTINGS;
    const prefs = isRecord(source.notifications) ? source.notifications : {};
    const flag = (key: keyof NotificationPrefs): boolean => (typeof prefs[key] === 'boolean' ? prefs[key] : defaults.notifications[key]);
    return {
        requiredApprovals: intInRange(source.requiredApprovals, MAX_APPROVALS) ?? defaults.requiredApprovals,
        requiredApprovalsByRepo: normalizeByRepo(source.requiredApprovalsByRepo),
        followed: normalizeFollowed(source.followed),
        hideUnfollowed: typeof source.hideUnfollowed === 'boolean' ? source.hideUnfollowed : defaults.hideUnfollowed,
        notifications: { newPullRequest: flag('newPullRequest'), newVersion: flag('newVersion'), buildFailed: flag('buildFailed') },
        refreshMinutes: intInRange(source.refreshMinutes, MAX_REFRESH_MINUTES) ?? defaults.refreshMinutes,
    };
}

/** Approvals a repository ("workspace/repo") needs: its override, otherwise the global value. */
export function requiredApprovalsFor(settings: ReviewSettings, repo: string): number {
    return settings.requiredApprovalsByRepo[repo] ?? settings.requiredApprovals;
}

/**
 * Following at least one contributor turns the follow filter on: "To review" then keeps the followed authors' PRs (plus
 * the designated and engaged ones). While nobody is followed, every PR needing review is proposed.
 */
export const followFilterOn = (settings: Pick<ReviewSettings, 'followed'>): boolean => settings.followed.length > 0;

/** Whether the unfollowed contributors' PRs are hidden: the setting is on and the follow filter applies. */
export const hidesUnfollowed = (settings: Pick<ReviewSettings, 'followed' | 'hideUnfollowed'>): boolean =>
    settings.hideUnfollowed && followFilterOn(settings);
