import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Comment, Comparison, DiffLine, PrDetail } from '../../src/shared/api.ts';
import { replyDraftKey, useDiscussion } from '../../src/web/composables/useDiscussion.ts';
import { usePrLoad } from '../../src/web/composables/usePrLoad.ts';
import { composerTargetFor } from '../../src/web/lib/diff.ts';
import { prLong, threadById } from './fixtures.ts';

const { api, showError } = vi.hoisted(() => ({
    api: { pr: vi.fn(), summary: vi.fn(), compare: vi.fn(), comment: vi.fn(), approve: vi.fn() },
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
    return { id, user: me, createdOn: '2026-11-16T10:00:00Z', version: null, html: `<p>${raw}</p>`, raw, isNew: false, deleted: false, mine: true };
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
});
