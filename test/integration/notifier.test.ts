// Background refresh and notifications: the notifier wired to the fake Bitbucket, VS Code simulated
// (test/support/fake-vscode.ts). Two Stores on one folder play two windows of the same profile.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Home, PrCard, User, VersionKind } from '../../src/shared/api.ts';
import { Cache } from '../../src/server/infra/cache.ts';
import { Store, type ReviewSource } from '../../src/server/infra/config.ts';
import { createSecretStore } from '../../src/server/infra/secrets.ts';
import type { HomeService } from '../../src/server/services/home-service.ts';
import { createServices, type Services } from '../../src/server/services/index.ts';
import type { BitbucketSession } from '../../src/server/services/session.ts';
import type { PrService } from '../../src/server/services/pr-service.ts';
import { Notifier } from '../../src/extension/notifier.ts';
import { FAKE_EMAIL, FAKE_PRS, FAKE_TOKEN, REPO, WS, pushVersion, startFakeBitbucket, type FakeBitbucket } from '../support/fake-bitbucket.ts';
import { env, recorded, resetFakeVscode, window } from '../support/fake-vscode.ts';

vi.mock('vscode', () => import('../support/fake-vscode.ts'));

let fake: FakeBitbucket;
let dir: string;
const notifiers: Notifier[] = [];
/** Requests sent to the fake Bitbucket by every window. */
let requests = 0;
const countingFetch: typeof fetch = (input, init) => {
    requests += 1;
    return fetch(input, init);
};

/** One refresh interval goes by (default 5 minutes): every cache the poller reads through has expired. Only Date is faked. */
const nextInterval = (): void => {
    vi.setSystemTime(new Date(Date.now() + 5 * 60_000 + 1000));
};

/** Requests sent to the fake Bitbucket while `run` ran, as "list", "user", "statuses", "diffstat"... */
async function requestsOf(run: () => Promise<unknown>): Promise<string[]> {
    const start = fake.requests.length;
    await run();
    return fake.requests.slice(start).map((r) => {
        const rest = r.path.replace(/^\/2\.0\/repositories\/[^/]+\/[^/]+/, '');
        if (rest === '/pullrequests') {
            return 'list';
        }
        if (/^\/commit\/[0-9a-f]+\/statuses$/.test(rest)) {
            return 'statuses';
        }
        const pr = /^\/pullrequests\/\d+(?:\/([a-z-]+))?/.exec(rest);
        return pr ? pr[1] ?? 'pr' : rest.split('/')[1] ?? rest;
    });
}

/** One VS Code window: its own Store, services and notifier, on the shared folder. */
async function openWindow(
    onPolled = vi.fn(),
    isVisible = (): boolean => false,
    reviewSource: ReviewSource | null = null,
    prListLimit?: { pagelen: number; pages: number },
): Promise<{ store: Store; services: Services; notifier: Notifier; onPolled: typeof onPolled }> {
    const store = new Store(dir, { reviewSource });
    const secrets = await createSecretStore({ dir, env: { REVSPAN_TOKEN_STORE: 'file' } });
    const cache = new Cache(path.join(dir, `cache-${notifiers.length}`));
    const services = createServices({ store, secrets, cache, baseUrl: fake.url, fetchImpl: countingFetch, prListLimit });
    const notifier = new Notifier({ store, session: services.session, home: services.home, prs: services.prs, onPolled, isVisible });
    notifiers.push(notifier);
    return { store, services, notifier, onPolled };
}

const PURGED_TITLE = 'DEMO-48 - feat(purged): long running pull request';
/** New code version on #48 (to do, I commented on it). */
const pushOnPurged = (): void => {
    pushVersion(fake.data, FAKE_PRS.purged, {
        commit: 'purged:v4', from: 'purged:v3', base: 'purged:m0', changes: { 'src/Purged.ts': 'a\nb\nv2\nv3\nv4\n' }, date: '2026-10-22T09:00:00Z',
    });
    nextInterval();
};

beforeEach(async () => {
    resetFakeVscode();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T09:00:00Z'));
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
        nextInterval();
        await notifier.poll();
        await notifier.poll();
        expect(recorded.warnings).toEqual(['Build failed on your PR: DEMO-45 - feat(mine): my own pull request']);
        expect(recorded.infos).toEqual([]);
    });

    it('I2: on a fresh push, lint passes, then the CI starts and fails, all within the hour: the home ends failed and the warning shows', async () => {
        const { store, notifier, services } = await openWindow();
        await store.saveConfig({ review: { ...store.config.review, notifications: { newPullRequest: true, newVersion: true, buildFailed: true } } });
        await notifier.poll();
        pushVersion(fake.data, FAKE_PRS.mine, { commit: 'mine:v3', from: 'mine:v2', base: 'mine:m0', changes: { 'src/mine.ts': 'x\ny1\ny2\ny3\n' }, date: new Date().toISOString() });
        const head = fake.data.prs.get(FAKE_PRS.mine)?.pr.source?.commit?.hash ?? '-';
        const fullHead = [...fake.data.repo.commits.keys()].find((hash) => hash.startsWith(head)) ?? head;
        const check = (key: string, state: 'SUCCESSFUL' | 'INPROGRESS' | 'FAILED') => ({ key, name: key, state, commit: { hash: fullHead }, updated_on: new Date().toISOString() });
        const buildOfMine = async (): Promise<string | undefined> => (await services.home.get()).groups.flatMap((g) => g.prs).find((p) => p.id === FAKE_PRS.mine)?.build?.state;

        fake.data.statuses.set(FAKE_PRS.mine, [check('lint', 'SUCCESSFUL')]);
        nextInterval();
        await notifier.poll();
        expect(await buildOfMine()).toBe('success');
        fake.data.statuses.set(FAKE_PRS.mine, [check('lint', 'SUCCESSFUL'), check('ci', 'INPROGRESS')]);
        nextInterval();
        await notifier.poll();
        expect(await buildOfMine()).toBe('running');
        fake.data.statuses.set(FAKE_PRS.mine, [check('lint', 'SUCCESSFUL'), check('ci', 'FAILED')]);
        nextInterval();
        await notifier.poll();
        expect(await buildOfMine()).toBe('failed');
        expect(recorded.warnings).toEqual(['Build failed on your PR: DEMO-45 - feat(mine): my own pull request']);
    });

    it('I5: more open PRs than the list cap: the home says so, and a PR left out then listed again is not notified again', async () => {
        // 8 open PRs, 7 listed (one page of 7): #49 is left out at first.
        const { notifier, services } = await openWindow(vi.fn(), () => false, null, { pagelen: 7, pages: 1 });
        const moveToEnd = (...ids: number[]): void => {
            for (const id of ids) {
                const pr = fake.data.prs.get(id);
                fake.data.prs.delete(id);
                if (pr) {
                    fake.data.prs.set(id, pr);
                }
            }
        };
        await notifier.poll();
        expect((await services.home.get()).truncated).toEqual([{ repo: `${WS}/${REPO}`, count: 7 }]);
        // #46 (I am a designated reviewer, to do) drops out of the first page, then comes back.
        moveToEnd(FAKE_PRS.neverReviewed);
        nextInterval();
        await notifier.poll();
        moveToEnd(FAKE_PRS.others, FAKE_PRS.purged, FAKE_PRS.waiting);
        nextInterval();
        await notifier.poll();
        expect((await services.home.get()).groups.flatMap((g) => g.prs).map((p) => p.id)).toContain(FAKE_PRS.neverReviewed);
        expect(recorded.infos).toEqual([]);
    });

    it('a push with no change since the previous head (neutral version) on a PR I reviewed: nothing shown, head recorded', async () => {
        const { store, notifier } = await openWindow();
        await notifier.poll();
        pushVersion(fake.data, FAKE_PRS.purged, { commit: 'purged:v4', from: 'purged:v3', base: 'purged:m0', changes: {}, date: '2026-10-22T09:00:00Z' });
        nextInterval();
        await notifier.poll();
        expect(recorded.infos).toEqual([]);
        const head = fake.data.prs.get(FAKE_PRS.purged)?.pr.source?.commit?.hash ?? '';
        expect(store.notified().seen[`${WS}/${REPO}#${FAKE_PRS.purged}`]?.split(' ')[0]).toBe(head.slice(0, 12));
    });

    it('within half an interval a poll reads the shared home: a push is only seen by the next interval\'s poll', async () => {
        const { notifier } = await openWindow();
        await notifier.poll();
        pushVersion(fake.data, FAKE_PRS.purged, {
            commit: 'purged:v4', from: 'purged:v3', base: 'purged:m0', changes: { 'src/Purged.ts': 'a\nb\nv2\nv3\nv4\n' }, date: '2026-10-22T09:00:00Z',
        });
        const before = requests;
        await notifier.poll();
        expect(requests).toBe(before);
        expect(recorded.infos).toEqual([]);
        nextInterval();
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

    it('all three notifications off and no Revspan view visible: the poll does nothing; switching one on shows no backlog', async () => {
        const { store, notifier, onPolled } = await openWindow();
        await notifier.poll();
        const on = store.config.review.notifications;
        await store.saveConfig({ review: { ...store.config.review, notifications: { newPullRequest: false, newVersion: false, buildFailed: false } } });
        pushOnPurged();
        expect(await requestsOf(() => notifier.poll())).toEqual([]);
        expect(onPolled).toHaveBeenCalledTimes(1);
        await store.saveConfig({ review: { ...store.config.review, notifications: on } });
        nextInterval();
        await notifier.poll();
        expect(recorded.infos).toEqual([]);
        // What happens from then on is notified again.
        pushVersion(fake.data, FAKE_PRS.purged, {
            commit: 'purged:v5', from: 'purged:v4', base: 'purged:m0', changes: { 'src/Purged.ts': 'a\nb\nv2\nv3\nv4\nv5\n' }, date: '2026-10-23T09:00:00Z',
        });
        nextInterval();
        await notifier.poll();
        expect(recorded.infos).toEqual([`New version to review: ${PURGED_TITLE}`]);
    });

    it('a window with every notification off (window-level settings) never silences another window', async () => {
        const allOff: ReviewSource = {
            get: () => ({ notifications: { newPullRequest: false, newVersion: false, buildFailed: false } }),
            set: async () => undefined,
        };
        const quiet = await openWindow(vi.fn(), () => false, allOff);
        const active = await openWindow();
        await active.notifier.poll();
        await quiet.notifier.poll();
        pushOnPurged();
        await quiet.notifier.poll();
        await active.notifier.poll();
        expect(recorded.infos).toEqual([`New version to review: ${PURGED_TITLE}`]);
    });

    it('all notifications off but a Revspan view visible: the poll still refreshes the home', async () => {
        const { store, notifier, onPolled } = await openWindow(vi.fn(), () => true);
        await store.saveConfig({ review: { ...store.config.review, notifications: { newPullRequest: false, newVersion: false, buildFailed: false } } });
        expect(await requestsOf(() => notifier.poll())).toContain('list');
        expect(onPolled).toHaveBeenCalledTimes(1);
    });

    it('two windows polling at the same moment compute the home once', async () => {
        const a = await openWindow();
        const b = await openWindow();
        await a.notifier.poll();
        await b.notifier.poll();
        nextInterval();
        const spent = await requestsOf(() => Promise.all([a.notifier.poll(), b.notifier.poll()]));
        expect(spent.filter((r) => r === 'list')).toEqual(['list']);
    });

    it('new version check: only the versions since the previous head are summarized, then nothing is checked again', async () => {
        const { notifier } = await openWindow();
        await notifier.poll();
        pushVersion(fake.data, FAKE_PRS.long, {
            commit: 'long:v35', from: 'long:v34', base: 'long:m28', changes: { 'src/Long.ts': 'changed\n' }, date: '2026-10-22T09:00:00Z',
        });
        nextInterval();
        const check = await requestsOf(() => notifier.poll());
        expect(recorded.infos).toEqual(['New version to review: DEMO-43 - feat(long): a very long running pull request']);
        // One version summary (at most 3 diffstats), not the 35 versions of the PR.
        expect(check.filter((r) => r === 'diffstat').length).toBeLessThanOrEqual(3);
        // Next interval: only what is read once per interval (lists, unsettled checks, branch heads); no version check again.
        nextInterval();
        const next = await requestsOf(() => notifier.poll());
        expect(next).toContain('list');
        expect(next.filter((r) => !['list', 'statuses', 'refs'].includes(r))).toEqual([]);
        // Within the interval, from another window: nothing at all.
        const other = await openWindow();
        await other.services.session.me();
        expect(await requestsOf(() => other.notifier.poll())).toEqual([]);
    });
});

describe('cycles on stubbed services', () => {
    const ME: User = { uuid: '{me}', displayName: 'Me' };
    const home = (over: Partial<Home>): Home => ({ me: ME, repos: [`${WS}/${REPO}`], groups: [], errors: [], truncated: [], ...over });
    const card = (id: number, over: Partial<PrCard> = {}): PrCard => ({
        workspace: WS, repo: REPO, id, title: `PR ${id}`, author: { uuid: '{cam}', displayName: 'Camille' }, url: '', createdOn: '', updatedOn: '',
        versionsCount: 2, lastPushAt: '', lastReviewed: null, newVersions: 0, newCodeVersions: null, approvals: 0, requiredApprovals: 2,
        myApproval: false, newComments: 0, needsReview: true, designatedReviewer: false, followed: false, approvalHolds: false, build: null,
        needsRebase: null, head: `${id}`.padEnd(12, 'a'), draft: false, ...over,
    });
    const todo = (...prs: PrCard[]): Home => home({ groups: [{ key: 'to-do', prs }, { key: 'mine', prs: [] }, { key: 'waiting', prs: [] }, { key: 'others', prs: [] }] });

    /** Notifier on stubbed session, home and PR services (no Bitbucket). */
    async function stubbed({ hasToken = true, me = ME, get = async () => home({}), repos = [`${WS}/${REPO}`], kinds = async () => [] as { hash: string; kind: VersionKind }[] }: {
        hasToken?: boolean;
        me?: User | null;
        get?: () => Promise<Home>;
        repos?: string[];
        kinds?: (ref: unknown) => Promise<{ hash: string; kind: VersionKind }[]>;
    } = {}) {
        const store = new Store(fs.mkdtempSync(path.join(dir, 'stub-')));
        await store.saveConfig({ repos });
        const onPolled = vi.fn();
        const session = { hasToken: vi.fn(async () => hasToken), me: vi.fn(async () => me) };
        const homeService = { get: vi.fn(get) };
        const prs = { versionKinds: vi.fn(kinds) };
        const notifier = new Notifier({
            store,
            session: session as unknown as BitbucketSession,
            home: homeService as unknown as HomeService,
            prs: prs as unknown as PrService,
            onPolled,
        });
        notifiers.push(notifier);
        return { notifier, store, onPolled, get: homeService.get, me: session.me, versionKinds: prs.versionKinds };
    }

    it('no token, no repositories, or me unknown: no PR list fetched, nothing recorded, nothing refreshed', async () => {
        const cases = [await stubbed({ hasToken: false }), await stubbed({ repos: [] }), await stubbed({ me: null })];
        for (const { notifier, store, onPolled, get } of cases) {
            await notifier.poll();
            expect(store.notified().initialized).toBe(false);
            expect(onPolled).not.toHaveBeenCalled();
            expect(get).not.toHaveBeenCalled();
        }
        expect(cases[0]?.me).not.toHaveBeenCalled();
        expect(cases[2]?.me).toHaveBeenCalledTimes(1);
    });

    it('reads the home through its caches, never fresh (fresh is for the "Refresh" command only)', async () => {
        const { notifier, get } = await stubbed();
        await notifier.poll();
        expect(get).toHaveBeenCalledTimes(1);
        expect(get).not.toHaveBeenCalledWith(expect.objectContaining({ fresh: true }));
    });

    it('a failing refresh never throws from the timer', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { notifier, onPolled } = await stubbed({ get: async () => {
            throw new Error('network down');
        } });
        await expect(notifier.poll()).resolves.toBeUndefined();
        expect(onPolled).not.toHaveBeenCalled();
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('network down'));
    });

    describe('code check of new versions', () => {
        const prKey = (id: number): string => `${WS}/${REPO}#${id}`;
        const hash = (id: number, version: number): string => `${id}v${version}`.padEnd(40, '0');
        /** Before: #1 reviewed, #2 approved, #3 untouched; after: a new head on each. */
        const before = todo(card(1, { lastReviewed: 1, head: hash(1, 1).slice(0, 12) }), card(2, { myApproval: true, head: hash(2, 1).slice(0, 12) }), card(3, { head: hash(3, 1).slice(0, 12) }));
        const after = todo(card(1, { lastReviewed: 1, head: hash(1, 2).slice(0, 12) }), card(2, { myApproval: true, head: hash(2, 2).slice(0, 12) }), card(3, { head: hash(3, 2).slice(0, 12) }));

        it('only the candidates are checked; rebase-only gives nothing, code notifies, a failed check counts as code', async () => {
            vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            let current = before;
            const kinds = async (ref: unknown): Promise<{ hash: string; kind: VersionKind }[]> => {
                const id = (ref as { id: number }).id;
                if (id === 2) {
                    throw new Error('summary failed');
                }
                return [{ hash: hash(id, 1), kind: 'creation' }, { hash: hash(id, 2), kind: 'rebase-only' }];
            };
            const { notifier, versionKinds, store } = await stubbed({ get: async () => current, kinds });
            await notifier.poll();
            expect(versionKinds).not.toHaveBeenCalled();
            current = after;
            await notifier.poll();
            expect(versionKinds.mock.calls.map(([ref]) => (ref as { id: number }).id).sort()).toEqual([1, 2]);
            expect(recorded.infos).toEqual(['New version to review: PR 2']);
            expect(store.notified().seen[prKey(1)]?.split(' ')[0]).toBe(hash(1, 2).slice(0, 12));
        });

        it('I4: versions lagging behind the list (no version at the new head yet): not recorded, notified once they catch up', async () => {
            let current = before;
            let lagging = true;
            const kinds = async (ref: unknown): Promise<{ hash: string; kind: VersionKind }[]> => {
                const id = (ref as { id: number }).id;
                return lagging ? [{ hash: hash(id, 1), kind: 'creation' }] : [{ hash: hash(id, 1), kind: 'creation' }, { hash: hash(id, 2), kind: 'code' }];
            };
            const { notifier, store } = await stubbed({ get: async () => current, kinds });
            await notifier.poll();
            current = after;
            await notifier.poll();
            expect(recorded.infos).toEqual([]);
            expect(store.notified().seen[prKey(1)]).toBe(hash(1, 1).slice(0, 12));
            lagging = false;
            await notifier.poll();
            expect(recorded.infos).toEqual(['New version to review: PR 1', 'New version to review: PR 2']);
            await notifier.poll();
            expect(recorded.infos).toHaveLength(2);
        });

        it('never checked when the newVersion notification is off', async () => {
            let current = before;
            const { notifier, versionKinds, store } = await stubbed({ get: async () => current });
            await store.saveConfig({ review: { ...store.config.review, notifications: { newPullRequest: true, newVersion: false, buildFailed: true } } });
            await notifier.poll();
            current = after;
            await notifier.poll();
            expect(versionKinds).not.toHaveBeenCalled();
            expect(recorded.infos).toEqual([]);
        });
    });

    it('a repository removed from the settings is forgotten, so tracking it again records a silent baseline', async () => {
        const web = `${WS}/records-web`;
        const both = (...prs: PrCard[]): Home => ({ ...todo(...prs), repos: [`${WS}/${REPO}`, web] });
        const webCard = (id: number): PrCard => card(id, { repo: 'records-web', followed: true });
        let current = both(card(1, { followed: true }), webCard(2));
        const { notifier, store } = await stubbed({ repos: [`${WS}/${REPO}`, web], get: async () => current });
        await notifier.poll();
        expect(store.notified().seen[web]).toBeDefined();

        await store.saveConfig({ repos: [`${WS}/${REPO}`] });
        notifier.repositoriesChanged();
        expect(Object.keys(store.notified().seen).filter((key) => key.startsWith(web))).toEqual([]);
        expect(store.notified().seen[`${WS}/${REPO}#1`]).toBeDefined();

        await store.saveConfig({ repos: [`${WS}/${REPO}`, web] });
        notifier.repositoriesChanged();
        current = both(card(1, { followed: true }), webCard(2), webCard(3));
        await notifier.poll();
        expect(recorded.infos).toEqual([]);
    });

    it('burst: at most 3 toasts, then one summary whose "Show" focuses the Revspan view; everything recorded', async () => {
        let current = todo();
        const { notifier, store } = await stubbed({ get: async () => current });
        await notifier.poll();
        current = todo(...[1, 2, 3, 4, 5].map((id) => card(id, { followed: true })));
        const shown = vi.spyOn(window, 'showInformationMessage').mockImplementation(async (message: string) => {
            recorded.infos.push(message);
            return (message.includes('more') ? 'Show' : undefined) as never;
        });
        await notifier.poll();
        await vi.waitFor(() => expect(recorded.commands).toEqual([{ command: 'revspan.home.focus', args: [] }]));
        expect(shown).toHaveBeenCalledTimes(4);
        expect(recorded.infos).toEqual([
            'New PR to review from Camille: PR 1', 'New PR to review from Camille: PR 2', 'New PR to review from Camille: PR 3',
            '2 more pull requests need your attention',
        ]);
        expect(Object.keys(store.notified().seen).filter((k) => k.includes('#'))).toHaveLength(5);
    });

    it('one more: singular summary, in French too', async () => {
        let current = todo();
        const { notifier } = await stubbed({ get: async () => current });
        await notifier.poll();
        current = todo(...[1, 2, 3, 4].map((id) => card(id, { followed: true })));
        env.language = 'fr';
        await notifier.poll();
        expect(recorded.infos.at(-1)).toBe('1 autre PR demande ton attention');
    });

    it('polls after the startup delay, then every refresh interval; re-armed on a change; stopped when disposed', async () => {
        vi.useFakeTimers();
        const { notifier, store } = await stubbed();
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
        const { notifier } = await stubbed();
        const poll = vi.spyOn(notifier, 'poll');
        notifier.start(10_000);
        notifier.dispose();
        await vi.advanceTimersByTimeAsync(60 * 60_000);
        expect(poll).not.toHaveBeenCalled();
    });
});
