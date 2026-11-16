import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, reactive, type EffectScope } from 'vue';
import type { Comment, Comparison, PrDetail, PrPulse, Thread } from '../../src/shared/api.ts';
import { setHostVisible } from '../../src/web/composables/usePageVisible.ts';
import { usePrLoad } from '../../src/web/composables/usePrLoad.ts';
import { usePulse, type PulsePage } from '../../src/web/composables/usePulse.ts';
import { translatorFor } from '../../src/web/i18n/index.ts';
import {
    hasNews, pulseIntervalMs, pulseNews, pulseText, refreshNews, refreshText, unplacedThreads, type RefreshNews,
} from '../../src/web/lib/pulse.ts';
import { prLong } from './fixtures.ts';

const { api, showError } = vi.hoisted(() => ({
    api: { pr: vi.fn(), summary: vi.fn(), compare: vi.fn(), pulse: vi.fn() },
    showError: vi.fn(),
}));
vi.mock('../../src/web/services/api.ts', async (importOriginal) => ({ ...await importOriginal<object>(), api }));
vi.mock('../../src/web/composables/useErrors.ts', () => ({ showError }));

const ref = { workspace: 'acme', repo: 'records-api', id: 212 };
const yann = { uuid: '{yan}', displayName: 'Yann Bernard', nickname: 'ybernard' };
const MINUTE = 60_000;

const pulse = (over: Partial<PrPulse> = {}): PrPulse => ({
    updatedOn: '2026-11-16T10:00:00Z', head: 'abc123', commentCount: 4, participants: '{yan}:1:approved', ...over,
});

function comment(id: number, raw: string, over: Partial<Comment> = {}): Comment {
    return { id, user: yann, createdOn: '2026-11-16T10:00:00Z', version: 10, html: `<p>${raw}</p>`, raw, isNew: true, deleted: false, mine: false, ...over };
}

/** The long PR's detail with a pulse and a freshness (read `loadedAt`, interval `minutes`). */
function detailOf(loadedAt = '2026-11-16T10:00:00Z', minutes = 5, p: PrPulse = pulse()): PrDetail {
    return { ...prLong().data, pulse: p, freshness: { loadedAt, refreshMinutes: minutes } };
}

const withThread = (d: PrDetail, thread: Thread): PrDetail => ({ ...d, threads: [...d.threads, thread] });

function inlineThread(id: number, path: string): Thread {
    return { id, path, anchor: { to: 3, from: null }, version: 10, resolved: false, resolvedBy: null, comments: [comment(id, 'Why?')] };
}

function comparison(from: number, to: number, paths: string[], placed: number[] = []): Comparison {
    return {
        from, to, stats: { files: paths.length, added: 1, removed: 0 }, masterOnly: [], messageChanged: false, messageFrom: '', messageTo: '',
        files: paths.map((path, i) => ({
            path, oldPath: null, status: 'modified' as const, category: 'code' as const, binary: false, tooLarge: false, added: 1, removed: 0,
            contentHash: 'h', conflict: false, hunks: [],
            threads: i === 0 ? placed.map((threadId) => ({ threadId, line: 3, moved: false, outOfHunks: false })) : [],
        })),
    };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((ok) => {
        resolve = ok;
    });
    return { promise, resolve };
}

describe('pulse: what changed on Bitbucket', () => {
    it('pulseNews sees a new head', () => {
        expect(pulseNews(pulse(), pulse({ head: 'def456', updatedOn: '2026-11-16T10:05:00Z' })))
            .toEqual({ newVersion: true, newComments: 0, otherActivity: false });
    });

    it('pulseNews counts new comments', () => {
        expect(pulseNews(pulse(), pulse({ commentCount: 6, updatedOn: '2026-11-16T10:05:00Z' })))
            .toEqual({ newVersion: false, newComments: 2, otherActivity: false });
    });

    it('pulseNews reports other activity when only updatedOn moved', () => {
        const news = pulseNews(pulse(), pulse({ updatedOn: '2026-11-16T10:05:00Z' }));
        expect(news).toEqual({ newVersion: false, newComments: 0, otherActivity: true });
        expect(hasNews(news)).toBe(true);
    });

    it('pulseNews reports an approval as other activity', () => {
        expect(pulseNews(pulse(), pulse({ participants: '{cam}:1:approved,{yan}:1:approved' })).otherActivity).toBe(true);
    });

    it('pulseNews has no news for an equal pulse', () => {
        const news = pulseNews(pulse(), pulse());
        expect(news).toEqual({ newVersion: false, newComments: 0, otherActivity: false });
        expect(hasNews(news)).toBe(false);
    });

    it('checks at the configured interval', () => {
        expect(pulseIntervalMs(5)).toBe(5 * MINUTE);
        expect(pulseIntervalMs(1)).toBe(MINUTE);
    });

    it('refreshNews counts new comments and versions', () => {
        const before = detailOf();
        const pushed = { ...before.versions[9]!, index: 11, hash: 'new-head' };
        const after = withThread({ ...before, versions: [...before.versions, pushed] }, inlineThread(900, 'src/A.ts'));
        const reply = { ...after, threads: after.threads.map((t) => (t.id === 110 ? { ...t, comments: [...t.comments, comment(901, 'Done')] } : t)) };
        expect(refreshNews(before, reply)).toEqual({ newVersions: 1, newComments: 2, otherChanges: false });
    });

    it('refreshNews is empty when nothing changed', () => {
        const before = detailOf();
        expect(refreshNews(before, detailOf('2026-11-16T10:07:00Z'))).toEqual({ newVersions: 0, newComments: 0, otherChanges: false });
    });

    it('refreshNews sees resolutions, edits, deletions and approvals as other changes', () => {
        const before = detailOf();
        const resolved = { ...before, threads: before.threads.map((t) => (t.id === 120 ? { ...t, resolved: true } : t)) };
        const edited = { ...before, threads: before.threads.map((t) => (t.id === 110 ? { ...t, comments: t.comments.map((c) => ({ ...c, raw: 'edited' })) } : t)) };
        const deleted = { ...before, threads: before.threads.map((t) => (t.id === 110 ? { ...t, comments: t.comments.map((c) => ({ ...c, deleted: true })) } : t)) };
        const unapproved = { ...before, participants: before.participants.map((p) => ({ ...p, approved: false, state: null })) };
        for (const after of [resolved, edited, deleted, unapproved]) {
            expect(refreshNews(before, after)).toEqual({ newVersions: 0, newComments: 0, otherChanges: true });
        }
    });

    it('does not count a deleted new comment', () => {
        const before = detailOf();
        expect(refreshNews(before, withThread(before, { ...inlineThread(900, 'src/A.ts'), comments: [comment(900, '', { deleted: true })] })).newComments).toBe(0);
    });

    it('finds the threads the shown comparison should place but does not', () => {
        const d = withThread(detailOf(), inlineThread(900, 'src/A.ts'));
        expect(unplacedThreads(comparison(9, 10, ['src/A.ts']), d.threads)).toEqual([900]);
        expect(unplacedThreads(comparison(9, 10, ['src/A.ts'], [900]), d.threads)).toEqual([]);
        // a thread on a file the range does not show stays unplaced, normally
        expect(unplacedThreads(comparison(9, 10, ['src/B.ts']), d.threads)).toEqual([]);
    });

    it('says what is new in the banner and after a refresh', () => {
        const fr = translatorFor('fr');
        const en = translatorFor('en');
        expect(pulseText(fr, { newVersion: true, newComments: 2, otherActivity: false })).toBe('Du nouveau sur la PR : 2 nouveaux commentaires · une nouvelle version');
        expect(pulseText(en, { newVersion: false, newComments: 1, otherActivity: true })).toBe('New on this PR: 1 new comment');
        expect(pulseText(fr, { newVersion: false, newComments: 0, otherActivity: true })).toBe('Du nouveau sur la PR');
        const news = (over: Partial<RefreshNews>): RefreshNews => ({ newVersions: 0, newComments: 0, otherChanges: false, ...over });
        expect(refreshText(fr, news({ newVersions: 1, newComments: 2 }))).toBe('1 nouvelle version · 2 nouveaux commentaires');
        expect(refreshText(fr, news({}))).toBe('À jour');
        expect(refreshText(en, news({ otherChanges: true }))).toBe('Updated');
    });
});

describe('periodic check', () => {
    let scope: EffectScope;
    let seq: number;
    const NOW = Date.parse('2026-11-16T10:00:00Z');

    function start(page: PulsePage) {
        scope = effectScope();
        return scope.run(() => usePulse(page))!;
    }

    function pageOf(detail: PrDetail): PulsePage {
        return reactive({
            ref, detail, acting: false, refreshing: false, syncSeq: () => seq,
            refresh: vi.fn(() => Promise.resolve<RefreshNews | null>({ newVersions: 0, newComments: 0, otherChanges: false })),
        });
    }

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers({ now: NOW });
        seq = 0;
        setHostVisible(true);
        api.pulse.mockResolvedValue(pulse());
    });

    afterEach(() => {
        scope.stop();
        setHostVisible(true);
        vi.useRealTimers();
    });

    it('checks first at loadedAt + interval, then every interval', async () => {
        // a detail served from the server cache, read 2 minutes ago: checked 3 minutes from now
        start(pageOf(detailOf(new Date(NOW - 2 * MINUTE).toISOString(), 5)));
        await vi.advanceTimersByTimeAsync(3 * MINUTE - 1);
        expect(api.pulse).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(api.pulse).toHaveBeenCalledOnce();
        expect(api.pulse).toHaveBeenCalledWith(ref);
        await vi.advanceTimersByTimeAsync(5 * MINUTE);
        expect(api.pulse).toHaveBeenCalledTimes(2);
    });

    it('shows the news found against the detail shown', async () => {
        const pulsed = start(pageOf(detailOf(new Date(NOW).toISOString(), 1)));
        api.pulse.mockResolvedValue(pulse({ commentCount: 5, updatedOn: '2026-11-16T10:01:00Z' }));
        await vi.advanceTimersByTimeAsync(MINUTE);
        expect(pulsed.news.value).toEqual({ newVersion: false, newComments: 1, otherActivity: false });
    });

    it('never checks while hidden, and checks at once when shown again late', async () => {
        start(pageOf(detailOf(new Date(NOW).toISOString(), 1)));
        setHostVisible(false);
        await vi.advanceTimersByTimeAsync(10 * MINUTE);
        expect(api.pulse).not.toHaveBeenCalled();
        setHostVisible(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(api.pulse).toHaveBeenCalledOnce();
    });

    it('waits for the rest of the interval when shown again early', async () => {
        start(pageOf(detailOf(new Date(NOW).toISOString(), 5)));
        setHostVisible(false);
        await vi.advanceTimersByTimeAsync(2 * MINUTE);
        setHostVisible(true);
        await vi.advanceTimersByTimeAsync(3 * MINUTE - 1);
        expect(api.pulse).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(api.pulse).toHaveBeenCalledOnce();
    });

    it('drops a result when a write or a refresh started after the request', async () => {
        const page = pageOf(detailOf(new Date(NOW).toISOString(), 1));
        const pulsed = start(page);
        const late = deferred<PrPulse>();
        api.pulse.mockReturnValue(late.promise);
        await vi.advanceTimersByTimeAsync(MINUTE);
        expect(api.pulse).toHaveBeenCalledOnce();
        // my own comment is sent while the check is in flight: Bitbucket counts it, the detail not yet
        seq++;
        late.resolve(pulse({ commentCount: 5, updatedOn: '2026-11-16T10:01:00Z' }));
        await vi.advanceTimersByTimeAsync(0);
        expect(pulsed.news.value).toBeNull();
    });

    it('does not check during a write or a refresh', async () => {
        const page = pageOf(detailOf(new Date(NOW).toISOString(), 1));
        start(page);
        page.acting = true;
        await vi.advanceTimersByTimeAsync(2 * MINUTE);
        expect(api.pulse).not.toHaveBeenCalled();
        page.acting = false;
        await vi.advanceTimersByTimeAsync(0);
        expect(api.pulse).toHaveBeenCalledOnce();
    });

    it('a refresh clears the banner and moves the next check', async () => {
        const page = pageOf(detailOf(new Date(NOW).toISOString(), 1));
        const pulsed = start(page);
        api.pulse.mockResolvedValue(pulse({ commentCount: 5 }));
        await vi.advanceTimersByTimeAsync(MINUTE);
        expect(pulsed.news.value).not.toBeNull();

        page.refreshing = true;
        await vi.advanceTimersByTimeAsync(0);
        expect(pulsed.news.value).toBeNull();
        // the refresh read the PR 30 s later: the next check is a full interval after that read
        await vi.advanceTimersByTimeAsync(30_000);
        page.detail = detailOf(new Date(NOW + MINUTE + 30_000).toISOString(), 1, pulse({ commentCount: 5 }));
        page.refreshing = false;
        await vi.advanceTimersByTimeAsync(MINUTE - 1);
        expect(api.pulse).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);
        expect(api.pulse).toHaveBeenCalledTimes(2);
        expect(pulsed.news.value).toBeNull();
    });

    it('a dismissed banner comes back only with more news', async () => {
        const pulsed = start(pageOf(detailOf(new Date(NOW).toISOString(), 1)));
        api.pulse.mockResolvedValue(pulse({ commentCount: 5 }));
        await vi.advanceTimersByTimeAsync(MINUTE);
        pulsed.dismiss();
        expect(pulsed.news.value).toBeNull();
        await vi.advanceTimersByTimeAsync(MINUTE);
        expect(pulsed.news.value).toBeNull();
        api.pulse.mockResolvedValue(pulse({ commentCount: 6 }));
        await vi.advanceTimersByTimeAsync(MINUTE);
        expect(pulsed.news.value?.newComments).toBe(2);
    });

    it('the user refresh shows what changed for a few seconds', async () => {
        const page = pageOf(detailOf(new Date(NOW).toISOString(), 5));
        vi.mocked(page.refresh).mockResolvedValue({ newVersions: 0, newComments: 1, otherChanges: false });
        const pulsed = start(page);
        await pulsed.refresh();
        expect(pulsed.status.value).toEqual({ newVersions: 0, newComments: 1, otherChanges: false });
        await vi.advanceTimersByTimeAsync(4000);
        expect(pulsed.status.value).toBeNull();
    });
});

describe('user refresh (↻)', () => {
    let detail: PrDetail;
    const shown = { from: 9, to: 10, context: 3 };

    beforeEach(() => {
        vi.clearAllMocks();
        detail = detailOf();
        api.summary.mockResolvedValue({ versions: [] });
    });

    it('reads a fresh detail and says what is new, keeping the diff', async () => {
        api.compare.mockResolvedValue(comparison(9, 10, ['src/B.ts']));
        const load = usePrLoad(ref, detail);
        await load.loadCompare(shown);
        const after = withThread(detail, inlineThread(900, 'src/A.ts'));
        api.pr.mockResolvedValue(after);

        expect(await load.refresh()).toEqual({ newVersions: 0, newComments: 1, otherChanges: false });
        expect(api.pr).toHaveBeenCalledWith(ref, { fresh: true });
        expect(load.detail.value).toBe(after);
        // the new thread is on a file the range does not show: nothing to compute again
        expect(api.compare).toHaveBeenCalledOnce();
        expect(api.summary).not.toHaveBeenCalled();
    });

    it('computes the shown range again once when a new thread lacks its placement', async () => {
        api.compare.mockResolvedValueOnce(comparison(9, 10, ['src/A.ts'])).mockResolvedValueOnce(comparison(9, 10, ['src/A.ts'], [900]));
        const load = usePrLoad(ref, detail);
        await load.loadCompare(shown);
        api.pr.mockResolvedValue(withThread(detail, inlineThread(900, 'src/A.ts')));

        await load.refresh();
        expect(api.compare).toHaveBeenCalledTimes(2);
        expect(api.compare).toHaveBeenLastCalledWith(ref, 9, 10, 3);
        expect(load.compare.value?.files[0]?.threads.map((p) => p.threadId)).toEqual([900]);
        // the diff stayed on screen while it was computed again
        expect(load.diffMode.value).toBe('diff');
    });

    it('reloads the summary and the shown range when the versions changed', async () => {
        api.compare.mockResolvedValue(comparison(9, 10, ['src/B.ts']));
        const load = usePrLoad(ref, detail);
        await load.loadCompare(shown);
        const pushed = { ...detail.versions[9]!, index: 11, hash: 'new-head' };
        api.pr.mockResolvedValue({ ...detail, versions: [...detail.versions, pushed] });

        expect(await load.refresh()).toEqual({ newVersions: 1, newComments: 0, otherChanges: false });
        expect(api.summary).toHaveBeenCalledOnce();
        expect(api.compare).toHaveBeenCalledTimes(2);
        expect(api.compare).toHaveBeenLastCalledWith(ref, 9, 10, 3);
    });

    it('returns null when the read fails', async () => {
        api.pr.mockRejectedValue(new Error('boom'));
        const load = usePrLoad(ref, detail);
        expect(await load.refresh()).toBeNull();
        expect(showError).toHaveBeenCalledOnce();
        expect(load.detail.value).toBe(detail);
    });

    it('counts writes and refreshes for the periodic check', async () => {
        api.pr.mockResolvedValue(detail);
        const load = usePrLoad(ref, detail);
        const before = load.syncSeq();
        await load.refreshDetail();
        expect(load.syncSeq()).toBeGreaterThan(before);
        const afterRefresh = load.syncSeq();
        await load.act(() => Promise.resolve());
        expect(load.syncSeq()).toBeGreaterThan(afterRefresh);
    });
});
