// Reactions. The Bitbucket API has none: a like is a reply made of a single emoji ("👍"), and such replies show as
// reactions under the comment they answer, never as comments, so no comment count includes them (threads, "new" marks,
// home badges). Shared by the server (threads, home) and the page (like button).

/** The emoji the like button posts. */
export const THUMBS = '👍';

/** Texts of a reply that make it a reaction, with the emoji it shows as (Bitbucket shortcodes and "+1" included). */
const REACTION_ALIASES = new Map<string, string>([
    ['👍', THUMBS], [':+1:', THUMBS], [':thumbsup:', THUMBS], ['+1', THUMBS], ['(y)', THUMBS],
    ['👏', '👏'], ['🎉', '🎉'], ['❤️', '❤️'], ['🚀', '🚀'], ['👀', '👀'], ['✅', '✅'],
]);

/** The emoji of a text made of a single emoji (or one of its aliases); null for any other text. */
export function reactionOf(raw: unknown): string | null {
    return typeof raw === 'string' ? REACTION_ALIASES.get(raw.trim()) ?? null : null;
}

/** What the classification reads of a Bitbucket comment. */
export interface ReplyShape {
    id: number;
    parent?: { id: number } | null;
    deleted?: boolean;
    content?: { raw?: string } | null;
}

/**
 * Replies shown as reactions, by id, with their emoji: a reply made of a single emoji to a comment of the list, that
 * nobody answered (an answered one stays a comment, so that its replies keep their place). Deleted ones are included
 * when Bitbucket still gives their text: a like taken back shows neither as a reaction nor as a deleted comment.
 */
export function reactionReplies(comments: readonly ReplyShape[]): Map<number, string> {
    const ids = new Set(comments.map((c) => c.id));
    const answered = new Set(comments.flatMap((c) => (c.parent?.id ? [c.parent.id] : [])));
    const reactions = new Map<number, string>();
    for (const c of comments) {
        const emoji = c.parent?.id && ids.has(c.parent.id) && !answered.has(c.id) ? reactionOf(c.content?.raw) : null;
        if (emoji) {
            reactions.set(c.id, emoji);
        }
    }
    return reactions;
}
