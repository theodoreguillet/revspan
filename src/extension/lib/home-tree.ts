// Arbre « Mes PR » de la barre latérale, construit à partir de l'accueil (mêmes groupes que la page).
import type { Home, HomeGroupKey, PrCard, PrRef } from '../../shared/api.ts';
import { errorText } from './error-text.ts';
import type { L10n, Translate } from './l10n.ts';

export interface PrNode {
    ref: PrRef;
    label: string;
    description: string;
    tooltip: string;
}

export interface GroupNode {
    key: HomeGroupKey;
    label: string;
    /** Icône (codicon) du groupe. */
    icon: string;
    collapsed: boolean;
    prs: PrNode[];
}

const ICONS: Record<HomeGroupKey, string> = {
    'to-review': 'eye',
    'rebase-only': 'sync',
    'up-to-date': 'check',
    'mine': 'account',
    'others': 'git-pull-request',
};

/** Group title, translated from its key (the server sends no title). */
function groupTitle(t: Translate, key: HomeGroupKey): string {
    switch (key) {
        case 'to-review':
            return t('To review');
        case 'rebase-only':
            return t('Quick re-approval · rebases only');
        case 'up-to-date':
            return t('Up to date');
        case 'mine':
            return t('My PRs');
        case 'others':
            return t('Other open PRs');
    }
}

const versions = ({ t, isSingular }: L10n, count: number): string =>
    (isSingular(count) ? t('{count} version', { count }) : t('{count} versions', { count }));

const newVersions = ({ t, isSingular }: L10n, count: number): string =>
    (isSingular(count) ? t('+{count} version', { count }) : t('+{count} versions', { count }));

const approvals = ({ t, isSingular }: L10n, count: number): string =>
    (isSingular(count) ? t('{count} approval', { count }) : t('{count} approvals', { count }));

function badges(l10n: L10n, card: PrCard, key: HomeGroupKey): string[] {
    const { t } = l10n;
    const out: string[] = [];
    if (key !== 'mine' && card.lastReviewed === null) {
        out.push(t('not reviewed yet'));
    } else if (key !== 'mine' && card.newVersions > 0) {
        out.push(newVersions(l10n, card.newVersions));
        if (card.newCodeVersions !== null && card.newCodeVersions > 0) {
            out.push(t('{count} with code', { count: card.newCodeVersions }));
        }
    }
    if (card.newComments > 0) {
        out.push(`💬 ${card.newComments}`);
    }
    if (card.myApproval) {
        out.push(t('✓ approved'));
    }
    return out;
}

function prNode(l10n: L10n, card: PrCard, key: HomeGroupKey): PrNode {
    const extra = badges(l10n, card, key);
    return {
        ref: { workspace: card.workspace, repo: card.repo, id: card.id },
        // Dépôt et numéro devant le titre : repérables d'un coup d'œil dans la liste.
        label: `${card.repo} #${card.id} · ${card.title}`,
        description: extra.join(' · '),
        tooltip: [
            card.title,
            `${card.workspace}/${card.repo} #${card.id} · ${card.author?.displayName ?? '?'}`,
            ...(card.versionsCount === null ? [] : [versions(l10n, card.versionsCount)]),
            ...(card.approvals > 0 ? [approvals(l10n, card.approvals)] : []),
            ...extra,
        ].join('\n'),
    };
}

/** Groupes non vides ; « Autres PR ouvertes » replié (déplié si l'outil ne sait pas qui je suis). */
export function buildHomeTree(home: Home, l10n: L10n): GroupNode[] {
    return home.groups
        .filter((group) => group.prs.length > 0)
        .map((group) => ({
            key: group.key,
            label: `${groupTitle(l10n.t, group.key)} (${group.prs.length})`,
            icon: ICONS[group.key],
            collapsed: group.key === 'others' && home.me !== null,
            prs: group.prs.map((card) => prNode(l10n, card, group.key)),
        }));
}

/** Tree line of a repository that could not be read, e.g. « acme/x: Not found on Bitbucket: … ». */
export function repoErrorLabel(t: Translate, error: Home['errors'][number]): string {
    return t('{repo}: {message}', { repo: error.repo, message: errorText(t, error) });
}
