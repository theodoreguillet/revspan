// Comments: drafts, line composer, replies, deletion, resolution.
import { reactive, ref } from 'vue';
import type { Comment, PrRef, Thread } from '../../shared/api.ts';
import { tr } from '../i18n/index.ts';
import { deletedLineComment, type ComposerTarget } from '../lib/diff.ts';
import { api } from '../services/api.ts';
import type { PrLoad } from './usePrLoad.ts';

export const GENERAL_DRAFT = 'general';
export const replyDraftKey = (threadId: number): string => `reply:${threadId}`;

/** Keys of the discussion buttons (loading indicator on the button that started the action). */
export const actionKey = {
    composer: (draftKey: string): string => `comment:${draftKey}`,
    reply: (threadId: number): string => `reply:${threadId}`,
    remove: (commentId: number): string => `delete:${commentId}`,
    resolve: (threadId: number): string => `resolve:${threadId}`,
};

export function useDiscussion(prRef: PrRef, load: PrLoad) {
    /** Texts being typed, kept when the diff redraws. */
    const drafts = reactive(new Map<string, string>());
    const composer = ref<ComposerTarget | null>(null);

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

    /** Inline comment (new side) or, on a deleted line, a general comment quoting it. */
    function submitComposer(target: ComposerTarget, text: string): Promise<boolean> {
        const done = (): void => {
            drafts.delete(target.key);
            composer.value = null;
        };
        const cmp = load.compare.value;
        const key = actionKey.composer(target.key);
        if (target.kind === 'old' && cmp) {
            const raw = deletedLineComment(tr(), target.path, cmp.from, cmp.to, target.code, text);
            return load.act(() => api.comment(prRef, { raw }), { onDone: done, key });
        }
        return load.act(() => api.comment(prRef, { raw: text, inline: { path: target.path, to: target.line } }), { onDone: done, reloadCompare: true, key });
    }

    const reply = (thread: Thread, text: string): Promise<boolean> =>
        load.act(() => api.comment(prRef, { raw: text, parentId: thread.id }), { onDone: () => drafts.delete(replyDraftKey(thread.id)), key: actionKey.reply(thread.id) });

    const postGeneral = (text: string): Promise<boolean> =>
        load.act(() => api.comment(prRef, { raw: text }), { onDone: () => drafts.delete(GENERAL_DRAFT), key: actionKey.composer(GENERAL_DRAFT) });

    // the confirmation is asked by the button (ConfirmButton)
    const deleteComment = (comment: Comment): Promise<boolean> =>
        load.act(() => api.deleteComment(prRef, comment.id), { key: actionKey.remove(comment.id) });

    const resolve = (thread: Thread, resolved: boolean): Promise<boolean> =>
        load.act(() => api.resolve(prRef, thread.id, resolved), { key: actionKey.resolve(thread.id) });

    return { drafts, composer, draft, setDraft, openComposer, closeComposer, submitComposer, reply, postGeneral, deleteComment, resolve };
}
