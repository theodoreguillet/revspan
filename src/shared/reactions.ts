// Reactions and shown comments. The Bitbucket API has no reactions: a like is a reply made of a single emoji ("👍"), and
// such replies show as reactions under the comment they answer, never as comments, so no comment count of the page
// includes them (threads, "new" marks, home badges). Bitbucket keeps a deleted comment in its lists with its text
// blanked: it is shown (as deleted) only while a shown comment is under it. Shared by the server (threads, home) and the
// page (like button).

/** The emoji the like button posts. */
export const THUMBS = '👍';

/**
 * Texts of a reply that make it a reaction, with the emoji it shows as: the emoji itself (variation selector and skin
 * tone removed first, see `bareText`), Bitbucket's shortcodes, "+1" and "(y)".
 */
const REACTION_ALIASES = new Map<string, string>([
    ['👍', THUMBS], [':+1:', THUMBS], [':thumbsup:', THUMBS], ['+1', THUMBS], ['(y)', THUMBS],
    ['👏', '👏'], [':clap:', '👏'],
    ['🎉', '🎉'], [':tada:', '🎉'],
    ['❤', '❤️'], [':heart:', '❤️'],
    ['🚀', '🚀'], [':rocket:', '🚀'],
    ['👀', '👀'], [':eyes:', '👀'],
    ['✅', '✅'], [':white_check_mark:', '✅'],
]);

/** Emoji presentation selector (U+FE0F) and the five skin tone modifiers: "👍🏽" and "❤️" read as 👍 and ❤. */
const EMOJI_MODIFIERS = /[\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu;

const bareText = (raw: string): string => raw.trim().replace(EMOJI_MODIFIERS, '');

/**
 * The emoji of a text made of a single emoji (or one of its aliases); null for any other text, zero-width-joiner
 * sequences and flags included.
 */
export function reactionOf(raw: unknown): string | null {
    return typeof raw === 'string' ? REACTION_ALIASES.get(bareText(raw)) ?? null : null;
}

/** What the classification reads of a Bitbucket comment. */
export interface ReplyShape {
    id: number;
    parent?: { id: number } | null;
    /** A deleted comment stays in Bitbucket's lists with its text blanked: never a reaction. */
    deleted?: boolean;
    content?: { raw?: string } | null;
}

/** How the comments of a PR show. */
export interface CommentClasses {
    /** Replies shown as reactions, by id, with their emoji. */
    reactions: Map<number, string>;
    /** Deleted comments shown nowhere: no shown comment under them. */
    hidden: Set<number>;
}

type Kind = 'comment' | 'reaction' | 'hidden';

/**
 * Classifies the comments of a PR from the leaves up:
 * - a reaction is a live reply made of a single emoji, to a comment of the list, with nothing shown under it (neither a
 *   comment nor a reaction): an answered one stays a comment, so that what answers it keeps its place;
 * - a deleted comment is hidden unless a shown comment is under it (a reaction alone does not keep it: it goes with it);
 * - every other comment is shown.
 */
export function classifyComments(comments: readonly ReplyShape[]): CommentClasses {
    const ids = new Set(comments.map((c) => c.id));
    const parentOf = (c: ReplyShape): number | null => (c.parent?.id !== undefined && ids.has(c.parent.id) ? c.parent.id : null);
    const children = new Map<number, ReplyShape[]>();
    for (const c of comments) {
        const parent = parentOf(c);
        if (parent !== null) {
            children.set(parent, [...children.get(parent) ?? [], c]);
        }
    }
    const reactions = new Map<number, string>();
    const hidden = new Set<number>();
    const kinds = new Map<number, Kind>();
    // `path`: the comments above, so that a parent loop in bad data cannot recurse forever
    const kindOf = (c: ReplyShape, path: Set<number>): Kind => {
        const known = kinds.get(c.id);
        if (known) {
            return known;
        }
        const inner = new Set(path).add(c.id);
        const below = (children.get(c.id) ?? []).filter((child) => !inner.has(child.id)).map((child) => kindOf(child, inner));
        const emoji = !c.deleted && parentOf(c) !== null ? reactionOf(c.content?.raw) : null;
        let kind: Kind;
        if (emoji && below.every((k) => k === 'hidden')) {
            kind = 'reaction';
            reactions.set(c.id, emoji);
        } else if (!c.deleted || below.includes('comment')) {
            kind = 'comment';
        } else {
            kind = 'hidden';
            hidden.add(c.id);
        }
        kinds.set(c.id, kind);
        return kind;
    };
    for (const c of comments) {
        kindOf(c, new Set());
    }
    return { reactions, hidden };
}

/** Replies shown as reactions, by id, with their emoji (see `classifyComments`). */
export const reactionReplies = (comments: readonly ReplyShape[]): Map<number, string> => classifyComments(comments).reactions;
