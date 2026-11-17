import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, reactive, type EffectScope } from 'vue';
import type { Comment, Comparison, PrDetail, PrPulse, Thread } from '../../src/shared/api.ts';
import { replyDraftKey, useDiscussion } from '../../src/web/composables/useDiscussion.ts';
import { setHostVisible } from '../../src/web/composables/usePageVisible.ts';
import { usePrLoad } from '../../src/web/composables/usePrLoad.ts';
import { usePulse, type PulsePage } from '../../src/web/composables/usePulse.ts';
import { translatorFor } from '../../src/web/i18n/index.ts';
import {
    afterOwnWrite, afterTaskWrite, hasNews, pulseIntervalMs, pulseNews, pulseText, refreshNews, refreshText, unplacedThreads, type RefreshNews,
} from '../../src/web/lib/pulse.ts';
import { prLong, threadById } from './fixtures.ts';

const { api, showError } = vi.hoisted(() => ({
    api: { pr: vi.fn(), summary: vi.fn(), compare: vi.fn(), pulse: vi.fn(), comment: vi.fn(), deleteComment: vi.fn() },
    showError: vi.fn(),
}));
vi.mock('../../src/web/services/api.ts', async (importOriginal) => ({ ...await importOriginal<object>(), api }));
vi.mock('../../src/web/composables/useErrors.ts', () => ({ showError }));

const ref = { workspace: 'acme', repo: 'records-api', id: 212 };
const yann = { uuid: '{yan}', displayName: 'Yann Bernard', nickname: 'ybernard' };
const MINUTE = 60_000;

const pulse = (over: Partial<PrPulse> = {}): PrPulse => ({
    updatedOn: '2026-11-16T10:00:00Z', head: 'abc123', commentCount: 4, participants: '{yan}:1:approved', taskCount: 0, ...over,
});

function comment(id: number, raw: string, over: Partial<Comment> = {}): Comment {
    return { id, user: yann, createdOn: '2026-11-16T10:00:00Z', version: 10, html: `<p>${raw}</p>`, raw, isNew: true, deleted: false, mine: false, reactions: [], parentId: null, ...over };
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

/** Lets already-resolved promises through. */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

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

    it('pulseNews does not take the updatedOn moved by my own write for news', () => {
        const shown = afterOwnWrite(pulse(), 1);
        expect(shown).toMatchObject({ commentCount: 5, updatedOn: '' });
        expect(hasNews(pulseNews(shown, pulse({ commentCount: 5, updatedOn: '2026-11-16T10:05:00Z' })))).toBe(false);
        // somebody else's comment on top of mine still counts
        expect(pulseNews(shown, pulse({ commentCount: 6, updatedOn: '2026-11-16T10:06:00Z' })).newComments).toBe(1);
        expect(afterOwnWrite(pulse({ commentCount: 0 }), -1).commentCount).toBe(0);
    });

    it('afterTaskWrite takes the open count, and Bitbucket\'s updatedOn only when nothing shown moved', () => {
        const shown = afterOwnWrite(pulse());
        const quiet = pulse({ updatedOn: '2026-11-16T10:05:00Z', taskCount: 3 });
        expect(afterTaskWrite(shown, quiet)).toEqual(quiet);
        expect(hasNews(pulseNews(afterTaskWrite(shown, quiet), quiet))).toBe(false);
        // a comment by somebody else meanwhile: kept unknown, so the next check still reports it
        const busy = pulse({ updatedOn: '2026-11-16T10:06:00Z', commentCount: 5, taskCount: 3 });
        const after = afterTaskWrite(shown, busy);
        expect(after).toMatchObject({ updatedOn: '', commentCount: 4, taskCount: 3 });
        expect(pulseNews(after, busy).newComments).toBe(1);
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

    it('refreshNews sees a reaction given or taken back as another change, never as a new comment', () => {
        const before = detailOf();
        const withLike = (users: { uuid: string; displayName: string }[]): PrDetail => ({
            ...before,
            threads: before.threads.map((t) => (t.id === 110
                ? { ...t, comments: t.comments.map((c, k) => (k === 0 ? { ...c, reactions: users.length ? [{ emoji: '👍', users, myCommentIds: [] }] : [] } : c)) }
                : t)),
        });
        expect(refreshNews(before, withLike([yann]))).toEqual({ newVersions: 0, newComments: 0, otherChanges: true });
        expect(refreshNews(withLike([yann]), before)).toEqual({ newVersions: 0, newComments: 0, otherChanges: true });
        expect(refreshNews(withLike([yann]), withLike([yann]))).toEqual({ newVersions: 0, newComments: 0, otherChanges: false });
    });

    it('refreshNews sees a comment that vanished (deleted with nothing under it) as another change', () => {
        const before = detailOf();
        const vanished = { ...before, threads: before.threads.map((t) => (t.id === 120 ? { ...t, comments: t.comments.filter((c) => c.id !== 121) } : t)) };
        expect(refreshNews(before, vanished)).toEqual({ newVersions: 0, newComments: 0, otherChanges: true });
        // the whole thread gone
        expect(refreshNews(before, { ...before, threads: before.threads.filter((t) => t.id !== 110) }).otherChanges).toBe(true);
        // my comment being sent (temporary id), now Bitbucket's: a new comment, not a vanished one
        const sending = withThread(before, { ...inlineThread(-1, 'src/A.ts'), comments: [comment(-1, 'Mine', { pending: true })] });
        expect(refreshNews(sending, withThread(before, inlineThread(900, 'src/A.ts')))).toEqual({ newVersions: 0, newComments: 1, otherChanges: false });
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

    it('new version: the summary is read again, the ranges whose bounds did not change are kept', async () => {
        api.compare.mockImplementation(async (_ref: unknown, from: number, to: number) => comparison(from, to, ['src/B.ts']));
        const load = usePrLoad(ref, detail);
        await load.fetchIntoCache({ from: 0, to: 10, context: 3 });
        await load.loadCompare(shown);
        const pushed = { ...detail.versions[9]!, index: 11, hash: 'new-head' };
        api.pr.mockResolvedValue({ ...detail, versions: [...detail.versions, pushed] });

        expect(await load.refresh()).toEqual({ newVersions: 1, newComments: 0, otherChanges: false });
        expect(api.summary).toHaveBeenCalledOnce();
        // v9..v10 and v0..v10 are the same commits: neither is computed again
        await load.loadCompare({ from: 0, to: 10, context: 3 });
        expect(api.compare).toHaveBeenCalledTimes(2);
    });

    it('a replaced version: the ranges ending on it are forgotten, the shown one is computed again under ↻', async () => {
        api.compare.mockImplementation(async (_ref: unknown, from: number, to: number) => comparison(from, to, ['src/B.ts']));
        const load = usePrLoad(ref, detail);
        await load.fetchIntoCache({ from: 3, to: 4, context: 3 });
        await load.loadCompare(shown);
        const replaced = detail.versions.map((v) => (v.index === 10 ? { ...v, hash: 'amended-head' } : v));
        const recompute = deferred<Comparison>();
        api.compare.mockReturnValueOnce(recompute.promise);
        api.pr.mockResolvedValue({ ...detail, versions: replaced });

        const refreshing = load.refresh();
        await settle();
        // the detail is read, the diff is being computed again: the ↻ button and the bar stay busy, the diff stays
        expect(api.compare).toHaveBeenCalledTimes(3);
        expect(api.compare).toHaveBeenLastCalledWith(ref, 9, 10, 3);
        expect(load.refreshing.value).toBe(true);
        expect(load.recomputing.value).toBe(true);
        expect(load.diffMode.value).toBe('diff');
        recompute.resolve(comparison(9, 10, ['src/C.ts']));
        expect(await refreshing).toMatchObject({ newVersions: 0 });
        expect(load.refreshing.value).toBe(false);
        expect(load.recomputing.value).toBe(false);
        expect(load.compare.value?.files.map((f) => f.path)).toEqual(['src/C.ts']);
        // v3..v4 did not change
        await load.loadCompare({ from: 3, to: 4, context: 3 });
        expect(api.compare).toHaveBeenCalledTimes(3);
    });

    it('returns null when the read fails', async () => {
        api.pr.mockRejectedValue(new Error('boom'));
        const load = usePrLoad(ref, detail);
        expect(await load.refresh()).toBeNull();
        expect(showError).toHaveBeenCalledOnce();
        expect(load.detail.value).toBe(detail);
    });

    it('a refresh during a write does not erase the written comment', async () => {
        const load = usePrLoad(ref, detail);
        const discussion = useDiscussion(ref, load);
        const sent = deferred<Comment>();
        api.comment.mockReturnValue(sent.promise);
        const sending = discussion.reply(threadById(detail, 120), 'On it');

        // ↻ while the comment is being sent: nothing is read
        expect(await load.refresh()).toBeNull();
        expect(api.pr).not.toHaveBeenCalled();
        // a read sent anyway during the write (Bitbucket has not stored the comment yet)
        const stale = deferred<PrDetail>();
        api.pr.mockReturnValueOnce(stale.promise);
        const reading = load.refreshDetail();
        const mine = comment(501, 'On it', { mine: true, isNew: false });
        const after: PrDetail = {
            ...detail,
            threads: detail.threads.map((t) => (t.id === 120 ? { ...t, comments: [...t.comments, mine] } : t)),
            pulse: pulse({ commentCount: 5, updatedOn: '2026-11-16T10:02:00Z' }),
        };
        api.pr.mockResolvedValue(after);
        sent.resolve(mine);
        expect(await sending).toBe(true);
        // the write ended first: its refresh shares the read in flight, which lands with the pre-write PR
        stale.resolve(detail);
        await reading;
        expect(load.detail.value).toBe(after);
        expect(api.pr).toHaveBeenCalledTimes(2);
        expect(threadById(load.detail.value, 120).comments.at(-1)?.id).toBe(501);
    });

    it('my own comment moves the check baseline, even when the refresh after it fails', async () => {
        const load = usePrLoad(ref, detail);
        const discussion = useDiscussion(ref, load);
        api.pr.mockRejectedValue(new Error('offline'));
        api.comment.mockResolvedValue(comment(501, 'On it', { mine: true }));
        expect(await discussion.reply(threadById(detail, 120), 'On it')).toBe(true);
        await vi.waitFor(() => expect(load.refreshing.value).toBe(false));
        expect(load.detail.value.pulse).toMatchObject({ commentCount: 5, updatedOn: '' });
        // Bitbucket now counts my comment and moved updated_on: not news
        expect(hasNews(pulseNews(load.detail.value.pulse, pulse({ commentCount: 5, updatedOn: '2026-11-16T10:02:00Z' })))).toBe(false);
        expect(discussion.draft(replyDraftKey(120))).toBe('');

        api.deleteComment.mockResolvedValue({ ok: true });
        expect(await discussion.deleteComment(threadById(load.detail.value, 120).comments.at(-1)!)).toBe(true);
        expect(load.detail.value.pulse.commentCount).toBe(4);
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
