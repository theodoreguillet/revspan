// "My PRs" tree of the side bar, built from the home page data (same groups as the page).
import type { Home, HomeGroupKey, PrCard, PrRef, User } from '../../shared/api.ts';
import { visibleGroups } from '../../shared/home-filter.ts';
import { groupCards, groupingFor, isOwnGroup, type Grouping } from '../../shared/home-grouping.ts';
import { errorText } from './error-text.ts';
import type { L10n, Translate } from './l10n.ts';

/** `pr`: author can be followed; `pr-followed`: already followed; `pr-readonly`: own PR or unknown author. */
export type PrContext = 'pr' | 'pr-followed' | 'pr-readonly';

export interface PrNode {
    ref: PrRef;
    label: string;
    description: string;
    tooltip: string;
    /** Build state as a codicon (error, sync~spin, pass); absent when there is no build or it is not loaded. */
    icon?: string;
    contextValue: PrContext;
    author: User | null;
}

/** Subgroup of a group (repository or contributor), under the group node. */
export interface SubgroupNode {
    key: string;
    label: string;
    prs: PrNode[];
}

export interface GroupNode {
    key: HomeGroupKey;
    label: string;
    /** Icon (codicon) of the group. */
    icon: string;
    collapsed: boolean;
    /** PRs directly under the group (no subgroups). */
    prs: PrNode[];
    /** Subgroups; empty when the group is not split. */
    subgroups: SubgroupNode[];
}

const BUILD_ICONS = { failed: 'error', running: 'sync~spin', success: 'pass' } as const;

const ICONS: Record<HomeGroupKey, string> = {
    'to-do': 'eye',
    'to-rebase': 'repo-sync',
    'mine': 'account',
    'waiting': 'clock',
    'others': 'git-pull-request',
};

/** Group title, translated from its key (the server sends no title). */
function groupTitle(t: Translate, key: HomeGroupKey): string {
    switch (key) {
        case 'to-do':
            return t('To review');
        case 'to-rebase':
            return t('To rebase');
        case 'mine':
            return t('My PRs');
        case 'waiting':
            return t('Waiting on the author');
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
    if (card.draft) {
        out.push(t('draft'));
    }
    const own = isOwnGroup(key);
    if (!own && card.lastReviewed === null) {
        out.push(t('not reviewed yet'));
    } else if (!own && card.newVersions > 0) {
        out.push(newVersions(l10n, card.newVersions));
        if (card.newCodeVersions !== null && card.newCodeVersions > 0) {
            out.push(t('{count} with code', { count: card.newCodeVersions }));
        }
    }
    if (card.newComments > 0) {
        out.push(`💬 ${card.newComments}`);
    }
    if (card.needsRebase === true) {
        out.push(t('to rebase'));
    }
    if (card.myApproval) {
        out.push(t('✓ approved'));
    }
    return out;
}

function contextOf(card: PrCard, me: User | null): PrContext {
    if (!card.author || card.author.uuid === me?.uuid) {
        return 'pr-readonly';
    }
    return card.followed ? 'pr-followed' : 'pr';
}

function buildIcon(card: PrCard): string | undefined {
    const state = card.build?.state;
    return state && state !== 'none' ? BUILD_ICONS[state] : undefined;
}

function prNode(l10n: L10n, card: PrCard, key: HomeGroupKey, me: User | null): PrNode {
    const extra = badges(l10n, card, key);
    return {
        ref: { workspace: card.workspace, repo: card.repo, id: card.id },
        // Repository and number before the title: easy to spot at a glance in the list. ★ marks a followed author.
        label: `${card.followed ? '★ ' : ''}${card.repo} #${card.id} · ${card.title}`,
        icon: buildIcon(card),
        contextValue: contextOf(card, me),
        author: card.author,
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

function subgroupLabel(t: Translate, label: string, cards: PrCard[], byContributor: boolean): string {
    const star = byContributor && cards.some((card) => card.followed) ? '★ ' : '';
    return `${star}${label || t('Unknown author')} (${cards.length})`;
}

/**
 * Non-empty groups, without the PRs hidden by the unfollowed filter; "Other open PRs" collapsed (expanded if the tool
 * does not know who I am). `grouping` splits "to-do" and "others" (the other groups follow `groupingFor`).
 */
export function buildHomeTree(home: Home, l10n: L10n, grouping: Grouping = 'none'): GroupNode[] {
    return visibleGroups(home).groups
        .filter((group) => group.prs.length > 0)
        .map((group) => {
            const effective = groupingFor(group.key, grouping);
            const split = groupCards(group.prs, effective);
            const nodes = (cards: PrCard[]): PrNode[] => cards.map((card) => prNode(l10n, card, group.key, home.me));
            const flat = effective === 'none';
            return {
                key: group.key,
                label: `${groupTitle(l10n.t, group.key)} (${group.prs.length})`,
                icon: ICONS[group.key],
                collapsed: group.key === 'others' && home.me !== null,
                prs: flat ? nodes(split.flatMap((sub) => sub.cards)) : [],
                subgroups: flat ? [] : split.map((sub) => ({ key: sub.key, label: subgroupLabel(l10n.t, sub.label, sub.cards, effective === 'contributor'), prs: nodes(sub.cards) })),
            };
        });
}

/** Tree line of a repository that could not be read, e.g. "acme/x: Not found on Bitbucket: ...". */
export function repoErrorLabel(t: Translate, error: Home['errors'][number]): string {
    return t('{repo}: {message}', { repo: error.repo, message: errorText(t, error) });
}

/** Tree line of a repository with more open PRs than Revspan reads. */
export function truncatedLabel(t: Translate, { repo, count }: Home['truncated'][number]): string {
    return t('{repo}: only the first {count} open PRs are listed', { repo, count });
}
