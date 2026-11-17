// Comments: drafts, line composer, replies, likes, deletion, resolution. A comment shows at once as pending, is replaced
// by the server's answer, and the PR is refreshed in the background; if the send fails, it disappears and its draft
// comes back. A like (a "👍" reply, the Bitbucket API has no reactions) shows at once too, and goes if Bitbucket refuses.
import { reactive, ref } from 'vue';
import type { Comment, Comparison, NewComment, PrRef, Thread } from '../../shared/api.ts';
import { THUMBS } from '../../shared/reactions.ts';
import { tr } from '../i18n/index.ts';
import { deletedLineComment, type ComposerTarget } from '../lib/diff.ts';
import { afterOwnWrite } from '../lib/pulse.ts';
import {
    removeComment, replaceComment, withEditedComment, withMyReaction, withMyReactionId, withoutMyReaction, withoutPlacement, withPendingComment, withPlacement,
    withReactions, withResolved, type PendingComment,
} from '../lib/optimistic.ts';
import { myLikeIds } from '../lib/threads.ts';
import { api } from '../services/api.ts';
import type { PrLoad } from './usePrLoad.ts';

export const GENERAL_DRAFT = 'general';
export const replyDraftKey = (threadId: number): string => `reply:${threadId}`;
export const editDraftKey = (commentId: number): string => `edit:${commentId}`;

/** Keys of the discussion buttons (loading indicator on the button that started the action). */
export const actionKey = {
    composer: (draftKey: string): string => `comment:${draftKey}`,
    reply: (threadId: number): string => `reply:${threadId}`,
    like: (commentId: number): string => `like:${commentId}`,
    remove: (commentId: number): string => `delete:${commentId}`,
    edit: (commentId: number): string => `edit:${commentId}`,
    resolve: (threadId: number): string => `resolve:${threadId}`,
};

export function useDiscussion(prRef: PrRef, load: PrLoad) {
    /** Texts being typed, kept when the diff redraws. */
    const drafts = reactive(new Map<string, string>());
    const composer = ref<ComposerTarget | null>(null);
    /** Id of the comment of mine being edited (one at a time); its text is the draft `edit:<id>`. */
    const editing = ref<number | null>(null);

    function draft(key: string): string {
        return drafts.get(key) ?? '';
    }

    function setDraft(key: string, value: string): void {
        if (value) {
            drafts.set(key, value);
        } else {
            drafts.delete(key);
        }
    }

    function openComposer(target: ComposerTarget): void {
        composer.value = target;
    }

    function closeComposer(): void {
        composer.value = null;
    }

    /** Puts back the text of a failed send, before anything typed in the same box since. */
    function restoreDraft(key: string, text: string): void {
        const typed = draft(key);
        setDraft(key, typed ? `${text}\n\n${typed}` : text);
    }

    /** Temporary ids of the comments being sent (negative: never a Bitbucket id). */
    let lastTempId = 0;

    interface Sending {
        /** Draft of the box the text comes from, and the typed text (restored if the send fails). */
        draftKey: string;
        text: string;
        /** Button key (single-write lock and loading indicator). */
        key: string;
        /** Line composer the text comes from: closed at once, reopened if the send fails and no other one is open. */
        target?: ComposerTarget;
    }

    function send(body: NewComment, { draftKey, text, key, target }: Sending): Promise<boolean> {
        const tempId = --lastTempId;
        const pending: PendingComment = { tempId, raw: body.raw, threadId: body.parentId ?? null, inline: body.inline ?? null };
        const { inline } = body;
        // an inline comment is only possible on the last version: its line is valid in every range that ends there
        const version = load.compare.value?.to;
        const place = (threadId: number) => (c: Comparison): Comparison =>
            (inline && c.to === version ? withPlacement(withoutPlacement(c, tempId), inline.path, threadId, inline.to) : withoutPlacement(c, tempId));
        let created: Comment | null = null;
        return load.act(async () => {
            created = await api.comment(prRef, body);
        }, {
            key,
            optimistic: () => {
                load.patchDetail((d) => withPendingComment(d, pending, d.me));
                if (inline) {
                    load.patchCompare(place(tempId));
                }
                drafts.delete(draftKey);
                if (target && composer.value?.key === target.key) {
                    composer.value = null;
                }
            },
            rollback: () => {
                load.patchDetail((d) => removeComment(d, tempId));
                if (inline) {
                    load.patchCompare((c) => withoutPlacement(c, tempId));
                }
                restoreDraft(draftKey, text);
                if (target && composer.value === null) {
                    composer.value = target;
                }
            },
            onDone: () => {
                const comment = created;
                if (!comment) {
                    return;
                }
                load.patchDetail((d) => ({ ...replaceComment(d, tempId, comment), pulse: afterOwnWrite(d.pulse, 1) }));
                if (inline) {
                    load.patchCompare(place(comment.id));
                    // the server maps the new thread into ranges ending at earlier versions: they are computed again
                    load.evictCompare((c) => c.to !== version);
                }
            },
        });
    }

    /** Inline comment (new side) or, on a deleted line, a general comment quoting it. */
    function submitComposer(target: ComposerTarget, text: string): Promise<boolean> {
        const cmp = load.compare.value;
        const sending = { draftKey: target.key, text, key: actionKey.composer(target.key), target };
        if (target.kind === 'old' && cmp) {
            return send({ raw: deletedLineComment(tr(), target.path, cmp.from, cmp.to, target.code, text) }, sending);
        }
        return send({ raw: text, inline: { path: target.path, to: target.line } }, sending);
    }

    const reply = (thread: Thread, text: string): Promise<boolean> =>
        send({ raw: text, parentId: thread.id }, { draftKey: replyDraftKey(thread.id), text, key: actionKey.reply(thread.id) });

    const postGeneral = (text: string): Promise<boolean> =>
        send({ raw: text }, { draftKey: GENERAL_DRAFT, text, key: actionKey.composer(GENERAL_DRAFT) });

    /**
     * Like: a "👍" reply to the comment, shown at once as my 👍 under it. Unlike (I already liked it): my "👍" replies
     * deleted, my 👍 gone at once. Put back as it was if Bitbucket refuses; my own write is not news for the check.
     */
    function toggleLike(comment: Comment): Promise<boolean> {
        const shown = load.detail.value.threads.flatMap((t) => t.comments).find((c) => c.id === comment.id) ?? comment;
        const before = shown.reactions;
        const mine = myLikeIds(shown);
        const key = actionKey.like(comment.id);
        if (mine.length) {
            const left = [...mine];
            return load.act(async () => {
                for (const id of mine) {
                    await api.deleteComment(prRef, id);
                    left.shift();
                }
            }, {
                key,
                optimistic: () => load.patchDetail((d) => withoutMyReaction(d, comment.id, THUMBS)),
                // the replies deleted before the refusal are gone: only the ones left stay mine
                rollback: () => load.patchDetail((d) => {
                    const restored = withReactions(d, comment.id, before.map((r) => (r.emoji === THUMBS ? { ...r, myCommentIds: left } : r)));
                    const deleted = mine.length - left.length;
                    return deleted ? { ...restored, pulse: afterOwnWrite(restored.pulse, -deleted) } : restored;
                }),
                onDone: () => load.patchDetail((d) => ({ ...d, pulse: afterOwnWrite(d.pulse, -mine.length) })),
            });
        }
        const tempId = --lastTempId;
        let created: Comment | null = null;
        return load.act(async () => {
            created = await api.comment(prRef, { raw: THUMBS, parentId: comment.id });
        }, {
            key,
            optimistic: () => load.patchDetail((d) => withMyReaction(d, comment.id, THUMBS, tempId)),
            rollback: () => load.patchDetail((d) => withReactions(d, comment.id, before)),
            onDone: () => {
                const reply = created;
                if (reply) {
                    load.patchDetail((d) => ({ ...withMyReactionId(d, comment.id, THUMBS, tempId, reply.id), pulse: afterOwnWrite(d.pulse, 1) }));
                }
            },
        });
    }

    // the confirmation is asked by the button (ConfirmButton): no optimistic delete, the comment goes once the server agreed
    const deleteComment = (comment: Comment): Promise<boolean> =>
        load.act(() => api.deleteComment(prRef, comment.id), {
            key: actionKey.remove(comment.id),
            onDone: () => load.patchDetail((d) => ({ ...removeComment(d, comment.id), pulse: afterOwnWrite(d.pulse, -1) })),
        });

    function startEdit(comment: Comment): void {
        const key = editDraftKey(comment.id);
        if (!drafts.has(key)) {
            setDraft(key, comment.raw);
        }
        editing.value = comment.id;
    }

    function cancelEdit(): void {
        if (editing.value !== null) {
            drafts.delete(editDraftKey(editing.value));
        }
        editing.value = null;
    }

    /** Saves the new text; on failure the editor stays open with the typed text (the error is shown). */
    async function saveEdit(comment: Comment, raw: string): Promise<boolean> {
        const text = raw.trim();
        if (!text) {
            return false;
        }
        if (text === comment.raw.trim()) {
            cancelEdit();
            return true;
        }
        let saved: Comment | null = null;
        const ok = await load.act(async () => {
            saved = await api.editComment(prRef, comment.id, text);
        }, {
            key: actionKey.edit(comment.id),
            onDone: () => {
                const edited = saved;
                if (edited) {
                    load.patchDetail((d) => withEditedComment(d, edited));
                }
                drafts.delete(editDraftKey(comment.id));
                if (editing.value === comment.id) {
                    editing.value = null;
                }
            },
        });
        return ok;
    }

    function resolve(thread: Thread, resolved: boolean): Promise<boolean> {
        const before = load.detail.value.threads.find((t) => t.id === thread.id) ?? thread;
        return load.act(() => api.resolve(prRef, thread.id, resolved), {
            key: actionKey.resolve(thread.id),
            optimistic: () => load.patchDetail((d) => withResolved(d, thread.id, resolved, d.me)),
            rollback: () => load.patchDetail((d) => withResolved(d, thread.id, before.resolved, before.resolvedBy)),
        });
    }

    return {
        drafts, composer, editing, startEdit, cancelEdit, saveEdit, draft, setDraft, openComposer, closeComposer, submitComposer, reply, postGeneral, toggleLike,
        deleteComment, resolve,
    };
}
