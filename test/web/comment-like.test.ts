import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { Comment, PrDetail } from '../../src/shared/api.ts';
import { providePrPage, type PrPage } from '../../src/web/composables/usePrPage.ts';
import CommentItem from '../../src/web/components/CommentItem.vue';
import { prLong } from './fixtures.ts';

const { api } = vi.hoisted(() => ({ api: { pr: vi.fn(), summary: vi.fn(), compare: vi.fn(), comment: vi.fn(), deleteComment: vi.fn() } }));
vi.mock('../../src/web/services/api.ts', async (importOriginal) => ({ ...await importOriginal<object>(), api }));
vi.mock('../../src/web/composables/useErrors.ts', () => ({ showError: vi.fn() }));

const ref = { workspace: 'acme', repo: 'records-api', id: 212 };

/** Thread 120 of the long PR: Yann's question, Camille's answer (already liked by me, reply 131). */
describe('like button and reaction chips of a comment', () => {
    let unmount: () => void = () => undefined;

    beforeEach(() => {
        vi.clearAllMocks();
        api.summary.mockReturnValue(new Promise(() => undefined));
        api.pr.mockReturnValue(new Promise(() => undefined));
        api.compare.mockReturnValue(new Promise(() => undefined));
    });

    afterEach(() => unmount());

    async function mountThread(detail: PrDetail): Promise<{ root: HTMLElement; page: PrPage }> {
        let page: PrPage | null = null;
        const Root = defineComponent({
            setup() {
                const created = providePrPage(ref, detail);
                page = created;
                return () => h('div', created.detail.threads.find((t) => t.id === 120)?.comments.map((comment) => h(CommentItem, { key: comment.id, comment })));
            },
        });
        const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/pr/:ws/:repo/:id', name: 'pr', component: Root }] });
        await router.push(`/pr/${ref.workspace}/${ref.repo}/${ref.id}`);
        const root = document.createElement('div');
        const app = createApp(Root).use(router);
        app.mount(root);
        unmount = () => app.unmount();
        if (!page) {
            throw new Error('page not created');
        }
        await nextTick();
        return { root, page };
    }

    const item = (root: HTMLElement, id: number): HTMLElement => {
        const el = root.querySelector<HTMLElement>(`.rv-cm[data-comment="${id}"]`);
        if (!el) {
            throw new Error(`no comment ${id}`);
        }
        return el;
    };
    const likeButton = (root: HTMLElement, id: number): HTMLButtonElement | null => item(root, id).querySelector('[data-action="like"]');
    const chips = (root: HTMLElement, id: number): string[] =>
        [...item(root, id).querySelectorAll('.rv-react')].map((c) => `${c.textContent?.trim()}${c.classList.contains('mine') ? ' (mine)' : ''}`);

    it('a 👍 button on each comment, pressed on the one I liked; my chip highlighted, names in its tooltip', async () => {
        const { root } = await mountThread(prLong().data);
        expect(likeButton(root, 120)?.getAttribute('aria-pressed')).toBe('false');
        expect(likeButton(root, 120)?.title).toBe('Like');
        expect(likeButton(root, 121)?.getAttribute('aria-pressed')).toBe('true');
        expect(likeButton(root, 121)?.title).toBe('Remove your 👍');
        expect(chips(root, 120)).toEqual([]);
        expect(chips(root, 121)).toEqual(['👍 1 (mine)']);
        expect(item(root, 121).querySelector<HTMLElement>('.rv-react')?.title).toBe('Thomas Girard (you)');
    });

    it('a click likes at once, the chip shows before Bitbucket answers', async () => {
        const { root } = await mountThread(prLong().data);
        api.comment.mockReturnValue(new Promise<Comment>(() => undefined));
        likeButton(root, 120)?.click();
        await nextTick();
        expect(api.comment).toHaveBeenCalledWith(ref, { raw: '👍', parentId: 120 });
        expect(chips(root, 120)).toEqual(['👍 1 (mine)']);
        expect(likeButton(root, 120)?.getAttribute('aria-pressed')).toBe('true');
        // one write at a time: every like button waits for this one
        expect(likeButton(root, 121)?.disabled).toBe(true);
    });

    it('no 👍 button on a deleted comment, one being sent, or without my profile (my 👍 could not be told apart)', async () => {
        const base = prLong().data;
        const thread = base.threads.find((t) => t.id === 120);
        if (!thread) {
            throw new Error('no thread 120');
        }
        const deleted: PrDetail = {
            ...base,
            threads: base.threads.map((t) => (t.id === 120
                ? { ...t, comments: [...t.comments.map((c) => (c.id === 121 ? { ...c, deleted: true, html: '', raw: '' } : c)), { ...t.comments[0]!, id: -1, pending: true as const, reactions: [] }] }
                : t)),
        };
        const { root } = await mountThread(deleted);
        expect(likeButton(root, 120)).not.toBeNull();
        expect(likeButton(root, 121)).toBeNull();
        expect(likeButton(root, -1)).toBeNull();
        unmount();

        const anonymous = await mountThread({ ...base, me: null });
        expect(likeButton(anonymous.root, 120)).toBeNull();
        // the chips still show
        expect(chips(anonymous.root, 121)).toHaveLength(1);
    });
});
