// Arbre « Mes PR » de la barre latérale, construit à partir de l'accueil (mêmes groupes que la page).
import type { Home, HomeGroupKey, PrCard, PrRef } from '../../shared/api.ts';

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

const plural = (n: number, word: string): string => `${n} ${word}${n > 1 ? 's' : ''}`;

function badges(card: PrCard, key: HomeGroupKey): string[] {
    const out: string[] = [];
    if (key !== 'mine' && card.lastReviewed === null) {
        out.push('pas encore relue');
    } else if (key !== 'mine' && card.newVersions > 0) {
        out.push(`+${plural(card.newVersions, 'version')}`);
        if (card.newCodeVersions !== null && card.newCodeVersions > 0) {
            out.push(`dont ${card.newCodeVersions} avec du code`);
        }
    }
    if (card.newComments > 0) {
        out.push(`💬 ${card.newComments}`);
    }
    if (card.myApproval) {
        out.push('✓ approuvée');
    }
    return out;
}

function prNode(card: PrCard, key: HomeGroupKey): PrNode {
    const extra = badges(card, key);
    return {
        ref: { workspace: card.workspace, repo: card.repo, id: card.id },
        // Dépôt et numéro devant le titre : repérables d'un coup d'œil dans la liste.
        label: `${card.repo} #${card.id} · ${card.title}`,
        description: extra.join(' · '),
        tooltip: [
            card.title,
            `${card.workspace}/${card.repo} #${card.id} · ${card.author?.displayName ?? '?'}`,
            ...(card.versionsCount === null ? [] : [plural(card.versionsCount, 'version')]),
            ...(card.approvals > 0 ? [plural(card.approvals, 'approbation')] : []),
            ...extra,
        ].join('\n'),
    };
}

/** Groupes non vides ; « Autres PR ouvertes » replié (déplié si l'outil ne sait pas qui je suis). */
export function buildHomeTree(home: Home): GroupNode[] {
    return home.groups
        .filter((group) => group.prs.length > 0)
        .map((group) => ({
            key: group.key,
            label: `${group.title} (${group.prs.length})`,
            icon: ICONS[group.key],
            collapsed: group.key === 'others' && home.me !== null,
            prs: group.prs.map((card) => prNode(card, group.key)),
        }));
}
