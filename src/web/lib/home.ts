// Home: badges and subtitle of a PR card, notices about the repositories.
import type { Home, HomeGroupKey, PrCard, User } from '../../shared/api.ts';
import type { MessageKey, Translator } from '../i18n/index.ts';
import { ago, displayName, openedSince } from './format.ts';

export type BadgeTone = '' | 'grey' | 'green' | 'orange';

export interface Badge {
    text: string;
    tone: BadgeTone;
}

/** Title of each home group, translated from its key (the server sends no title). */
export const GROUP_TITLES = {
    'to-do': 'home.group.toReview',
    'to-rebase': 'home.group.toRebase',
    mine: 'home.group.mine',
    waiting: 'home.group.waiting',
    others: 'home.group.others',
} as const satisfies Record<HomeGroupKey, MessageKey>;

export function cardBadges(tr: Translator, card: PrCard, me: User | null): Badge[] {
    const mine = !!me && card.author?.uuid === me.uuid;
    const badges: Badge[] = [];
    if (card.draft) {
        badges.push({ text: tr.t('home.badge.draft'), tone: 'grey' });
    }
    if (card.lastReviewed == null && !mine) {
        // versionsCount null: PR that does not concern me, history not loaded
        const text = card.versionsCount == null
            ? tr.t('home.badge.notReviewed')
            : `${tr.t('home.badge.notReviewed')} · ${tr.t('common.versions', { count: card.versionsCount })}`;
        badges.push({ text, tone: 'grey' });
    } else if (card.newVersions > 0 && !mine) {
        badges.push({ text: tr.t('home.badge.newVersions', { count: card.newVersions }), tone: '' });
        if (card.newCodeVersions != null && card.newCodeVersions > 0) {
            badges.push({ text: tr.t('home.badge.withCode', { count: card.newCodeVersions }), tone: '' });
        } else if (card.newCodeVersions === 0) {
            badges.push({ text: tr.t('kind.rebaseOnly'), tone: 'orange' });
        }
    }
    if (card.newComments > 0) {
        badges.push({ text: tr.t('home.badge.newComments', { count: card.newComments }), tone: '' });
    }
    if (card.myApproval) {
        badges.push({ text: tr.t('home.badge.approved'), tone: 'green' });
    }
    return badges;
}

export function cardSubtitle(tr: Translator, card: PrCard, me: User | null): string {
    const mine = !!me && card.author?.uuid === me.uuid;
    const parts = [
        mine ? tr.t('common.you') : displayName(card.author),
        openedSince(tr, card.createdOn),
        tr.t('home.pushed', { ago: ago(tr, card.lastPushAt) }),
        // against the required minimum: tells how far the PR is from leaving the review queue
        tr.t('home.approvalsOf', { count: card.approvals, required: card.requiredApprovals }),
    ];
    return parts.join(' · ');
}

/** Why the home lists no PR, if it lists none: no repository, every PR hidden by the unfollowed filter, or no open PR. */
export function emptyHome({ repos, shown, hidden }: { repos: number; shown: number; hidden: number }): 'no-repos' | 'all-hidden' | 'no-open-prs' | null {
    if (repos === 0) {
        return 'no-repos';
    }
    if (shown > 0) {
        return null;
    }
    return hidden > 0 ? 'all-hidden' : 'no-open-prs';
}

/** A repository with more open PRs than Revspan reads: only the first ones are listed. */
export function truncatedNotice(tr: Translator, { repo, count }: Home['truncated'][number]): string {
    return tr.t('home.truncated', { repo, count });
}
