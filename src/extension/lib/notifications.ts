// Which VS Code notifications a home refresh raises: pure rules, the notifier applies them to the shared state.
import type { Home, HomeGroupKey, PrCard, PrRef, VersionKind } from '../../shared/api.ts';
import type { NotificationPrefs } from '../../shared/review-settings.ts';
import { versionsAfter } from '../../server/core/model.ts';
import { prKeyOf, type NotifiedState } from '../../server/infra/config.ts';

export interface PendingNotification {
    kind: 'newPullRequest' | 'newVersion' | 'buildFailed';
    ref: PrRef;
    title: string;
    author: string | null;
}

type Kind = PendingNotification['kind'];

/**
 * Whether code or dependencies changed since the previous head, per prKey. null: could not be checked (counts as code).
 * 'pending': the versions read do not reach the card's head yet (the PR or its activity lags behind the list): the PR is
 * neither notified nor recorded this poll, so the next poll checks it again.
 */
export type CodeChanges = Readonly<Record<string, boolean | null | 'pending'>>;

/** A PR whose head changed since it was recorded, on which I may be told about a new version. */
export interface VersionCandidate {
    ref: PrRef;
    /** Most recent head recorded before this one. */
    previousHead: string;
    /** Its head in the home (12 characters), which the versions read must reach. */
    head: string;
}

/** Value of a repository's marker in `seen` (key "workspace/repo"): its PRs were recorded once, silently. */
const REPO_BASELINE = 'baseline';
/** Key suffix of the heads whose failed build was already covered. */
const BUILD_SUFFIX = '#build';
/** Key suffix of the marker "my designation as a reviewer was already covered". */
const REVIEWER_SUFFIX = '#reviewer';
const REVIEWER_SEEN = 'seen';
/**
 * Heads kept per PR (space separated, most recent first): a window whose home is a little older than another's (lagging
 * replica) sees a head already in the list, which is not new, so no head is notified twice.
 */
const MAX_HEADS = 3;
/** Versions that change what the PR does; the others (rebase, message, nothing, erased) are neutral. */
const CODE_KINDS: ReadonlySet<VersionKind> = new Set(['creation', 'code', 'deps']);
/** Order of the toasts when there are too many: my broken builds, then what asks for my review, then new versions. */
const KIND_ORDER: readonly Kind[] = ['buildFailed', 'newPullRequest', 'newVersion'];

/** "workspace/repo" of a `seen` key (PR key, build or reviewer key, or repository marker). */
const repoOfKey = (key: string): string => key.split('#')[0] ?? '';
const headsOf = (value: string | undefined): string[] => (value ? value.split(' ').filter(Boolean) : []);

/** The recorded heads with `head` added in front, unchanged if it is already among them. */
function withHead(value: string | undefined, head: string): string {
    const heads = headsOf(value);
    return (heads.includes(head) ? heads : [head, ...heads].slice(0, MAX_HEADS)).join(' ');
}

const baselined = (state: NotifiedState, card: PrCard): boolean => state.initialized && state.seen[`${card.workspace}/${card.repo}`] === REPO_BASELINE;

/** Someone else's PR I reviewed or approved, whose head is not among the recorded ones. */
function hasNewHead(group: HomeGroupKey, card: PrCard, recorded: string | undefined): recorded is string {
    return group !== 'mine' && recorded !== undefined && !headsOf(recorded).includes(card.head) && (card.lastReviewed !== null || card.myApproval);
}

/**
 * PRs whose new head may deserve a "new version" notification, if code changed since the previous head. The notifier
 * checks only these (a version summary each), and only when that notification is on.
 */
export function versionCandidates(home: Home, state: NotifiedState): VersionCandidate[] {
    const candidates: VersionCandidate[] = [];
    for (const group of home.groups) {
        for (const card of group.prs) {
            const recorded = state.seen[prKeyOf(card)];
            // A draft is neither notified nor recorded: checking its versions would be wasted.
            if (card.head && !card.draft && baselined(state, card) && hasNewHead(group.key, card, recorded)) {
                candidates.push({ ref: { workspace: card.workspace, repo: card.repo, id: card.id }, previousHead: headsOf(recorded)[0] ?? '', head: card.head });
            }
        }
    }
    return candidates;
}

/**
 * Whether a version after the previous head has code or dependencies (versions oldest first, full hashes; kind null: not
 * computed). If the previous head is no longer among them (force-push), only the last version is judged. null when no
 * version starts with the current head: the versions lag behind the list, and judging them would call a code push
 * neutral.
 */
export function codeChangedSince(versions: readonly { hash: string; kind: VersionKind | null }[], previousHead: string, head: string): boolean | null {
    if (!versions.some((v) => v.hash.startsWith(head))) {
        return null;
    }
    return versionsAfter(versions, previousHead).some((v) => v.kind !== null && CODE_KINDS.has(v.kind));
}

/**
 * What a card calls for, in order of preference, preferences aside:
 * - buildFailed: my PR's build failed on a head not covered yet;
 * - newPullRequest: a "to-do" PR from a followed contributor, or where I am a designated reviewer, never seen before;
 * - newVersion: a new head on someone else's PR I reviewed or approved, unless only neutral versions arrived since the
 *   previous head (not checked: counts as code);
 * - newPullRequest again: I became a designated reviewer of a "to-do" PR already seen.
 */
function kindsOf(group: HomeGroupKey, card: PrCard, state: NotifiedState, codeChanged: boolean | null): Kind[] {
    const key = prKeyOf(card);
    if (group === 'mine') {
        return card.build?.state === 'failed' && !headsOf(state.seen[`${key}${BUILD_SUFFIX}`]).includes(card.head) ? ['buildFailed'] : [];
    }
    const recorded = state.seen[key];
    if (recorded === undefined) {
        return group === 'to-do' && (card.followed || card.designatedReviewer) ? ['newPullRequest'] : [];
    }
    const kinds: Kind[] = [];
    if (hasNewHead(group, card, recorded) && codeChanged !== false) {
        kinds.push('newVersion');
    }
    if (group === 'to-do' && card.designatedReviewer && state.seen[`${key}${REVIEWER_SUFFIX}`] === undefined) {
        kinds.push('newPullRequest');
    }
    return kinds;
}

/**
 * Notifications for this home given what was already covered, and the state to record instead. Every head is recorded
 * whatever the preferences, so switching one on later notifies nothing old. Nothing is notified on the first run, nor
 * for the PRs of a repository seen for the first time (newly tracked, or unreadable until now). Only the closed PRs of
 * the repositories this home read in full (no error, list not cut) are forgotten: another window of the profile may
 * track other repositories, whose records stay (the notifier forgets a repository removed from the settings, see
 * forgetRepositories). At most one notification per PR.
 */
export function planNotifications(home: Home, prefs: NotificationPrefs, state: NotifiedState, codeChanged: CodeChanges = {}): { notifications: PendingNotification[]; next: NotifiedState } {
    const tracked = new Set(home.repos);
    const unreadable = new Set(home.errors.map((e) => e.repo));
    const cut = new Set(home.truncated.map((t) => t.repo));
    const seen: Record<string, string> = {};
    /** Keeps a recorded entry as it is. */
    const keep = (key: string): void => {
        const value = state.seen[key];
        if (value !== undefined) {
            seen[key] = value;
        }
    };
    // Records of a repository this home did not read in full are kept: untracked here (another window's), unreadable for
    // this run, or with a list cut at the limit (the PRs left out are out of sight, not closed).
    for (const key of Object.keys(state.seen)) {
        const repo = repoOfKey(key);
        if (!tracked.has(repo) || unreadable.has(repo) || cut.has(repo)) {
            keep(key);
        }
    }
    for (const repo of tracked) {
        if (!unreadable.has(repo)) {
            seen[repo] = REPO_BASELINE;
        }
    }

    const notifications: PendingNotification[] = [];
    for (const group of home.groups) {
        for (const card of group.prs) {
            const key = prKeyOf(card);
            const buildKey = `${key}${BUILD_SUFFIX}`;
            const reviewerKey = `${key}${REVIEWER_SUFFIX}`;
            const change = codeChanged[key];
            if (!card.head || change === 'pending' || card.draft) {
                // Nothing to compare yet, or a draft (asks nothing yet: once ready, it notifies as a new PR): what was
                // recorded stays.
                [key, buildKey, reviewerKey].forEach(keep);
                continue;
            }
            const kind = baselined(state, card) ? kindsOf(group.key, card, state, change ?? null).find((k) => prefs[k]) : undefined;
            seen[key] = withHead(state.seen[key], card.head);
            if (group.key === 'mine' && card.build?.state === 'failed') {
                seen[buildKey] = withHead(state.seen[buildKey], card.head);
            } else {
                keep(buildKey);
            }
            if (card.designatedReviewer) {
                seen[reviewerKey] = REVIEWER_SEEN;
            } else {
                keep(reviewerKey);
            }
            if (kind) {
                notifications.push({ kind, ref: { workspace: card.workspace, repo: card.repo, id: card.id }, title: card.title, author: card.author?.displayName ?? null });
            }
        }
    }
    return { notifications, next: { initialized: true, seen } };
}

/**
 * State without any record of these repositories (removed from the settings): tracked again later, a repository records
 * a silent baseline instead of notifying what happened meanwhile.
 */
export function forgetRepositories(state: NotifiedState, repos: readonly string[]): NotifiedState {
    const removed = new Set(repos);
    return { initialized: state.initialized, seen: Object.fromEntries(Object.entries(state.seen).filter(([key]) => !removed.has(repoOfKey(key)))) };
}

/** The notifications to show one by one (most important first), and the others, gathered in one summary. */
export function capNotifications(list: readonly PendingNotification[], max = 3): { shown: PendingNotification[]; overflow: PendingNotification[] } {
    const sorted = [...list].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
    return { shown: sorted.slice(0, max), overflow: sorted.slice(max) };
}
