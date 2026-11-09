// Accueil : badges et sous-titre d'une carte de PR.
import type { HomeGroupKey, PrCard, User } from '../../shared/api.ts';
import type { MessageKey, Translator } from '../i18n/index.ts';
import { ago, displayName, openedSince } from './format.ts';

export type BadgeTone = '' | 'grey' | 'green' | 'orange';

export interface Badge {
    text: string;
    tone: BadgeTone;
}

/** Title of each home group (the server's own titles are not shown: they are not translated). */
export const GROUP_TITLES = {
    'to-review': 'home.group.toReview',
    'rebase-only': 'home.group.rebaseOnly',
    'up-to-date': 'home.group.upToDate',
    mine: 'home.group.mine',
    others: 'home.group.others',
} as const satisfies Record<HomeGroupKey, MessageKey>;

export function cardBadges(tr: Translator, card: PrCard, groupKey: HomeGroupKey, me: User | null): Badge[] {
    const mine = !!me && card.author?.uuid === me.uuid;
    const badges: Badge[] = [];
    if (card.lastReviewed == null && !mine) {
        // versionsCount null : PR qui ne me concerne pas, historique non chargé
        const text = card.versionsCount == null
            ? tr.t('home.badge.notReviewed')
            : `${tr.t('home.badge.notReviewed')} · ${tr.t('common.versions', { count: card.versionsCount })}`;
        badges.push({ text, tone: 'grey' });
    } else if (card.newVersions > 0 && !mine) {
        badges.push({ text: tr.t('home.badge.newVersions', { count: card.newVersions }), tone: '' });
        if (card.newCodeVersions != null && card.newCodeVersions > 0) {
            badges.push({ text: tr.t('home.badge.withCode', { count: card.newCodeVersions }), tone: '' });
        } else if (card.newCodeVersions === 0 || groupKey === 'rebase-only') {
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
    ];
    if (card.approvals > 0) {
        parts.push(tr.t('common.approvals', { count: card.approvals }));
    }
    return parts.join(' · ');
}
