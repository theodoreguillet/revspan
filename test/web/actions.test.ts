import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, effectScope, nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { Comparison, FileDiff, PrDetail, Summary, Version } from '../../src/shared/api.ts';
import { useDiffOptions } from '../../src/web/composables/useDiffOptions.ts';
import { replyDraftKey, useDiscussion } from '../../src/web/composables/useDiscussion.ts';
import { usePrLoad } from '../../src/web/composables/usePrLoad.ts';
import { useRangeSelection } from '../../src/web/composables/useRangeSelection.ts';
import { useReviewActions } from '../../src/web/composables/useReviewActions.ts';
import { setLocale } from '../../src/web/i18n/index.ts';
import { ApiError } from '../../src/web/services/api.ts';
import { prLong, threadById } from './fixtures.ts';

const { api, showError } = vi.hoisted(() => ({
    api: { pr: vi.fn(), approve: vi.fn(), summary: vi.fn(), compare: vi.fn(), viewed: vi.fn(), comment: vi.fn() },
    showError: vi.fn(),
}));
vi.mock('../../src/web/services/api.ts', async (importOriginal) => ({ ...await importOriginal<object>(), api }));
vi.mock('../../src/web/composables/useErrors.ts', () => ({ showError }));

const ref = { workspace: 'acme', repo: 'records-api', id: 212 };

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

/** Lets already-resolved promises through (reloads started without awaiting). */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

const summaryOf = (detail: PrDetail): Summary => ({ versions: [...prLong().sums.values()].filter((s) => s.index <= detail.versions.length) });

function comparison(messageTo: string): Comparison {
    return {
        from: 7, to: 10, stats: { files: 0, added: 0, removed: 0 }, files: [], masterOnly: [], messageChanged: false, messageFrom: '', messageTo,
    };
}

function fileDiff(path: string, contentHash: string): FileDiff {
    return {
        path, oldPath: null, status: 'modified', category: 'code', binary: false, tooLarge: false, added: 1, removed: 0, contentHash, conflict: false,
        hunks: [], threads: [],
    };
}

describe('PR page actions: loading indicator', () => {
    let detail: PrDetail;

    beforeEach(() => {
        vi.clearAllMocks();
        detail = prLong().data;
        api.pr.mockResolvedValue(detail);
    });

    it('button "in progress" during the write and the reload, one action at a time', async () => {
        const load = usePrLoad(ref, detail);
        const write = deferred();
        api.approve.mockReturnValue(write.promise);

        const running = load.act(() => api.approve(ref, true), { key: 'approve' });
        expect(load.pendingAction.value).toBe('approve');
        expect(load.busy('approve')).toBe(true);
        expect(load.busy('request-changes')).toBe(false);
        expect(load.acting.value).toBe(true);
        expect(await load.act(() => api.approve(ref, false), { key: 'approve' })).toBe(false);

        write.resolve();
        expect(await running).toBe(true);
        expect(api.pr).toHaveBeenCalledTimes(1);
        expect(load.acting.value).toBe(false);
    });

    it('write refused: error shown, button released, no reload', async () => {
        const load = usePrLoad(ref, detail);
        const write = deferred();
        const running = load.act(() => write.promise, { key: 'resolve:1' });
        write.reject(new Error('boom'));
        expect(await running).toBe(false);
        expect(showError).toHaveBeenCalledOnce();
        expect(api.pr).not.toHaveBeenCalled();
        expect(load.pendingAction.value).toBeNull();
    });
});

describe('another action in progress (Cmd/Ctrl+Enter during a write)', () => {
    let detail: PrDetail;

    beforeEach(() => {
        setLocale('fr');
        vi.clearAllMocks();
        detail = prLong().data;
        api.pr.mockResolvedValue(detail);
    });

    afterEach(() => setLocale('en'));

    it('message shown, nothing is sent, draft kept', async () => {
        const load = usePrLoad(ref, detail);
        const discussion = useDiscussion(ref, load);
        const thread = threadById(detail, detail.threads[0]?.id ?? 0);
        const write = deferred();
        const running = load.act(() => write.promise, { key: 'approve' });

        discussion.setDraft(replyDraftKey(thread.id), 'Ma réponse');
        expect(await discussion.reply(thread, 'Ma réponse')).toBe(false);
        expect(api.comment).not.toHaveBeenCalled();
        expect(discussion.draft(replyDraftKey(thread.id))).toBe('Ma réponse');
        expect(showError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Une autre action est en cours, réessaie dans un instant.' }));

        write.resolve();
        expect(await running).toBe(true);
    });
});

describe('reload: consistent summary and detail', () => {
    let detail: PrDetail;

    beforeEach(() => {
        vi.clearAllMocks();
        detail = prLong().data;
        api.pr.mockResolvedValue(detail);
        api.summary.mockResolvedValue(summaryOf(detail));
        api.approve.mockResolvedValue({ ok: true });
    });

    const pushed = (base: PrDetail, change: (versions: Version[]) => Version[]): PrDetail => ({ ...base, versions: change(base.versions) });
    const v11 = (versions: Version[]): Version => ({ ...versions[9] as Version, index: 11, hash: 'f'.repeat(40), shortHash: 'fffffff' });

    it('same version list after a write: summary not requested again', async () => {
        const load = usePrLoad(ref, detail);
        await load.loadSummary();
        expect(await load.act(() => api.approve(ref, true))).toBe(true);
        await settle();
        expect(api.summary).toHaveBeenCalledTimes(1);
    });

    it('new version pushed while reading: the reload after a write reloads the summary too', async () => {
        const load = usePrLoad(ref, detail);
        await load.loadSummary();
        const after = pushed(detail, (versions) => [...versions, v11(versions)]);
        const fresh: Summary = { versions: [...summaryOf(detail).versions, { index: 11, kind: 'code', added: 1, removed: 0, files: [], masterFiles: 0, conflicts: 0 }] };
        api.pr.mockResolvedValue(after);
        api.summary.mockResolvedValue(fresh);

        expect(await load.act(() => api.approve(ref, true))).toBe(true);
        await vi.waitFor(() => expect(load.summary.value).toBe(fresh));
        expect(load.detail.value).toBe(after);
        expect(load.sums.value.get(11)?.kind).toBe('code');
    });

    it('latest version replaced (same count, other hash): summary reloaded', async () => {
        const load = usePrLoad(ref, detail);
        await load.loadSummary();
        api.pr.mockResolvedValue(pushed(detail, (versions) => versions.map((v) => (v.index === 10 ? { ...v, hash: 'e'.repeat(40) } : v))));
        await load.act(() => api.approve(ref, true));
        await vi.waitFor(() => expect(api.summary).toHaveBeenCalledTimes(2));
    });

    it('two summaries in flight: an older response does not overwrite the most recent one', async () => {
        const load = usePrLoad(ref, detail);
        const first = deferred<Summary>();
        const second = deferred<Summary>();
        api.summary.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const loadingFirst = load.loadSummary();
        const loadingSecond = load.loadSummary();
        const fresh = summaryOf(detail);
        second.resolve(fresh);
        await loadingSecond;
        first.resolve({ versions: [] });
        await loadingFirst;
        expect(load.summary.value).toBe(fresh);
    });

    it('the summary discovers an erased version that the detail thinks is readable: detail reloaded once', async () => {
        const load = usePrLoad(ref, detail);
        api.summary.mockResolvedValue({ versions: summaryOf(detail).versions.map((s) => (s.index === 7 ? { ...s, kind: 'unavailable' as const } : s)) });
        const purged = pushed(detail, (versions) => versions.map((v) => (v.index === 7 ? { ...v, available: false } : v)));
        api.pr.mockResolvedValue(purged);

        await load.loadSummary();
        expect(api.pr).toHaveBeenCalledTimes(1);
        expect(load.detail.value).toBe(purged);
        expect(api.summary).toHaveBeenCalledTimes(1);
    });

    it('... and if the server still says it is readable: no loop', async () => {
        const load = usePrLoad(ref, detail);
        api.summary.mockResolvedValue({ versions: summaryOf(detail).versions.map((s) => (s.index === 7 ? { ...s, kind: 'unavailable' as const } : s)) });

        await load.loadSummary();
        await settle();
        expect(api.pr).toHaveBeenCalledTimes(1);
        expect(api.summary).toHaveBeenCalledTimes(1);
    });
});

describe('comparison in flight and forced reload', () => {
    let detail: PrDetail;

    beforeEach(() => {
        vi.clearAllMocks();
        detail = prLong().data;
        api.pr.mockResolvedValue(detail);
    });

    it('an unforced response arriving after the forced reload writes neither the cache nor the diff', async () => {
        const load = usePrLoad(ref, detail);
        const params = { from: 7, to: 10, context: 3 };
        const stale = deferred<Comparison>();
        const fresh = deferred<Comparison>();
        api.compare.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);

        const loading = load.loadCompare(params);
        const acting = load.act(() => Promise.resolve(), { reloadCompare: true });
        await vi.waitFor(() => expect(api.compare).toHaveBeenCalledTimes(2));
        const fresher = comparison('nouveau fil placé');
        fresh.resolve(fresher);
        expect(await acting).toBe(true);
        stale.resolve(comparison('avant le commentaire'));
        await loading;

        expect(load.compare.value).toBe(fresher);
        expect(load.compareLoading.value).toBe(false);
        await load.loadCompare(params);
        expect(load.compare.value).toBe(fresher);
        expect(api.compare).toHaveBeenCalledTimes(2);
    });
});

describe('comparison refused because a bound was erased by Bitbucket (410 VERSION_UNAVAILABLE)', () => {
    let detail: PrDetail;
    const Blank = defineComponent({ render: () => null });
    const gone = (version: number): ApiError => new ApiError(410, 'VERSION_UNAVAILABLE', `Version v${version} is no longer available.`, { version });

    beforeEach(() => {
        vi.clearAllMocks();
        detail = prLong().data;
    });

    /** PR data and range on a real router (in-memory history), as under PrLoaded. */
    async function setup(query: string) {
        const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/pr/:ws/:repo/:id', name: 'pr', component: Blank }] });
        await router.push(`/pr/${ref.workspace}/${ref.repo}/${ref.id}${query}`);
        const app = createApp(Blank).use(router);
        const scope = effectScope();
        const load = usePrLoad(ref, detail);
        const range = app.runWithContext(() => scope.run(() => useRangeSelection(ref, load.detail)));
        if (!range) {
            throw new Error('range not created');
        }
        return { load, range, current: (): [number, number] => [range.from.value, range.to.value], stop: () => scope.stop() };
    }

    it('detail reloaded once: the erased bound is repaired, and a second refusal for it does not reload again', async () => {
        const purged = { ...detail, versions: detail.versions.map((v) => (v.index === 7 ? { ...v, available: false } : v)) };
        api.pr.mockResolvedValue(purged);
        api.compare.mockRejectedValue(gone(7));
        const { load, current, stop } = await setup('?from=7&to=10');
        expect(current()).toEqual([7, 10]);

        await load.loadCompare({ from: 7, to: 10, context: 3 });
        expect(api.pr).toHaveBeenCalledTimes(1);
        expect(load.detail.value).toBe(purged);
        await nextTick();
        expect(current()).toEqual([6, 10]);

        // The server still refuses a range on v7 (stale cache): no reload loop.
        await load.loadCompare({ from: 7, to: 10, context: 3 });
        expect(api.pr).toHaveBeenCalledTimes(1);
        stop();
    });

    it('other errors: no detail reload', async () => {
        api.compare.mockRejectedValue(new ApiError(502, 'BB_ERROR', 'Bitbucket error.'));
        const { load, stop } = await setup('?from=7&to=10');
        await load.loadCompare({ from: 7, to: 10, context: 3 });
        expect(api.pr).not.toHaveBeenCalled();
        expect(showError).toHaveBeenCalledTimes(1);
        stop();
    });
});

describe('optimistic "Seen"', () => {
    let detail: PrDetail;

    beforeEach(() => {
        vi.clearAllMocks();
        const data = prLong().data;
        detail = { ...data, review: { ...data.review, viewed: { 'src/C.ts': 'hc-old' } } };
    });

    function setup() {
        const load = usePrLoad(ref, detail);
        return { load, review: useReviewActions(ref, load, useDiffOptions(load.detail), () => undefined) };
    }

    it('"Seen" refused on A after a successful "Seen" on B: only A is rolled back', async () => {
        const { load, review } = setup();
        const onA = deferred<{ ok: true }>();
        api.viewed.mockImplementation((_ref: unknown, body: { path: string }) => (body.path === 'src/A.ts' ? onA.promise : Promise.resolve({ ok: true })));

        const markingA = review.setViewed(fileDiff('src/A.ts', 'ha'), true);
        await review.setViewed(fileDiff('src/B.ts', 'hb'), true);
        onA.reject(new Error('refusé'));
        await markingA;

        expect(load.detail.value.review.viewed).toEqual({ 'src/C.ts': 'hc-old', 'src/B.ts': 'hb' });
        expect(showError).toHaveBeenCalledOnce();
    });

    it('untick refused: the file gets its tick and fingerprint back', async () => {
        const { load, review } = setup();
        api.viewed.mockRejectedValue(new Error('refusé'));
        await review.setViewed(fileDiff('src/C.ts', 'hc-new'), false);
        expect(load.detail.value.review.viewed).toEqual({ 'src/C.ts': 'hc-old' });
    });
});
