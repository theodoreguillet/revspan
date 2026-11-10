// Background refresh and notifications: the notifier wired to the fake Bitbucket, VS Code simulated
// (test/support/fake-vscode.ts). Two Stores on one folder play two windows of the same profile.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Home } from '../../src/shared/api.ts';
import { Cache } from '../../src/server/infra/cache.ts';
import { Store } from '../../src/server/infra/config.ts';
import { createSecretStore } from '../../src/server/infra/secrets.ts';
import type { HomeService } from '../../src/server/services/home-service.ts';
import { createServices, type Services } from '../../src/server/services/index.ts';
import type { BitbucketSession } from '../../src/server/services/session.ts';
import { Notifier } from '../../src/extension/notifier.ts';
import { FAKE_EMAIL, FAKE_PRS, FAKE_TOKEN, REPO, WS, pushVersion, startFakeBitbucket, type FakeBitbucket } from '../support/fake-bitbucket.ts';
import { env, recorded, resetFakeVscode, window } from '../support/fake-vscode.ts';

vi.mock('vscode', () => import('../support/fake-vscode.ts'));

let fake: FakeBitbucket;
let dir: string;
const notifiers: Notifier[] = [];
const caches: Cache[] = [];
/** Requests sent to the fake Bitbucket by every window. */
let requests = 0;
const countingFetch: typeof fetch = (input, init) => {
    requests += 1;
    return fetch(input, init);
};

/** The live caches' TTLs elapse in every window (the poller reads through them, never fresh). */
const expireLiveCaches = (): void => caches.forEach((cache) => cache.invalidateLive('live:'));

/** One VS Code window: its own Store, services and notifier, on the shared folder. */
async function openWindow(onPolled = vi.fn()): Promise<{ store: Store; services: Services; notifier: Notifier; onPolled: typeof onPolled }> {
    const store = new Store(dir);
    const secrets = await createSecretStore({ dir, env: { REVSPAN_TOKEN_STORE: 'file' } });
    const cache = new Cache(path.join(dir, `cache-${notifiers.length}`));
    caches.push(cache);
    const services = createServices({ store, secrets, cache, baseUrl: fake.url, fetchImpl: countingFetch });
    const notifier = new Notifier({ store, session: services.session, home: services.home, onPolled });
    notifiers.push(notifier);
    return { store, services, notifier, onPolled };
}

const PURGED_TITLE = 'DEMO-48 - feat(purged): long running pull request';
/** New code version on #48 (to do, I commented on it). */
const pushOnPurged = (): void => {
    pushVersion(fake.data, FAKE_PRS.purged, {
        commit: 'purged:v4', from: 'purged:v3', base: 'purged:m0', changes: { 'src/Purged.ts': 'a\nb\nv2\nv3\nv4\n' }, date: '2026-10-22T09:00:00Z',
    });
    expireLiveCaches();
};

beforeEach(async () => {
    resetFakeVscode();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revspan-notifier-'));
    fake = await startFakeBitbucket();
    const first = await openWindow();
    await first.services.settings.update({ email: FAKE_EMAIL, token: FAKE_TOKEN, repos: [`${WS}/${REPO}`] });
    notifiers.splice(0).forEach((n) => n.dispose());
});

afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    notifiers.splice(0).forEach((n) => n.dispose());
    caches.length = 0;
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('background refresh and notifications', () => {
    it('first poll: nothing shown, baseline recorded, tree refreshed; the next identical poll shows nothing either', async () => {
        const { store, notifier, onPolled } = await openWindow();
        await notifier.poll();
        expect(recorded.infos).toEqual([]);
        expect(store.notified().initialized).toBe(true);
        expect(store.notified().seen[`${WS}/${REPO}#${FAKE_PRS.main}`]).toMatch(/^[0-9a-f]{12}$/);
        expect(onPolled).toHaveBeenCalledTimes(1);
        await notifier.poll();
        expect(recorded.infos).toEqual([]);
        expect(onPolled).toHaveBeenCalledTimes(2);
    });

    it('Review Focus 5: a new version is shown once, by one of two windows polling the same profile', async () => {
        const a = await openWindow();
        const b = await openWindow();
        await a.notifier.poll();
        await b.notifier.poll();
        pushOnPurged();
        await b.notifier.poll();
        await a.notifier.poll();
        await b.notifier.poll();
        expect(recorded.infos).toEqual([`New version to review: ${PURGED_TITLE}`]);
        expect(recorded.warnings).toEqual([]);
    });

    it('"Open" runs revspan.openPr with the PR', async () => {
        const { notifier } = await openWindow();
        await notifier.poll();
        pushOnPurged();
        vi.spyOn(window, 'showInformationMessage').mockResolvedValue('Open' as never);
        await notifier.poll();
        await vi.waitFor(() => expect(recorded.commands).toEqual([{ command: 'revspan.openPr', args: [{ workspace: WS, repo: REPO, id: FAKE_PRS.purged }] }]));
    });

    it('failed build on my PR (option on): a warning, once for that head', async () => {
        const { store, notifier } = await openWindow();
        await store.saveConfig({ review: { ...store.config.review, notifications: { newPullRequest: true, newVersion: true, buildFailed: true } } });
        await notifier.poll();
        const statuses = fake.data.statuses.get(FAKE_PRS.mine) ?? [];
        fake.data.statuses.set(FAKE_PRS.mine, statuses.map((s) => ({ ...s, state: 'FAILED' })));
        expireLiveCaches();
        await notifier.poll();
        await notifier.poll();
        expect(recorded.warnings).toEqual(['Build failed on your PR: DEMO-45 - feat(mine): my own pull request']);
        expect(recorded.infos).toEqual([]);
    });

    it('within the cache TTL a poll reads the cached home: a push is only seen once the TTL elapsed', async () => {
        const { notifier } = await openWindow();
        await notifier.poll();
        pushVersion(fake.data, FAKE_PRS.purged, {
            commit: 'purged:v4', from: 'purged:v3', base: 'purged:m0', changes: { 'src/Purged.ts': 'a\nb\nv2\nv3\nv4\n' }, date: '2026-10-22T09:00:00Z',
        });
        const before = requests;
        await notifier.poll();
        expect(requests).toBe(before);
        expect(recorded.infos).toEqual([]);
        expireLiveCaches();
        await notifier.poll();
        expect(recorded.infos).toEqual([`New version to review: ${PURGED_TITLE}`]);
    });

    it('a disabled preference: nothing shown, and enabling it later does not show the backlog', async () => {
        const { store, notifier } = await openWindow();
        await notifier.poll();
        await store.saveConfig({ review: { ...store.config.review, notifications: { newPullRequest: true, newVersion: false, buildFailed: false } } });
        pushOnPurged();
        await notifier.poll();
        await store.saveConfig({ review: { ...store.config.review, notifications: { newPullRequest: true, newVersion: true, buildFailed: true } } });
        await notifier.poll();
        expect(recorded.infos).toEqual([]);
        expect(recorded.warnings).toEqual([]);
    });

    it('French: the message comes from the l10n bundle', async () => {
        const { notifier } = await openWindow();
        await notifier.poll();
        pushOnPurged();
        env.language = 'fr';
        await notifier.poll();
        expect(recorded.infos).toEqual([`Nouvelle version à relire : ${PURGED_TITLE}`]);
    });
});

describe('skipped cycles', () => {
    /** Notifier on stubbed session and home service (no Bitbucket). */
    const stubbed = async (hasToken: boolean, get: () => Promise<Home>, repos = [`${WS}/${REPO}`]): Promise<{ notifier: Notifier; store: Store; onPolled: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> }> => {
        const store = new Store(fs.mkdtempSync(path.join(dir, 'stub-')));
        await store.saveConfig({ repos });
        const onPolled = vi.fn();
        const home = { get: vi.fn(get) };
        const notifier = new Notifier({
            store,
            session: { hasToken: async () => hasToken } as unknown as BitbucketSession,
            home: home as unknown as HomeService,
            onPolled,
        });
        notifiers.push(notifier);
        return { notifier, store, onPolled, get: home.get };
    };
    const home = (over: Partial<Home>): Home => ({ me: { uuid: '{me}', displayName: 'Me' }, repos: [`${WS}/${REPO}`], groups: [], errors: [], ...over });

    it('no token, no repositories, or me unknown: nothing recorded, nothing refreshed', async () => {
        const cases = [
            await stubbed(false, async () => home({})),
            await stubbed(true, async () => home({}), []),
            await stubbed(true, async () => home({ me: null })),
        ];
        for (const { notifier, store, onPolled } of cases) {
            await notifier.poll();
            expect(store.notified().initialized).toBe(false);
            expect(onPolled).not.toHaveBeenCalled();
        }
        expect(cases[0]?.get).not.toHaveBeenCalled();
        expect(cases[1]?.get).not.toHaveBeenCalled();
    });

    it('reads the home through its caches, never fresh (fresh is for the "Refresh" command only)', async () => {
        const { notifier, get } = await stubbed(true, async () => home({}));
        await notifier.poll();
        expect(get).toHaveBeenCalledTimes(1);
        expect(get.mock.calls[0]?.[0]?.fresh).not.toBe(true);
    });

    it('a failing refresh never throws from the timer', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { notifier, onPolled } = await stubbed(true, async () => {
            throw new Error('network down');
        });
        await expect(notifier.poll()).resolves.toBeUndefined();
        expect(onPolled).not.toHaveBeenCalled();
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('network down'));
    });

    it('polls after the startup delay, then every refresh interval; re-armed on a change; stopped when disposed', async () => {
        vi.useFakeTimers();
        const { notifier, store } = await stubbed(true, async () => home({}));
        const poll = vi.spyOn(notifier, 'poll').mockResolvedValue();
        notifier.start(10_000);
        await vi.advanceTimersByTimeAsync(9_999);
        expect(poll).toHaveBeenCalledTimes(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(poll).toHaveBeenCalledTimes(1);
        // Default interval: 5 minutes from start.
        await vi.advanceTimersByTimeAsync(5 * 60_000 - 10_000);
        expect(poll).toHaveBeenCalledTimes(2);

        await store.saveConfig({ review: { ...store.config.review, refreshMinutes: 1 } });
        notifier.rearm();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(poll).toHaveBeenCalledTimes(3);

        notifier.dispose();
        notifier.rearm();
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(poll).toHaveBeenCalledTimes(3);
    });

    it('disposed before the startup poll: no poll at all', async () => {
        vi.useFakeTimers();
        const { notifier } = await stubbed(true, async () => home({}));
        const poll = vi.spyOn(notifier, 'poll');
        notifier.start(10_000);
        notifier.dispose();
        await vi.advanceTimersByTimeAsync(60 * 60_000);
        expect(poll).not.toHaveBeenCalled();
    });
});
