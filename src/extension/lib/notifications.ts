// Which VS Code notifications a home refresh raises: pure rule, the notifier applies it to the shared state.
import type { Home, HomeGroupKey, PrCard, PrRef } from '../../shared/api.ts';
import type { NotificationPrefs } from '../../shared/review-settings.ts';
import { prKeyOf, type NotifiedState } from '../../server/infra/config.ts';

export interface PendingNotification {
    kind: 'newPullRequest' | 'newVersion' | 'buildFailed';
    ref: PrRef;
    title: string;
    author: string | null;
}

type Kind = PendingNotification['kind'];

/** Value of a repository's marker in `seen` (key "workspace/repo"): its PRs were recorded once, silently. */
const REPO_BASELINE = 'baseline';
/** Key suffix of the head whose failed build was already covered. */
const BUILD_SUFFIX = '#build';

/** "workspace/repo" of a `seen` key (PR key, build key or repository marker). */
const repoOfKey = (key: string): string => key.split('#')[0] ?? '';

/**
 * What a card calls for, preferences aside:
 * - buildFailed: my PR's build failed on a head not covered yet;
 * - newPullRequest: a "to-do" PR from a followed contributor, or where I am a designated reviewer, never seen before;
 * - newVersion: a new head on someone else's PR I reviewed or approved, unless only neutral versions arrived since my
 *   review (unknown version types count as code, as in the review queue).
 */
function kindOf(group: HomeGroupKey, card: PrCard, previousHead: string | undefined, coveredFailedHead: string | undefined): Kind | null {
    if (group === 'mine') {
        return card.build?.state === 'failed' && coveredFailedHead !== card.head ? 'buildFailed' : null;
    }
    if (previousHead === undefined) {
        return group === 'to-do' && (card.followed || card.designatedReviewer) ? 'newPullRequest' : null;
    }
    const reviewedOrApproved = card.lastReviewed !== null || card.myApproval;
    return previousHead !== card.head && reviewedOrApproved && card.newCodeVersions !== 0 ? 'newVersion' : null;
}

/**
 * Notifications for this home given what was already covered, and the state to record instead. Every head is recorded
 * whatever the preferences, so switching one on later notifies nothing old. Nothing is notified on the first run, nor
 * for the PRs of a repository seen for the first time (newly tracked, or unreadable until now). Closed PRs and
 * untracked repositories are forgotten. At most one notification per PR.
 */
export function planNotifications(home: Home, prefs: NotificationPrefs, state: NotifiedState): { notifications: PendingNotification[]; next: NotifiedState } {
    const tracked = new Set(home.repos);
    const unreadable = new Set(home.errors.map((e) => e.repo));
    const baselined = (repo: string): boolean => state.initialized && state.seen[repo] === REPO_BASELINE;
    const seen: Record<string, string> = {};
    // An unreadable repository keeps its records: its PRs are out of sight for this run, not closed.
    for (const [key, value] of Object.entries(state.seen)) {
        const repo = repoOfKey(key);
        if (tracked.has(repo) && unreadable.has(repo)) {
            seen[key] = value;
        }
    }
    for (const repo of tracked) {
        if (!unreadable.has(repo)) {
            seen[repo] = REPO_BASELINE;
        }
    }

    const notifications: PendingNotification[] = [];
    const notified = new Set<string>();
    for (const group of home.groups) {
        for (const card of group.prs) {
            if (!card.head) {
                continue;
            }
            const key = prKeyOf(card);
            const buildKey = `${key}${BUILD_SUFFIX}`;
            const covered = state.seen[buildKey];
            const kind = baselined(`${card.workspace}/${card.repo}`) && !notified.has(key)
                ? kindOf(group.key, card, state.seen[key], covered)
                : null;
            seen[key] = card.head;
            if (group.key === 'mine' && card.build?.state === 'failed') {
                seen[buildKey] = card.head;
            } else if (covered !== undefined) {
                // A re-run of the same head failing again stays covered.
                seen[buildKey] = covered;
            }
            if (kind && prefs[kind]) {
                notified.add(key);
                notifications.push({ kind, ref: { workspace: card.workspace, repo: card.repo, id: card.id }, title: card.title, author: card.author?.displayName ?? null });
            }
        }
    }
    return { notifications, next: { initialized: true, seen } };
}
