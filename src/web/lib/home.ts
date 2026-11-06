// Accueil : badges et sous-titre d'une carte de PR.
import type { HomeGroupKey, PrCard, User } from '../../shared/api.ts';
import { ago, displayName, openedSince, plural } from './format.ts';

export type BadgeTone = '' | 'grey' | 'green' | 'orange';

export interface Badge {
    text: string;
    tone: BadgeTone;
}

export function cardBadges(card: PrCard, groupKey: HomeGroupKey, me: User | null): Badge[] {
    const mine = !!me && card.author?.uuid === me.uuid;
    const badges: Badge[] = [];
    if (card.lastReviewed == null && !mine) {
        // versionsCount null : PR qui ne me concerne pas, historique non chargé
        badges.push({ text: card.versionsCount == null ? 'pas encore relue' : `pas encore relue · ${plural(card.versionsCount, 'version')}`, tone: 'grey' });
    } else if (card.newVersions > 0 && !mine) {
        badges.push({ text: `+${plural(card.newVersions, 'version')}`, tone: '' });
        if (card.newCodeVersions != null && card.newCodeVersions > 0) {
            badges.push({ text: `dont ${card.newCodeVersions} avec du code`, tone: '' });
        } else if (card.newCodeVersions === 0 || groupKey === 'rebase-only') {
            badges.push({ text: 'rebase seul', tone: 'orange' });
        }
    }
    if (card.newComments > 0) {
        badges.push({ text: `💬 ${plural(card.newComments, 'nouveau', 'nouveaux')}`, tone: '' });
    }
    if (card.myApproval) {
        badges.push({ text: '✓ approuvée', tone: 'green' });
    }
    return badges;
}

export function cardSubtitle(card: PrCard, me: User | null): string {
    const mine = !!me && card.author?.uuid === me.uuid;
    const parts = [
        `${card.repo} #${card.id}`,
        mine ? 'toi' : displayName(card.author),
        openedSince(card.createdOn),
        `push ${ago(card.lastPushAt)}`,
    ];
    if (card.approvals > 0) {
        parts.push(plural(card.approvals, 'approbation'));
    }
    return parts.join(' · ');
}
