// Display filter of the home (page and VS Code tree): the PRs of contributors I do not follow can be hidden. Pure, no Vue.
// Notifications read the whole home: hiding a PR never changes what is notified or recorded.
import type { Home, HomeGroup, HomeGroupKey, PrCard } from './api.ts';
import { isOwnGroup } from './home-grouping.ts';

export interface VisibleHome {
    /** The home groups, without the hidden PRs (a group may end up empty). */
    groups: HomeGroup[];
    /** PRs left out because their author is not followed. */
    hidden: number;
}

/** Shown whatever the setting: my PRs, a followed author's, the ones I am a designated reviewer of or reviewed or approved. */
export function alwaysShown(group: HomeGroupKey, card: PrCard): boolean {
    return isOwnGroup(group) || card.followed || card.designatedReviewer || card.lastReviewed !== null || card.myApproval;
}

/** The groups to list. `home.hideUnfollowed` is already off while nobody is followed (the server decides it). */
export function visibleGroups(home: Pick<Home, 'groups' | 'hideUnfollowed'>): VisibleHome {
    if (!home.hideUnfollowed) {
        return { groups: home.groups, hidden: 0 };
    }
    let hidden = 0;
    const groups = home.groups.map((group) => {
        const prs = group.prs.filter((card) => alwaysShown(group.key, card));
        hidden += group.prs.length - prs.length;
        return { ...group, prs };
    });
    return { groups, hidden };
}
