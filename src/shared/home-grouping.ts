// Home subgroups: cards of a home group split by repository, by contributor, or not at all (pure, no Vue).
import type { HomeGroupKey, PrCard } from './api.ts';

export type Grouping = 'repository' | 'contributor' | 'none';

export const GROUPINGS: readonly Grouping[] = ['repository', 'contributor', 'none'];

export const isGrouping = (value: unknown): value is Grouping => GROUPINGS.includes(value as Grouping);

export interface CardGroup {
    key: string;
    /** Repository "workspace/repo", author name, or "" (no grouping, or unknown author). */
    label: string;
    cards: PrCard[];
}

const NO_GROUP_KEY = 'all';

/** The groups that hold my own PRs: "to-rebase" (destination moved since their base) and "mine". */
export const isOwnGroup = (group: HomeGroupKey): boolean => group === 'to-rebase' || group === 'mine';

/**
 * The user's choice applies to "to-do" and "others"; my own PRs ("to-rebase", "mine") are always by repository,
 * "waiting" is not grouped.
 */
export function groupingFor(group: HomeGroupKey, choice: Grouping): Grouping {
    if (isOwnGroup(group)) {
        return 'repository';
    }
    if (group === 'waiting') {
        return 'none';
    }
    return choice;
}

/** Followed authors first, then the most recent push first. */
function byFollowedThenPush(a: PrCard, b: PrCard): number {
    return Number(b.followed) - Number(a.followed) || b.lastPushAt.localeCompare(a.lastPushAt);
}

function keyOf(card: PrCard, grouping: Grouping): { key: string; label: string } {
    if (grouping === 'repository') {
        const fullName = `${card.workspace}/${card.repo}`;
        return { key: fullName, label: fullName };
    }
    return { key: card.author?.uuid ?? '', label: card.author?.displayName ?? '' };
}

/** Repositories by name; contributors followed first, then by name, the unknown author last. */
function compareGroups(grouping: Grouping): (a: CardGroup, b: CardGroup) => number {
    if (grouping === 'repository') {
        return (a, b) => a.label.localeCompare(b.label);
    }
    const followed = (g: CardGroup): number => Number(g.cards.some((c) => c.followed));
    return (a, b) => Number(a.key === '') - Number(b.key === '') || followed(b) - followed(a) || a.label.localeCompare(b.label);
}

export function groupCards(cards: readonly PrCard[], grouping: Grouping): CardGroup[] {
    if (!cards.length) {
        return [];
    }
    if (grouping === 'none') {
        return [{ key: NO_GROUP_KEY, label: '', cards: [...cards].sort(byFollowedThenPush) }];
    }
    const groups = new Map<string, CardGroup>();
    for (const card of cards) {
        const { key, label } = keyOf(card, grouping);
        let group = groups.get(key);
        if (!group) {
            group = { key, label, cards: [] };
            groups.set(key, group);
        }
        group.cards.push(card);
    }
    const list = [...groups.values()];
    for (const group of list) {
        group.cards.sort(byFollowedThenPush);
    }
    return list.sort(compareGroups(grouping));
}
