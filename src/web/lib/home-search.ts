// Home search: does a PR card match what was typed? Case- and accent-insensitive substring, no regex.
import type { PrCard } from '../../shared/api.ts';

/** Lower case without accents ("Évaluer" and "evaluer" compare equal). */
const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** The query is in the title, `#id`, repository or author name of the card. A blank query matches every card. */
export function matchesPrQuery(card: PrCard, query: string): boolean {
    const needle = fold(query.trim());
    if (!needle) {
        return true;
    }
    return fold([card.title, `#${card.id}`, card.repo, card.author?.displayName ?? ''].join('\n')).includes(needle);
}
