// Commentaires : brouillons, composeur de ligne, réponses, suppression, résolution.
import { reactive, ref } from 'vue';
import type { Comment, PrRef, Thread } from '../../shared/api.ts';
import { deletedLineComment, type ComposerTarget } from '../lib/diff.ts';
import { api } from '../services/api.ts';
import type { PrLoad } from './usePrLoad.ts';

export const GENERAL_DRAFT = 'general';
export const replyDraftKey = (threadId: number): string => `reply:${threadId}`;

/** Clés des boutons de discussion (indicateur de chargement sur le bouton qui a lancé l'action). */
export const actionKey = {
    composer: (draftKey: string): string => `comment:${draftKey}`,
    reply: (threadId: number): string => `reply:${threadId}`,
    remove: (commentId: number): string => `delete:${commentId}`,
    resolve: (threadId: number): string => `resolve:${threadId}`,
};

export function useDiscussion(prRef: PrRef, load: PrLoad) {
    /** Textes en cours de saisie, conservés quand le diff se redessine. */
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

    /** Commentaire en ligne (côté nouveau) ou, sur une ligne supprimée, commentaire général qui la cite. */
    function submitComposer(target: ComposerTarget, text: string): Promise<boolean> {
        const done = (): void => {
            drafts.delete(target.key);
            composer.value = null;
        };
        const cmp = load.compare.value;
        const key = actionKey.composer(target.key);
        if (target.kind === 'old' && cmp) {
            const raw = deletedLineComment(target.path, cmp.from, cmp.to, target.code, text);
            return load.act(() => api.comment(prRef, { raw }), { onDone: done, key });
        }
        return load.act(() => api.comment(prRef, { raw: text, inline: { path: target.path, to: target.line } }), { onDone: done, reloadCompare: true, key });
    }

    const reply = (thread: Thread, text: string): Promise<boolean> =>
        load.act(() => api.comment(prRef, { raw: text, parentId: thread.id }), { onDone: () => drafts.delete(replyDraftKey(thread.id)), key: actionKey.reply(thread.id) });

    const postGeneral = (text: string): Promise<boolean> =>
        load.act(() => api.comment(prRef, { raw: text }), { onDone: () => drafts.delete(GENERAL_DRAFT), key: actionKey.composer(GENERAL_DRAFT) });

    // la confirmation est demandée par le bouton (ConfirmButton)
    const deleteComment = (comment: Comment): Promise<boolean> =>
        load.act(() => api.deleteComment(prRef, comment.id), { key: actionKey.remove(comment.id) });

    const resolve = (thread: Thread, resolved: boolean): Promise<boolean> =>
        load.act(() => api.resolve(prRef, thread.id, resolved), { key: actionKey.resolve(thread.id) });

    return { drafts, composer, draft, setDraft, openComposer, closeComposer, submitComposer, reply, postGeneral, deleteComment, resolve };
}
