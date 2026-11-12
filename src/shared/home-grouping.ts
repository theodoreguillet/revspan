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

/** Most recent push first. */
function byLastPush(a: PrCard, b: PrCard): number {
    return b.lastPushAt.localeCompare(a.lastPushAt);
}

function keyOf(card: PrCard, grouping: Grouping): { key: string; label: string } {
    if (grouping === 'repository') {
        const fullName = `${card.workspace}/${card.repo}`;
        return { key: fullName, label: fullName };
    }
    return { key: card.author?.uuid ?? '', label: card.author?.displayName ?? '' };
}

/** Subgroups by their most recent PR (cards are already sorted newest first), then by name. */
function bySubgroupRecency(a: CardGroup, b: CardGroup): number {
    return (b.cards[0]?.lastPushAt ?? '').localeCompare(a.cards[0]?.lastPushAt ?? '') || a.label.localeCompare(b.label);
}

export function groupCards(cards: readonly PrCard[], grouping: Grouping): CardGroup[] {
    if (!cards.length) {
        return [];
    }
    if (grouping === 'none') {
        return [{ key: NO_GROUP_KEY, label: '', cards: [...cards].sort(byLastPush) }];
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
        group.cards.sort(byLastPush);
    }
    return list.sort(bySubgroupRecency);
}
