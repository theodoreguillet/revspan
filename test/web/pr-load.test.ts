import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { Comment, Comparison, DiffLine, PrDetail, Summary } from '../../src/shared/api.ts';
import { actionKey, replyDraftKey, useDiscussion } from '../../src/web/composables/useDiscussion.ts';
import { setHostVisible } from '../../src/web/composables/usePageVisible.ts';
import { usePrLoad, type PrLoad } from '../../src/web/composables/usePrLoad.ts';
import { providePrPage, type PrPage } from '../../src/web/composables/usePrPage.ts';
import { composerTargetFor } from '../../src/web/lib/diff.ts';
import { SKELETON_DELAY_MS } from '../../src/web/lib/loading.ts';
import { presets } from '../../src/web/lib/selection.ts';
import { commentById, prLong, threadById } from './fixtures.ts';

const { api, showError } = vi.hoisted(() => ({
    api: { pr: vi.fn(), summary: vi.fn(), compare: vi.fn(), comment: vi.fn(), deleteComment: vi.fn(), approve: vi.fn(), viewed: vi.fn() },
    showError: vi.fn(),
}));
vi.mock('../../src/web/services/api.ts', async (importOriginal) => ({ ...await importOriginal<object>(), api }));
vi.mock('../../src/web/composables/useErrors.ts', () => ({ showError }));

const ref = { workspace: 'acme', repo: 'records-api', id: 212 };
const me = { uuid: '{me-uuid}', displayName: 'Thomas Girard', nickname: 'tgirard' };

/** Promise resolved or rejected by hand (slow request). */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((ok, ko) => {
        resolve = ok;
        reject = ko;
    });
    return { promise, resolve, reject };
}

/** Lets already-resolved promises through (background refreshes started without awaiting). */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

function serverComment(id: number, raw: string): Comment {
    return { id, user: me, createdOn: '2026-11-16T10:00:00Z', version: null, html: `<p>${raw}</p>`, raw, isNew: false, deleted: false, mine: true, reactions: [], parentId: null };
}

const codeLine: DiffLine = { t: '+', o: null, n: 12, text: 'const x = 1;', hl: [] };

function comparison(from: number, to: number, label = ''): Comparison {
    return {
        from, to, stats: { files: 1, added: 1, removed: 0 }, masterOnly: [], messageChanged: false, messageFrom: '', messageTo: label,
        files: [{
            path: 'src/A.ts', oldPath: null, status: 'modified', category: 'code', binary: false, tooLarge: false, added: 1, removed: 0, contentHash: 'h', conflict: false,
            hunks: [{ oldStart: 12, oldLines: 0, newStart: 12, newLines: 1, header: '', lines: [codeLine] }], threads: [],
        }],
    };
}

const pendingIn = (detail: PrDetail): Comment[] => detail.threads.flatMap((t) => t.comments).filter((c) => c.pending || c.id < 0);

describe('PR page writes without waiting for a reload', () => {
    let detail: PrDetail;

    beforeEach(() => {
        vi.clearAllMocks();
        detail = prLong().data;
        api.pr.mockResolvedValue(detail);
        api.summary.mockResolvedValue({ versions: [] });
    });

    it('shows a comment before the server answers', async () => {
        const load = usePrLoad(ref, detail);
        const discussion = useDiscussion(ref, load);
        const thread = threadById(detail, 120);
        const sent = deferred<Comment>();
        api.comment.mockReturnValue(sent.promise);
        const refresh = deferred<PrDetail>();
        api.pr.mockReturnValue(refresh.promise);
        discussion.setDraft(replyDraftKey(120), 'On it');

        const sending = discussion.reply(thread, 'On it');
        expect(threadById(load.detail.value, 120).comments.at(-1)).toMatchObject({ raw: 'On it', pending: true });
        expect(discussion.draft(replyDraftKey(120))).toBe('');
        expect(api.pr).not.toHaveBeenCalled();

        sent.resolve(serverComment(501, 'On it'));
        expect(await sending).toBe(true);
        expect(threadById(load.detail.value, 120).comments.at(-1)).toEqual(serverComment(501, 'On it'));
        expect(load.pendingAction.value).toBeNull();
        // the refresh runs in the background, without holding the write lock
        expect(api.pr).toHaveBeenCalledOnce();
        expect(load.refreshing.value).toBe(true);
        refresh.resolve(detail);
        await vi.waitFor(() => expect(load.refreshing.value).toBe(false));
    });

    it('the background refresh asks for a fresh detail', async () => {
        const load = usePrLoad(ref, detail);
        await load.refreshDetail();
        expect(api.pr).toHaveBeenCalledWith(ref, { fresh: true });
    });

    it('restores the draft after a failed send', async () => {
        api.compare.mockImplementation((_ref: unknown, from: number, to: number) => Promise.resolve(comparison(from, to)));
        const load = usePrLoad(ref, detail);
        const discussion = useDiscussion(ref, load);
        await load.loadCompare({ from: 7, to: 10, context: 3 });
        const target = composerTargetFor('src/A.ts', codeLine, 'both');
        if (!target) {
            throw new Error('no composer target');
        }
        const sent = deferred<Comment>();
        api.comment.mockReturnValue(sent.promise);
        discussion.openComposer(target);
        discussion.setDraft(target.key, 'Rename this');

        const sending = discussion.submitComposer(target, 'Rename this');
        expect(pendingIn(load.detail.value)).toHaveLength(1);
        expect(discussion.composer.value).toBeNull();
        // the range changes before the server answers
        discussion.closeComposer();
        await load.loadCompare({ from: 9, to: 10, context: 3 });

        sent.reject(new Error('refused'));
        expect(await sending).toBe(false);
        expect(discussion.draft(target.key)).toBe('Rename this');
        expect(pendingIn(load.detail.value)).toEqual([]);
        expect(load.detail.value.threads).toHaveLength(detail.threads.length);
        expect(load.compare.value?.files[0]?.threads).toEqual([]);
        await load.loadCompare({ from: 7, to: 10, context: 3 });
        expect(load.compare.value?.files[0]?.threads).toEqual([]);
        expect(discussion.composer.value).toEqual(target);
        expect(showError).toHaveBeenCalledOnce();
        await settle();
        expect(api.pr).not.toHaveBeenCalled();
    });

    it('does not recompute the diff after an inline comment', async () => {
        api.compare.mockImplementation((_ref: unknown, from: number, to: number) => Promise.resolve(comparison(from, to)));
        api.comment.mockResolvedValue(serverComment(502, 'Rename this'));
        api.pr.mockReturnValue(new Promise(() => undefined));
        const load = usePrLoad(ref, detail);
        const discussion = useDiscussion(ref, load);
        await load.loadCompare({ from: 7, to: 10, context: 3 });
        const target = composerTargetFor('src/A.ts', codeLine, 'both');
        if (!target) {
            throw new Error('no composer target');
        }

        expect(await discussion.submitComposer(target, 'Rename this')).toBe(true);
        await settle();

        expect(api.compare).toHaveBeenCalledOnce();
        expect(load.compare.value?.files[0]?.threads).toEqual([{ threadId: 502, line: 12, moved: false, outOfHunks: false }]);
        expect(threadById(load.detail.value, 502)).toMatchObject({ path: 'src/A.ts', anchor: { to: 12, from: null } });
        expect(api.pr).toHaveBeenCalledOnce();
    });

    it('drops a refresh that started before the latest write', async () => {
        const load = usePrLoad(ref, detail);
        const discussion = useDiscussion(ref, load);
        const early = deferred<PrDetail>();
        api.pr.mockReturnValueOnce(early.promise);
        api.approve.mockResolvedValue({ ok: true });
        expect(await load.act(() => api.approve(ref, true), { key: 'approve' })).toBe(true);
        expect(api.pr).toHaveBeenCalledOnce();
        expect(load.refreshing.value).toBe(true);

        const sent = deferred<Comment>();
        api.comment.mockReturnValue(sent.promise);
        const sending = discussion.reply(threadById(detail, 120), 'On it');
        // the refresh read the PR before the comment: applying it would erase the pending comment
        early.resolve(detail);
        await settle();
        expect(threadById(load.detail.value, 120).comments.at(-1)).toMatchObject({ raw: 'On it', pending: true });

        const after: PrDetail = {
            ...detail,
            threads: detail.threads.map((t) => (t.id === 120 ? { ...t, comments: [...t.comments, { ...serverComment(501, 'On it'), version: 10 }] } : t)),
        };
        api.pr.mockResolvedValue(after);
        sent.resolve(serverComment(501, 'On it'));
        expect(await sending).toBe(true);
        await vi.waitFor(() => expect(load.detail.value).toBe(after));
        expect(api.pr).toHaveBeenCalledTimes(2);
        expect(load.refreshing.value).toBe(false);
    });

    it('keeps the selected range when responses arrive out of order', async () => {
        const load = usePrLoad(ref, detail);
        const slowA = deferred<Comparison>();
        const fastB = deferred<Comparison>();
        api.compare.mockImplementation((_ref: unknown, from: number) => (from === 7 ? slowA.promise : fastB.promise));
        const a = { from: 7, to: 10, context: 3 };
        const b = { from: 9, to: 10, context: 3 };
        const responseA = comparison(7, 10, 'A');

        const loadingA = load.loadCompare(a);
        const loadingB = load.loadCompare(b);
        fastB.resolve(comparison(9, 10, 'B'));
        await loadingB;
        expect(load.compare.value?.messageTo).toBe('B');
        const loadingA2 = load.loadCompare(a);
        expect(load.compareLoading.value).toBe(true);
        slowA.resolve(responseA);
        await Promise.all([loadingA, loadingA2]);

        expect(load.compare.value).toBe(responseA);
        expect(load.compareLoading.value).toBe(false);
        expect(api.compare).toHaveBeenCalledTimes(2);
    });

    it('computes again a cached range that ends before the last version after an inline comment', async () => {
        api.compare.mockImplementation((_ref: unknown, from: number, to: number) => Promise.resolve(comparison(from, to)));
        api.comment.mockResolvedValue(serverComment(502, 'Rename this'));
        api.pr.mockReturnValue(new Promise(() => undefined));
        const load = usePrLoad(ref, detail);
        const discussion = useDiscussion(ref, load);
        await load.loadCompare({ from: 7, to: 9, context: 3 });
        await load.loadCompare({ from: 7, to: 10, context: 3 });
        const target = composerTargetFor('src/A.ts', codeLine, 'both');
        if (!target) {
            throw new Error('no composer target');
        }

        expect(await discussion.submitComposer(target, 'Rename this')).toBe(true);
        // the server maps the new thread into every range: the cached v7 → v9 lacks it
        await load.loadCompare({ from: 7, to: 9, context: 3 });
        expect(api.compare).toHaveBeenCalledTimes(3);
        expect(api.compare).toHaveBeenLastCalledWith(ref, 7, 9, 3);
        // the range ending at the last version keeps its local placement, without a new computation
        await load.loadCompare({ from: 7, to: 10, context: 3 });
        expect(api.compare).toHaveBeenCalledTimes(3);
        expect(load.compare.value?.files[0]?.threads).toEqual([{ threadId: 502, line: 12, moved: false, outOfHunks: false }]);
    });

    it('does not keep a diff computed before a new inline thread', async () => {
        const stale = deferred<Comparison>();
        const placed = comparison(9, 10, 'with the new thread');
        api.compare
            .mockResolvedValueOnce(comparison(7, 10))
            .mockReturnValueOnce(stale.promise)
            .mockResolvedValueOnce(placed);
        api.comment.mockResolvedValue(serverComment(502, 'Rename this'));
        api.pr.mockReturnValue(new Promise(() => undefined));
        const load = usePrLoad(ref, detail);
        const discussion = useDiscussion(ref, load);
        await load.loadCompare({ from: 7, to: 10, context: 3 });
        const target = composerTargetFor('src/A.ts', codeLine, 'both');
        if (!target) {
            throw new Error('no composer target');
        }

        const loading = load.loadCompare({ from: 9, to: 10, context: 3 });
        expect(await discussion.submitComposer(target, 'Rename this')).toBe(true);
        stale.resolve(comparison(9, 10, 'before the comment'));
        await loading;

        expect(load.compare.value).toBe(placed);
        expect(load.compareLoading.value).toBe(false);
        expect(api.compare).toHaveBeenCalledTimes(3);
        await load.loadCompare({ from: 9, to: 10, context: 3 });
        expect(load.compare.value).toBe(placed);
        expect(api.compare).toHaveBeenCalledTimes(3);
    });

    it('shows an error thrown after a successful write and still refreshes', async () => {
        const load = usePrLoad(ref, detail);
        const ok = await load.act(() => Promise.resolve(), {
            onDone: () => {
                throw new Error('local update failed');
            },
        });

        expect(ok).toBe(true);
        expect(showError).toHaveBeenCalledWith(expect.objectContaining({ message: 'local update failed' }));
        expect(load.pendingAction.value).toBeNull();
        expect(api.pr).toHaveBeenCalledOnce();
    });
});

describe('PR page likes (👍 replies) without waiting for a reload', () => {
    let detail: PrDetail;

    beforeEach(() => {
        vi.clearAllMocks();
        detail = { ...prLong().data, pulse: { updatedOn: '2026-11-16T10:00:00Z', head: 'head', commentCount: 10, participants: '', taskCount: 0 } };
        api.pr.mockResolvedValue(detail);
        api.summary.mockResolvedValue({ versions: [] });
    });

    it('a like shows at once as my 👍, posts a "👍" reply to that comment, then refreshes in the background', async () => {
        const load = usePrLoad(ref, detail);
        const discussion = useDiscussion(ref, load);
        const sent = deferred<Comment>();
        api.comment.mockReturnValue(sent.promise);
        const refresh = deferred<PrDetail>();
        api.pr.mockReturnValue(refresh.promise);

        const liking = discussion.toggleLike(commentById(detail, 120));
        const shown = commentById(load.detail.value, 120).reactions;
        expect(shown).toMatchObject([{ emoji: '👍', users: [me] }]);
        expect(shown[0]?.myCommentIds).toHaveLength(1);
        expect(shown[0]?.myCommentIds[0]).toBeLessThan(0);
        // a reaction, never a reply card
        expect(threadById(load.detail.value, 120).comments).toHaveLength(2);
        expect(api.comment).toHaveBeenCalledWith(ref, { raw: '👍', parentId: 120 });
        // the lock covers the write only
        expect(load.busy(actionKey.like(120))).toBe(true);

        sent.resolve(serverComment(601, '👍'));
        expect(await liking).toBe(true);
        expect(commentById(load.detail.value, 120).reactions).toEqual([{ emoji: '👍', users: [me], myCommentIds: [601] }]);
        expect(load.pendingAction.value).toBeNull();
        // my own reply moves the check baseline: Bitbucket's comment count includes it
        expect(load.detail.value.pulse).toMatchObject({ commentCount: 11, updatedOn: '' });
        expect(api.pr).toHaveBeenCalledOnce();
        expect(load.refreshing.value).toBe(true);
        refresh.resolve(detail);
        await vi.waitFor(() => expect(load.refreshing.value).toBe(false));
    });

    it('a like Bitbucket refuses is taken back, without a refresh', async () => {
        const load = usePrLoad(ref, detail);
        const discussion = useDiscussion(ref, load);
        api.comment.mockRejectedValue(new Error('refused'));

        expect(await discussion.toggleLike(commentById(detail, 120))).toBe(false);
        expect(commentById(load.detail.value, 120).reactions).toEqual([]);
        expect(load.detail.value.pulse).toEqual(detail.pulse);
        expect(showError).toHaveBeenCalledOnce();
        await settle();
        expect(api.pr).not.toHaveBeenCalled();
    });

    it('clicking 👍 again deletes my 👍 reply at once; a refusal puts it back', async () => {
        const load = usePrLoad(ref, detail);
        const discussion = useDiscussion(ref, load);
        const before = commentById(detail, 121).reactions;
        expect(before).toMatchObject([{ emoji: '👍', myCommentIds: [131] }]);
        const refused = deferred<{ ok: true }>();
        api.deleteComment.mockReturnValue(refused.promise);

        const failing = discussion.toggleLike(commentById(detail, 121));
        expect(commentById(load.detail.value, 121).reactions).toEqual([]);
        expect(api.deleteComment).toHaveBeenCalledWith(ref, 131);
        expect(api.comment).not.toHaveBeenCalled();
        refused.reject(new Error('refused'));
        expect(await failing).toBe(false);
        expect(commentById(load.detail.value, 121).reactions).toEqual(before);
        expect(api.pr).not.toHaveBeenCalled();

        api.deleteComment.mockResolvedValue({ ok: true });
        // the background refresh stays in flight: the local state is what shows meanwhile
        api.pr.mockReturnValue(new Promise(() => undefined));
        expect(await discussion.toggleLike(commentById(load.detail.value, 121))).toBe(true);
        expect(commentById(load.detail.value, 121).reactions).toEqual([]);
        expect(threadById(load.detail.value, 120).comments.map((c) => c.id)).toEqual([120, 121]);
        expect(load.detail.value.pulse).toMatchObject({ commentCount: 9, updatedOn: '' });
        expect(api.pr).toHaveBeenCalledOnce();
    });

    it('unlike deletes each of my 👍 replies; when one is refused, only the ones left stay mine', async () => {
        const yann = { uuid: '{yan}', displayName: 'Yann Bernard' };
        const twice: PrDetail = {
            ...detail,
            threads: detail.threads.map((t) => (t.id === 120
                ? { ...t, comments: t.comments.map((c) => (c.id === 121 ? { ...c, reactions: [{ emoji: '👍', users: [me, yann], myCommentIds: [131, 132] }] } : c)) }
                : t)),
        };
        const load = usePrLoad(ref, twice);
        const discussion = useDiscussion(ref, load);
        api.deleteComment.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('refused'));

        expect(await discussion.toggleLike(commentById(twice, 121))).toBe(false);
        expect(api.deleteComment.mock.calls).toEqual([[ref, 131], [ref, 132]]);
        expect(commentById(load.detail.value, 121).reactions).toEqual([{ emoji: '👍', users: [me, yann], myCommentIds: [132] }]);
        // the deleted one is my own write: not news for the check
        expect(load.detail.value.pulse).toMatchObject({ commentCount: 9, updatedOn: '' });
    });

    it('a refresh that started before the like does not erase it', async () => {
        const load = usePrLoad(ref, detail);
        const discussion = useDiscussion(ref, load);
        const early = deferred<PrDetail>();
        api.pr.mockReturnValueOnce(early.promise);
        void load.refreshDetail();
        const sent = deferred<Comment>();
        api.comment.mockReturnValue(sent.promise);

        const liking = discussion.toggleLike(commentById(detail, 120));
        early.resolve(detail);
        await settle();
        expect(commentById(load.detail.value, 120).reactions).toHaveLength(1);
        const after: PrDetail = {
            ...detail,
            threads: detail.threads.map((t) => (t.id === 120
                ? { ...t, comments: t.comments.map((c) => (c.id === 120 ? { ...c, reactions: [{ emoji: '👍', users: [me], myCommentIds: [601] }] } : c)) }
                : t)),
        };
        api.pr.mockResolvedValue(after);
        sent.resolve(serverComment(601, '👍'));
        expect(await liking).toBe(true);
        await vi.waitFor(() => expect(load.detail.value).toBe(after));
    });
});

describe('PR page loading and prefetch', () => {
    let detail: PrDetail;
    const started: PrLoad[] = [];
    // 6 versions, last reviewed v2: since = v2 → v6, last = v5 → v6, all = master → v6
    const plan = () => ({ presets: presets(6, 2), context: 3 });
    const since = { from: 2, to: 6, context: 3 };

    /** Summary of a PR touching `count` distinct files. */
    const summaryOf = (count: number): Summary => ({
        versions: [{
            index: 1, kind: 'code', added: count, removed: 0, masterFiles: 0, conflicts: 0,
            files: Array.from({ length: count }, (_, i) => ({ path: `src/F${i}.ts`, added: 1, removed: 0, category: 'code' as const })),
        }],
    });

    /** Page data whose prefetch is started, the version summary (PR size) loaded. */
    async function prefetching(files = 4): Promise<PrLoad> {
        api.summary.mockResolvedValue(summaryOf(files));
        const load = usePrLoad(ref, detail);
        load.startPrefetch(plan);
        started.push(load);
        await load.loadSummary();
        return load;
    }

    beforeEach(() => {
        vi.clearAllMocks();
        detail = prLong().data;
        setHostVisible(true);
    });

    afterEach(() => {
        started.splice(0).forEach((load) => load.stopPrefetch());
        setHostVisible(true);
        vi.useRealTimers();
    });

    it('switches to the skeleton 200 ms after a user request', async () => {
        vi.useFakeTimers();
        const slow = deferred<Comparison>();
        api.compare.mockResolvedValueOnce(comparison(2, 6)).mockReturnValueOnce(slow.promise);
        const load = usePrLoad(ref, detail);
        expect(load.diffMode.value).toBe('skeleton');
        await load.loadCompare(since);
        expect(load.diffMode.value).toBe('diff');

        const loading = load.loadCompare({ from: 3, to: 6, context: 3 });
        expect(load.diffMode.value).toBe('progress');
        vi.advanceTimersByTime(199);
        expect(load.diffMode.value).toBe('progress');
        vi.advanceTimersByTime(1);
        expect(load.diffMode.value).toBe('skeleton');
        slow.resolve(comparison(3, 6));
        await loading;
        expect(load.diffMode.value).toBe('diff');
        load.stopPrefetch();
    });

    it('prefetches only while visible', async () => {
        const last = deferred<Comparison>();
        api.compare.mockImplementation((_ref: unknown, from: number, to: number) => (from === 5 ? last.promise : Promise.resolve(comparison(from, to))));
        setHostVisible(false);
        const load = await prefetching();
        await load.loadCompare(since);
        await settle();
        expect(api.compare).toHaveBeenCalledOnce();

        setHostVisible(true);
        await vi.waitFor(() => expect(api.compare).toHaveBeenCalledTimes(2));
        expect(api.compare).toHaveBeenLastCalledWith(ref, 5, 6, 3);
        // one range at a time
        await settle();
        expect(api.compare).toHaveBeenCalledTimes(2);

        // hidden while a range is computed: it lands in the cache, the next one waits
        setHostVisible(false);
        last.resolve(comparison(5, 6));
        await settle();
        expect(api.compare).toHaveBeenCalledTimes(2);

        setHostVisible(true);
        await vi.waitFor(() => expect(api.compare).toHaveBeenCalledTimes(3));
        expect(api.compare).toHaveBeenLastCalledWith(ref, 0, 6, 3);
        await settle();
        expect(api.compare).toHaveBeenCalledTimes(3);

        // a click on a prefetched preset shows it at once
        await load.loadCompare({ from: 5, to: 6, context: 3 });
        expect(load.compare.value?.to).toBe(6);
        expect(load.compareLoading.value).toBe(false);
        expect(api.compare).toHaveBeenCalledTimes(3);
    });

    it('a user selection overtakes the prefetch', async () => {
        const last = deferred<Comparison>();
        const picked = deferred<Comparison>();
        api.compare.mockImplementation((_ref: unknown, from: number, to: number) => {
            if (from === 5) {
                return last.promise;
            }
            return from === 3 ? picked.promise : Promise.resolve(comparison(from, to, `${from}-${to}`));
        });
        const load = await prefetching();
        await load.loadCompare(since);
        await vi.waitFor(() => expect(api.compare).toHaveBeenCalledTimes(2));

        const picking = load.loadCompare({ from: 3, to: 6, context: 3 });
        // asked at once, not queued behind the prefetch
        expect(api.compare).toHaveBeenCalledTimes(3);
        last.resolve(comparison(5, 6, 'prefetched'));
        await settle();
        // the prefetch lands in the cache without replacing the diff, and nothing else starts while the user waits
        expect(load.compare.value?.messageTo).toBe('2-6');
        expect(load.compareLoading.value).toBe(true);
        expect(api.compare).toHaveBeenCalledTimes(3);

        picked.resolve(comparison(3, 6, 'picked'));
        await picking;
        expect(load.compare.value?.messageTo).toBe('picked');
        await vi.waitFor(() => expect(api.compare).toHaveBeenCalledTimes(4));
        expect(api.compare).toHaveBeenLastCalledWith(ref, 0, 6, 3);

        await load.loadCompare({ from: 5, to: 6, context: 3 });
        expect(load.compare.value?.messageTo).toBe('prefetched');
        expect(api.compare).toHaveBeenCalledTimes(4);
    });

    it('a selection of the range being prefetched waits for the same request', async () => {
        const last = deferred<Comparison>();
        api.compare.mockImplementation((_ref: unknown, from: number, to: number) => (from === 5 ? last.promise : Promise.resolve(comparison(from, to))));
        const load = await prefetching();
        await load.loadCompare(since);
        await vi.waitFor(() => expect(api.compare).toHaveBeenCalledTimes(2));

        const picking = load.loadCompare({ from: 5, to: 6, context: 3 });
        last.resolve(comparison(5, 6, 'shared'));
        await picking;
        expect(load.compare.value?.messageTo).toBe('shared');
        expect(api.compare.mock.calls.filter(([, from]) => from === 5)).toHaveLength(1);
    });

    it('does not prefetch a large PR, even when the diff shown is small, and stops for good', async () => {
        api.compare.mockImplementation((_ref: unknown, from: number, to: number) => Promise.resolve(comparison(from, to)));
        const large = await prefetching(31);
        await large.loadCompare(since);
        await settle();
        expect(api.compare).toHaveBeenCalledOnce();

        vi.clearAllMocks();
        api.compare.mockImplementation((_ref: unknown, from: number, to: number) => Promise.resolve(comparison(from, to)));
        setHostVisible(false);
        const left = await prefetching();
        await left.loadCompare(since);
        left.stopPrefetch();
        setHostVisible(true);
        await settle();
        expect(api.compare).toHaveBeenCalledOnce();
    });

    it('waits for the PR size from the version summary', async () => {
        const summary = deferred<Summary>();
        api.summary.mockReturnValue(summary.promise);
        api.compare.mockImplementation((_ref: unknown, from: number, to: number) => Promise.resolve(comparison(from, to)));
        const load = usePrLoad(ref, detail);
        load.startPrefetch(plan);
        started.push(load);
        const summaryLoad = load.loadSummary();
        await load.loadCompare(since);
        await settle();
        expect(api.compare).toHaveBeenCalledOnce();

        summary.resolve(summaryOf(4));
        await summaryLoad;
        await vi.waitFor(() => expect(api.compare).toHaveBeenCalledTimes(3));
    });

    it('prefetches only with the default context', async () => {
        api.compare.mockImplementation((_ref: unknown, from: number, to: number) => Promise.resolve(comparison(from, to)));
        let context = 100000;
        api.summary.mockResolvedValue(summaryOf(4));
        const load = usePrLoad(ref, detail);
        load.startPrefetch(() => ({ presets: presets(6, 2), context }));
        started.push(load);
        await load.loadSummary();
        await load.loadCompare({ ...since, context });
        await settle();
        expect(api.compare).toHaveBeenCalledOnce();

        context = 3;
        await load.loadCompare(since);
        await vi.waitFor(() => expect(api.compare).toHaveBeenCalledTimes(4));
        context = 100000;
        await load.loadCompare({ ...since, context });
        await settle();
        expect(api.compare).toHaveBeenCalledTimes(4);
    });

    it('prefetches again a preset dropped by a new inline thread', async () => {
        const last = deferred<Comparison>();
        let first = true;
        api.compare.mockImplementation((_ref: unknown, from: number, to: number) => {
            if (from === 5 && first) {
                first = false;
                return last.promise;
            }
            return Promise.resolve(comparison(from, to));
        });
        const load = await prefetching();
        await load.loadCompare(since);
        await vi.waitFor(() => expect(api.compare).toHaveBeenCalledTimes(2));

        load.evictCompare((c) => c.to !== 6);
        last.resolve(comparison(5, 6, 'stale'));
        await vi.waitFor(() => expect(api.compare).toHaveBeenCalledTimes(4));
        expect(api.compare.mock.calls.filter(([, from]) => from === 5)).toHaveLength(2);
    });
});

describe('PR page while a slow diff loads', () => {
    let detail: PrDetail;
    let unmount: () => void = () => undefined;

    beforeEach(() => {
        vi.clearAllMocks();
        detail = prLong().data;
        api.summary.mockReturnValue(new Promise(() => undefined));
        api.pr.mockReturnValue(new Promise(() => undefined));
    });

    afterEach(() => {
        unmount();
        vi.useRealTimers();
    });

    /** The PR page state under a component, on an in-memory router, range v7 → v10 shown. */
    async function mountPage(): Promise<PrPage> {
        let page: PrPage | null = null;
        // also the route's component: never rendered (no <router-view>)
        const Root = defineComponent({
            setup() {
                page = providePrPage(ref, detail);
                return () => null;
            },
        });
        const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/pr/:ws/:repo/:id', name: 'pr', component: Root }] });
        await router.push(`/pr/${ref.workspace}/${ref.repo}/${ref.id}?from=7&to=10`);
        const app = createApp(Root).use(router);
        app.mount(document.createElement('div'));
        unmount = () => app.unmount();
        if (!page) {
            throw new Error('page not created');
        }
        const created: PrPage = page;
        await vi.waitFor(() => expect(created.compare?.from).toBe(7));
        return created;
    }

    it('ignores j, k and v under the skeleton', async () => {
        const slow = deferred<Comparison>();
        api.compare.mockImplementation((_ref: unknown, from: number, to: number) => (from === 9 ? slow.promise : Promise.resolve(comparison(from, to))));
        const page = await mountPage();
        // the skeleton's 200 ms on a fake clock: the test never depends on how fast the machine is
        vi.useFakeTimers();
        page.select(9, 10);
        await nextTick();
        expect(page.diffMode).toBe('progress');
        vi.advanceTimersByTime(SKELETON_DELAY_MS);
        expect(page.diffMode).toBe('skeleton');

        expect(page.handleKey('j')).toBe(false);
        expect(page.handleKey('k')).toBe(false);
        expect(page.handleKey('v')).toBe(false);
        expect(api.viewed).not.toHaveBeenCalled();
        slow.resolve(comparison(9, 10));
        await vi.waitFor(() => expect(page.diffMode).toBe('diff'));
    });

    it('Shift+V marks every file, a bare "V" (Caps Lock) does not', async () => {
        api.viewed.mockResolvedValue({ ok: true });
        const page = await mountPage();
        expect(page.handleKey('V')).toBe(false);
        expect(page.handleKey('V', { shiftKey: false })).toBe(false);
        expect(api.viewed).not.toHaveBeenCalled();
        expect(page.handleKey('V', { shiftKey: true })).toBe(true);
        await vi.waitFor(() => expect(api.viewed).toHaveBeenCalledOnce());
        expect(api.viewed.mock.calls[0]?.[1]).toMatchObject({ viewed: true, files: expect.any(Array) });
    });

    it('closes a composer opened on the previous diff when the new one shows', async () => {
        const slow = deferred<Comparison>();
        api.compare.mockImplementation((_ref: unknown, from: number, to: number) => (from === 9 ? slow.promise : Promise.resolve(comparison(from, to))));
        const page = await mountPage();
        // the previous diff stays (no skeleton) whatever the machine's speed: the 200 ms run on a fake clock
        vi.useFakeTimers();
        page.select(9, 10);
        await nextTick();
        expect(page.diffMode).toBe('progress');
        // the previous diff is still shown: a composer opened on it
        const target = composerTargetFor('src/A.ts', codeLine, 'both');
        if (!target) {
            throw new Error('no composer target');
        }
        page.openComposer(target);

        slow.resolve(comparison(9, 10));
        await vi.waitFor(() => expect(page.compare?.from).toBe(9));
        await nextTick();
        expect(page.composer).toBeNull();
    });
});
