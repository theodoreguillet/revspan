// Followed contributors: the list saved in the settings, and the home cards marked from it.
import type { Home } from './api.ts';
import type { FollowedUser } from './review-settings.ts';

/** The followed list with `user` added (once) or removed (by uuid). */
export function withFollowed(list: readonly FollowedUser[], user: FollowedUser, follow: boolean): FollowedUser[] {
    const others = list.filter((u) => u.uuid !== user.uuid);
    if (!follow) {
        return others;
    }
    return list.some((u) => u.uuid === user.uuid) ? [...list] : [...list, { uuid: user.uuid, displayName: user.displayName }];
}

/** A new home whose cards are marked followed from `list` (the server's cards stay untouched). */
export function withFollowedCards(home: Home, list: readonly FollowedUser[]): Home {
    const uuids = new Set(list.map((u) => u.uuid));
    return {
        ...home,
        groups: home.groups.map((group) => ({
            ...group,
            prs: group.prs.map((card) => ({ ...card, followed: !!card.author && uuids.has(card.author.uuid) })),
        })),
    };
}
