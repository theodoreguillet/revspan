import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cache } from '../../src/server/infra/cache.ts';
import { Store, type NotifiedState, type RepoSource, type ReviewSource } from '../../src/server/infra/config.ts';
import { HomeService, homeIdentity, type HomeLoad } from '../../src/server/services/home-service.ts';
import type { BitbucketSession } from '../../src/server/services/session.ts';
import { planNotifications, type PendingNotification } from '../../src/extension/lib/notifications.ts';
import type { Home, PrCard, User } from '../../src/shared/api.ts';
import { DEFAULT_REVIEW_SETTINGS, normalizeReviewSettings, type ReviewSettings } from '../../src/shared/review-settings.ts';
import { AppError } from '../../src/server/errors.ts';

const dirs: string[] = [];
const tempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revspan-store-'));
    dirs.push(dir);
    return dir;
};
const configFile = (dir: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;

/** In-memory repository source (like the VS Code revspan.repositories setting). */
function memorySource(initial: string[]): RepoSource & { value: string[] } {
    return {
        value: initial,
        get() {
            return this.value;
        },
        async set(repos) {
            this.value = repos;
        },
    };
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

describe('local settings (Store)', () => {
    it('without an external source: repositories and e-mail in config.json', async () => {
        const dir = tempDir();
        const store = new Store(dir);
        expect(store.config).toEqual({ email: '', repos: [], review: DEFAULT_REVIEW_SETTINGS });
        await store.saveConfig({ email: 'a@b.c', repos: ['ws/a'] });
        expect(configFile(dir)).toMatchObject({ email: 'a@b.c', repos: ['ws/a'] });
        expect(new Store(dir).config.repos).toEqual(['ws/a']);
    });

    it('with an external source: repositories read and written in the source, normalized, the saved value never reaches config.json', async () => {
        const dir = tempDir();
        const source = memorySource(['https://bitbucket.org/ws/a/src/main/', 'not a repo', 'ws/a', 'ws/b']);
        const store = new Store(dir, { repoSource: source });
        expect(store.config.repos).toEqual(['ws/a', 'ws/b']);

        const saved = await store.saveConfig({ email: 'a@b.c', repos: ['ws/c'] });
        expect(source.value).toEqual(['ws/c']);
        expect(saved).toMatchObject({ email: 'a@b.c', repos: ['ws/c'] });
        expect(configFile(dir)).toMatchObject({ email: 'a@b.c', repos: [] });

        source.value = ['ws/d'];
        expect(store.config.repos).toEqual(['ws/d']);
    });
});

/** In-memory review settings source (like the VS Code revspan.review.* settings). */
function memoryReviewSource(initial: unknown): ReviewSource & { value: unknown } {
    return {
        value: initial,
        get() {
            return this.value;
        },
        async set(review: ReviewSettings) {
            this.value = review;
        },
    };
}

describe('review settings (Store)', () => {
    it('without an external source: defaults, then saved in config.json and normalized', async () => {
        const dir = tempDir();
        const store = new Store(dir);
        expect(store.config.review).toEqual(DEFAULT_REVIEW_SETTINGS);
        const review = normalizeReviewSettings({ requiredApprovals: 3, requiredApprovalsByRepo: { 'acme/records-api': 1 } });
        await store.saveConfig({ review });
        expect(configFile(dir).review).toEqual(review);
        expect(new Store(dir).config.review).toEqual(review);
    });

    it('config.json with invalid review values: defaults for those values', () => {
        const dir = tempDir();
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ email: 'a@b.c', review: { requiredApprovals: 0, refreshMinutes: 10 } }));
        expect(new Store(dir).config.review).toEqual({ ...DEFAULT_REVIEW_SETTINGS, refreshMinutes: 10 });
    });

    it('with an external source: read and written in the source (re-read every time), the saved value never reaches config.json', async () => {
        const dir = tempDir();
        const source = memoryReviewSource({ requiredApprovals: 4 });
        const store = new Store(dir, { reviewSource: source });
        expect(store.config.review.requiredApprovals).toBe(4);

        const review = normalizeReviewSettings({ requiredApprovals: 3 });
        await store.saveConfig({ review });
        expect(source.value).toEqual(review);
        expect(configFile(dir).review).toEqual(DEFAULT_REVIEW_SETTINGS);

        source.value = { requiredApprovals: 0 };
        expect(store.config.review).toEqual(DEFAULT_REVIEW_SETTINGS);
    });
});

describe('PR state write that fails', () => {
    it('leaves no phantom mark in memory: the state read next is the one on disk', () => {
        const dir = tempDir();
        const store = new Store(dir);
        const key = 'acme/records-api#1';
        store.updatePrState(key, (s) => {
            s.viewed['src/a.ts'] = 'h1';
            s.kinds['0123456789ab'] = 'code';
        });
        vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
            throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        });
        expect(() => store.updatePrState(key, (s) => {
            s.viewed['src/b.ts'] = 'h2';
            s.kinds['ba9876543210'] = 'rebase-only';
        })).toThrow(/ENOSPC/);
        expect(store.prState(key).viewed).toEqual({ 'src/a.ts': 'h1' });
        expect(store.prState(key).kinds).toEqual({ '0123456789ab': 'code' });
    });
});

describe('state shared between several windows (two Stores, same folder)', () => {
    it('two marks on different PRs are both kept and visible on both sides', () => {
        const dir = tempDir();
        const a = new Store(dir);
        const b = new Store(dir);
        a.updatePrState('acme/records-api#1', (s) => {
            s.reviewedAt = '2026-01-01T00:00:00Z';
        });
        b.updatePrState('acme/records-api#2', (s) => {
            s.viewed['src/a.ts'] = 'abc';
        });
        const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as { prs: Record<string, unknown> };
        expect(Object.keys(onDisk.prs).sort()).toEqual(['acme/records-api#1', 'acme/records-api#2']);
        expect(a.prState('acme/records-api#2').viewed).toEqual({ 'src/a.ts': 'abc' });
        expect(b.prState('acme/records-api#1').reviewedAt).toBe('2026-01-01T00:00:00Z');
    });

    it('a mark made by A after B was created is read by B', () => {
        const dir = tempDir();
        const a = new Store(dir);
        const b = new Store(dir);
        expect(b.prState('acme/records-api#1').viewed).toEqual({});
        a.updatePrState('acme/records-api#1', (s) => {
            s.viewed['x.ts'] = 'h1';
        });
        expect(b.prState('acme/records-api#1').viewed).toEqual({ 'x.ts': 'h1' });
    });

    it('config modified by A is visible to B, and B does not overwrite it when saving something else', async () => {
        const dir = tempDir();
        const a = new Store(dir);
        const b = new Store(dir);
        await a.saveConfig({ repos: ['acme/records-api'] });
        expect(b.config.repos).toEqual(['acme/records-api']);
        const c = new Store(dir);
        await a.saveConfig({ repos: ['acme/records-api', 'acme/billing'] });
        await c.saveConfig({ email: 'rev@example.com' });
        expect(configFile(dir)).toEqual({ email: 'rev@example.com', repos: ['acme/records-api', 'acme/billing'], review: DEFAULT_REVIEW_SETTINGS });
    });

    it('deleted or corrupt file: default values', () => {
        const dir = tempDir();
        const a = new Store(dir);
        a.updatePrState('acme/records-api#1', (s) => {
            s.viewed['x.ts'] = 'h1';
        });
        fs.writeFileSync(path.join(dir, 'state.json'), '{pas du json');
        expect(a.prState('acme/records-api#1').viewed).toEqual({});
        fs.rmSync(path.join(dir, 'state.json'));
        expect(a.prState('acme/records-api#1').viewed).toEqual({});
    });
});

describe('notified state (Store)', () => {
    const stateFile = (dir: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as Record<string, unknown>;

    it('defaults, then kept in state.json next to the PR states, each write keeping the other section', () => {
        const dir = tempDir();
        const store = new Store(dir);
        expect(store.notified()).toEqual({ initialized: false, seen: {} });
        store.updatePrState('acme/records-api#1', (s) => {
            s.viewed['a.ts'] = 'h1';
        });
        store.updateNotified((s) => {
            s.initialized = true;
            s.seen['acme/records-api#1'] = '0123456789ab';
        });
        store.updatePrState('acme/records-api#2', (s) => {
            s.viewed['b.ts'] = 'h2';
        });
        expect(stateFile(dir)).toMatchObject({ notified: { initialized: true, seen: { 'acme/records-api#1': '0123456789ab' } } });
        expect(new Store(dir).notified()).toEqual({ initialized: true, seen: { 'acme/records-api#1': '0123456789ab' } });
        expect(new Store(dir).prState('acme/records-api#1').viewed).toEqual({ 'a.ts': 'h1' });
    });

    it('a mutation that throws or changes nothing writes nothing, and the returned state is a copy', () => {
        const dir = tempDir();
        const store = new Store(dir);
        store.notified().seen.x = 'y';
        store.updateNotified(() => undefined);
        expect(fs.existsSync(path.join(dir, 'state.json'))).toBe(false);
        expect(() => store.updateNotified((s) => {
            s.initialized = true;
            throw new Error('boom');
        })).toThrow('boom');
        expect(store.notified()).toEqual({ initialized: false, seen: {} });
    });

    it('invalid section: defaults, only text values are kept', () => {
        const dir = tempDir();
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ prs: {}, notified: { initialized: 'yes', seen: { a: 'h', b: 3, c: null } } }));
        expect(new Store(dir).notified()).toEqual({ initialized: false, seen: { a: 'h' } });
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ prs: {}, notified: ['x'] }));
        expect(new Store(dir).notified()).toEqual({ initialized: false, seen: {} });
    });

    describe('Review Focus 5: two windows polling the same profile', () => {
        /** The guard of the notifier: a key is claimed only if the state re-read from disk does not hold it yet. */
        const claim = (store: Store, key: string, head: string): boolean => {
            let won = false;
            store.updateNotified((s) => {
                if (s.seen[key] !== head) {
                    s.seen[key] = head;
                    won = true;
                }
            });
            return won;
        };

        it('the same pending key applied by two Stores: only the first wins', () => {
            const dir = tempDir();
            const a = new Store(dir);
            const b = new Store(dir);
            // Both windows have read the state before either writes.
            expect(a.notified().seen).toEqual({});
            expect(b.notified().seen).toEqual({});
            expect(claim(a, 'acme/records-api#1', 'aaaaaaaaaaaa')).toBe(true);
            expect(claim(b, 'acme/records-api#1', 'aaaaaaaaaaaa')).toBe(false);
            expect(claim(b, 'acme/records-api#1', 'bbbbbbbbbbbb')).toBe(true);
            expect(claim(a, 'acme/records-api#1', 'bbbbbbbbbbbb')).toBe(false);
        });

        const prefs = { newPullRequest: true, newVersion: true, buildFailed: true };
        const card = (head: string): PrCard => ({
            workspace: 'acme', repo: 'records-api', id: 7, title: 'PR 7', author: { uuid: '{cam}', displayName: 'Camille' }, url: '',
            createdOn: '', updatedOn: '', versionsCount: 2, lastPushAt: '', lastReviewed: 1, newVersions: 1, newCodeVersions: 1,
            approvals: 0, requiredApprovals: 2, myApproval: false, newComments: 0, needsReview: true, designatedReviewer: false,
            followed: true, approvalHolds: false, build: null, needsRebase: null, head, draft: false,
        });
        const home = (prs: PrCard[]): Home => ({
            me: { uuid: '{me}', displayName: 'Robin' }, repos: ['acme/records-api'], errors: [], truncated: [], hideUnfollowed: false, contributors: [],
            groups: [{ key: 'to-do', prs }, { key: 'to-rebase', prs: [] }, { key: 'mine', prs: [] }, { key: 'waiting', prs: [] }, { key: 'others', prs: [] }],
        });
        /** One poll of a window: plan on the state re-read inside the update, as the notifier does. */
        const poll = (store: Store, polled: Home): PendingNotification[] => {
            let sent: PendingNotification[] = [];
            store.updateNotified((state: NotifiedState) => {
                const plan = planNotifications(polled, prefs, state);
                Object.assign(state, plan.next);
                sent = plan.notifications;
            });
            return sent;
        };

        it('the planner run in each window gives one notification for a PR and head, never two', () => {
            const dir = tempDir();
            const windows = [new Store(dir), new Store(dir)];
            const sent = (polled: Home): string[] => windows.flatMap((store) => poll(store, polled).map((n) => `${n.kind} #${n.ref.id}`));

            expect(sent(home([]))).toEqual([]);
            expect(sent(home([card('aaaaaaaaaaaa')]))).toEqual(['newPullRequest #7']);
            expect(sent(home([card('bbbbbbbbbbbb')]))).toEqual(['newVersion #7']);
            expect(sent(home([card('bbbbbbbbbbbb')]))).toEqual([]);
        });

        it('window B polling with an older home after window A: no duplicate, in either window', () => {
            const dir = tempDir();
            const [a, b] = [new Store(dir), new Store(dir)];
            poll(a, home([card('aaaaaaaaaaaa')]));
            expect(poll(a, home([card('bbbbbbbbbbbb')])).map((n) => n.kind)).toEqual(['newVersion']);
            // B's request was answered by a lagging replica: it still sees the previous head.
            expect(poll(b, home([card('aaaaaaaaaaaa')]))).toEqual([]);
            expect(poll(a, home([card('bbbbbbbbbbbb')]))).toEqual([]);
            expect(poll(b, home([card('bbbbbbbbbbbb')]))).toEqual([]);
        });
    });
});

/** The release of a lease this window took (the test fails when another window held it). */
function asRelease(claim: ReturnType<Store['claimHomeLease']>): () => void {
    if (!claim) {
        throw new Error('lease held by another window');
    }
    return claim;
}

/** Home identities (homeIdentity: 16 hex characters). */
const ID_A = 'aaaaaaaaaaaaaaaa';
const ID_B = 'bbbbbbbbbbbbbbbb';
const ID_C = 'cccccccccccccccc';
const ID_D = 'dddddddddddddddd';
const lockOf = (dir: string, identity: string): string => path.join(dir, `home-${identity}.lock`);
/** Lease files of the folder, sorted. */
const lockFiles = (dir: string): string[] => fs.readdirSync(dir).filter((name) => name.endsWith('.lock')).sort();

describe('home shared between windows (Store)', () => {
    const home: Home = { me: null, repos: ['acme/records-api'], groups: [], errors: [], truncated: [], hideUnfollowed: false, contributors: [] };

    it('a snapshot saved by one window is read by another; dropped, it is gone for both', () => {
        const dir = tempDir();
        const a = new Store(dir);
        const b = new Store(dir);
        expect(b.homeSnapshot('id-a')).toBeNull();
        a.writeHomeSnapshot('id-a', { at: 1000, key: 'k', home }, a.homeGeneration());
        expect(b.homeSnapshot('id-a')).toEqual({ at: 1000, key: 'k', home });
        expect(b.homeSnapshot('id-b')).toBeNull();
        b.dropHomeSnapshot();
        expect(a.homeSnapshot('id-a')).toBeNull();
        fs.writeFileSync(path.join(dir, 'home.json'), '{"homes":[{"identity":"id-a","at":"x"}]}');
        expect(a.homeSnapshot('id-a')).toBeNull();
    });

    it('snapshots per home identity (profiles share the folder): both kept, a fifth identity drops the least recently written', () => {
        const dir = tempDir();
        const a = new Store(dir);
        const b = new Store(dir);
        const write = (identity: string, at: number): boolean => a.writeHomeSnapshot(identity, { at, key: `k-${identity}`, home }, a.homeGeneration());
        write('id-a', 1000);
        b.writeHomeSnapshot('id-b', { at: 900, key: 'k-id-b', home }, b.homeGeneration());
        expect(a.homeSnapshot('id-a')?.key).toBe('k-id-a');
        expect(a.homeSnapshot('id-b')?.key).toBe('k-id-b');
        write('id-c', 1100);
        write('id-d', 1200);
        // id-a written again: the most recent now, whatever its computation date.
        write('id-a', 1300);
        write('id-e', 1400);
        expect(['id-a', 'id-b', 'id-c', 'id-d', 'id-e'].filter((identity) => b.homeSnapshot(identity) !== null)).toEqual(['id-a', 'id-c', 'id-d', 'id-e']);
        expect(b.homeSnapshot('id-a')).toEqual({ at: 1300, key: 'k-id-a', home });
        write('id-f', 1500);
        expect(['id-a', 'id-c', 'id-d', 'id-e', 'id-f'].filter((identity) => b.homeSnapshot(identity) !== null)).toEqual(['id-a', 'id-d', 'id-e', 'id-f']);
    });

    it('a home.json of 3.4 (one snapshot, no identity) reads as empty, nothing thrown; the next write replaces it', () => {
        const dir = tempDir();
        fs.writeFileSync(path.join(dir, 'home.json'), JSON.stringify({ at: 1000, key: 'k', home }));
        const store = new Store(dir);
        expect(store.homeSnapshot('k')).toBeNull();
        expect(store.writeHomeSnapshot('id-a', { at: 2000, key: 'k', home }, store.homeGeneration())).toBe(true);
        expect(new Store(dir).homeSnapshot('id-a')).toEqual({ at: 2000, key: 'k', home });
    });

    it('lease: one holder at a time, released by its holder only, taken over once stale', () => {
        vi.useFakeTimers();
        try {
            const dir = tempDir();
            const a = new Store(dir);
            const b = new Store(dir);
            const releaseA = a.claimHomeLease(60_000, ID_A);
            expect(releaseA).toBeTypeOf('function');
            expect(b.claimHomeLease(60_000, ID_A)).toBeNull();
            asRelease(releaseA)();
            const releaseB = b.claimHomeLease(60_000, ID_A);
            expect(releaseB).toBeTypeOf('function');
            // A holder that never released (window closed mid-computation) is taken over once stale.
            vi.advanceTimersByTime(60_001);
            const releaseA2 = a.claimHomeLease(60_000, ID_A);
            expect(releaseA2).toBeTypeOf('function');
            // The late release of the old holder does not free the new holder's lease.
            asRelease(releaseB)();
            expect(b.claimHomeLease(60_000, ID_A)).toBeNull();
            asRelease(releaseA2)();
            expect(b.claimHomeLease(60_000, ID_A)).toBeTypeOf('function');
        } finally {
            vi.useRealTimers();
        }
    });

    it('one lease per home identity: a window computing another home (another profile) does not hold this one', () => {
        const dir = tempDir();
        const a = new Store(dir);
        const b = new Store(dir);
        const releaseA = asRelease(a.claimHomeLease(60_000, ID_A));
        const releaseB = asRelease(b.claimHomeLease(60_000, ID_B));
        expect(a.claimHomeLease(60_000, ID_B)).toBeNull();
        expect(b.claimHomeLease(60_000, ID_A)).toBeNull();
        expect(lockFiles(dir)).toEqual([`home-${ID_A}.lock`, `home-${ID_B}.lock`]);
        expect(JSON.parse(fs.readFileSync(lockOf(dir, ID_A), 'utf8'))).toEqual({ token: expect.any(String), at: expect.any(Number), identity: ID_A });
        releaseA();
        releaseB();
        expect(lockFiles(dir)).toEqual([]);
    });

    it('the lease of 3.4 (home.lock) is ignored and left alone; a lease being written (empty file) counts as held', () => {
        const dir = tempDir();
        const store = new Store(dir);
        fs.writeFileSync(path.join(dir, 'home.lock'), JSON.stringify({ token: 'older-version', at: Date.now() }));
        asRelease(store.claimHomeLease(60_000, ID_A))();
        expect(lockFiles(dir)).toEqual(['home.lock']);
        fs.writeFileSync(lockOf(dir, ID_B), '');
        expect(store.claimHomeLease(60_000, ID_B)).toBeNull();
    });

    it('the identity is checked before it names a file', () => {
        const store = new Store(tempDir());
        for (const identity of ['../config', '', 'AAAAAAAAAAAAAAAA', 'aaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa.lock']) {
            expect(() => store.claimHomeLease(60_000, identity)).toThrow('invalid home identity');
        }
    });

    it('taking a lease sweeps the stale leases of other homes, and a stale home.lock of 3.4; fresh ones and other files stay', () => {
        const dir = tempDir();
        const old = new Date(Date.now() - 3600_000);
        fs.writeFileSync(lockOf(dir, ID_B), JSON.stringify({ token: 'b', at: Date.now() - 61_000, identity: ID_B }));
        fs.writeFileSync(lockOf(dir, ID_C), JSON.stringify({ token: 'c', at: Date.now() - 1000, identity: ID_C }));
        // Unreadable (a window closed while writing it): aged by its modification time.
        fs.writeFileSync(lockOf(dir, ID_D), '');
        fs.utimesSync(lockOf(dir, ID_D), old, old);
        fs.writeFileSync(path.join(dir, 'home.lock'), JSON.stringify({ token: 'older-version', at: Date.now() - 3600_000 }));
        fs.writeFileSync(path.join(dir, 'home-notes.lock'), '');
        fs.utimesSync(path.join(dir, 'home-notes.lock'), old, old);
        // A stale lease that cannot be removed (a folder): skipped, nothing thrown.
        fs.mkdirSync(path.join(dir, `home-${'e'.repeat(16)}.lock`, 'inside'), { recursive: true });
        fs.utimesSync(path.join(dir, `home-${'e'.repeat(16)}.lock`), old, old);
        const release = asRelease(new Store(dir).claimHomeLease(60_000, ID_A));
        expect(lockFiles(dir)).toEqual([`home-${ID_A}.lock`, `home-${ID_C}.lock`, `home-${'e'.repeat(16)}.lock`, 'home-notes.lock']);
        release();
    });

    it('a home.lock of 3.4 still fresh (a 3.4 window computing) stays, then goes with the first sweep once stale', () => {
        vi.useFakeTimers();
        try {
            const dir = tempDir();
            fs.writeFileSync(path.join(dir, 'home.lock'), JSON.stringify({ token: 'older-version', at: Date.now() }));
            const store = new Store(dir);
            asRelease(store.claimHomeLease(60_000, ID_A))();
            expect(lockFiles(dir)).toEqual(['home.lock']);
            vi.advanceTimersByTime(60_001);
            asRelease(store.claimHomeLease(60_000, ID_A))();
            expect(lockFiles(dir)).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a home computed before a drop (a write in any window) is refused', () => {
        const dir = tempDir();
        const a = new Store(dir);
        const b = new Store(dir);
        const generation = a.homeGeneration();
        b.dropHomeSnapshot();
        expect(a.homeGeneration()).not.toBe(generation);
        expect(a.writeHomeSnapshot('id-a', { at: 1000, key: 'k', home }, generation)).toBe(false);
        expect(b.homeSnapshot('id-a')).toBeNull();
        expect(a.writeHomeSnapshot('id-a', { at: 2000, key: 'k', home }, a.homeGeneration())).toBe(true);
    });

    it('a stale lease that cannot be removed: the caller computes anyway, nothing thrown', () => {
        const dir = tempDir();
        const lock = lockOf(dir, ID_A);
        fs.mkdirSync(path.join(lock, 'inside'), { recursive: true });
        const past = new Date(Date.now() - 3600_000);
        fs.utimesSync(lock, past, past);
        const release = new Store(dir).claimHomeLease(60_000, ID_A);
        expect(release).toBeTypeOf('function');
        expect(() => asRelease(release)()).not.toThrow();
    });

    it('local signature: changed by a "reviewed" mark or a version type, not by seen files', () => {
        const store = new Store(tempDir());
        const initial = store.localSignature();
        store.updatePrState('acme/records-api#1', (state) => {
            state.viewed['src/A.ts'] = 'h1';
        });
        expect(store.localSignature()).toBe(initial);
        store.updatePrState('acme/records-api#1', (state) => {
            state.kinds.abcdef123456 = 'code';
        });
        const withKind = store.localSignature();
        expect(withKind).not.toBe(initial);
        store.updatePrState('acme/records-api#1', (state) => {
            state.reviewedHash = 'abcdef123456';
        });
        expect(store.localSignature()).not.toBe(withKind);
    });
});

describe('home computed by one window per home identity (HomeService, VS Code profiles sharing the storage)', () => {
    const ME: User = { uuid: '{me}', displayName: 'Thomas Girard' };
    const CAMILLE: User = { uuid: '{cam}', displayName: 'Camille Durand' };
    const YANN: User = { uuid: '{yann}', displayName: 'Yann Bernard' };

    /**
     * A window of a profile following `followed` (its review settings are per profile, the folder is shared). No
     * repository: a computation reads only my profile, through `me` (held while the returned promise is pending).
     */
    function profileWindow(dir: string, followed: User[], me: () => Promise<User | null> = async () => ME) {
        const loads: HomeLoad[] = [];
        const store = new Store(dir, { reviewSource: memoryReviewSource({ followed }) });
        const session = { getClient: vi.fn(async () => ({})), me: vi.fn(me) };
        const service = new HomeService({ session: session as unknown as BitbucketSession, store, cache: new Cache(null), onLoad: (load) => loads.push(load) });
        return { service, session, loads };
    }

    function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
        let resolve: (value: T) => void = () => undefined;
        const promise = new Promise<T>((done) => {
            resolve = done;
        });
        return { promise, resolve };
    }

    /** Whether a promise settled once the pending work ran (no time passes unless `ms` is given). */
    async function settledAfter(promise: Promise<unknown>, ms = 0): Promise<boolean> {
        let settled = false;
        void promise.finally(() => {
            settled = true;
        });
        await vi.advanceTimersByTimeAsync(ms);
        return settled;
    }


    it('identity: 16 hex characters of the home key\'s sha256', () => {
        expect(homeIdentity('key')).toMatch(/^[0-9a-f]{16}$/);
        expect(homeIdentity('key')).toBe(homeIdentity('key'));
        expect(homeIdentity('other key')).not.toBe(homeIdentity('key'));
    });

    it('another profile\'s window holds the lease of its own home: this window computes at once, without waiting', async () => {
        vi.useFakeTimers();
        const dir = tempDir();
        const meB = deferred<User | null>();
        const b = profileWindow(dir, [CAMILLE], () => meB.promise);
        const bLoad = b.service.get();
        await vi.advanceTimersByTimeAsync(0);
        const held = lockFiles(dir);
        expect(held).toEqual([expect.stringMatching(/^home-[0-9a-f]{16}\.lock$/)]);

        const a = profileWindow(dir, [YANN]);
        const aLoad = a.service.get();
        expect(await settledAfter(aLoad)).toBe(true);
        expect(a.session.me).toHaveBeenCalledTimes(1);
        expect(a.loads).toEqual([expect.objectContaining({ fresh: false, source: 'computed', leaseWaitMs: 0 })]);
        expect(held).not.toContain(`home-${a.loads[0]?.identity}.lock`);
        // A took and released its own lease; B's is still B's.
        expect(lockFiles(dir)).toEqual(held);

        meB.resolve(ME);
        await bLoad;
        // Both homes kept: a second window of each profile reuses its own, without computing.
        const a2 = profileWindow(dir, [YANN]);
        const b2 = profileWindow(dir, [CAMILLE]);
        expect(await a2.service.get()).toEqual(await aLoad);
        expect(await b2.service.get()).toEqual(await bLoad);
        expect(a2.session.me).not.toHaveBeenCalled();
        expect(b2.session.me).not.toHaveBeenCalled();
        expect([a2.loads[0]?.source, b2.loads[0]?.source]).toEqual(['shared', 'shared']);
    });

    it('two profiles with two windows each, polling together: one computation per profile, the other window waits for it', async () => {
        vi.useFakeTimers();
        const dir = tempDir();
        const [meA, meB] = [deferred<User | null>(), deferred<User | null>()];
        const a1 = profileWindow(dir, [YANN], () => meA.promise);
        const a2 = profileWindow(dir, [YANN]);
        const b1 = profileWindow(dir, [CAMILLE], () => meB.promise);
        const b2 = profileWindow(dir, [CAMILLE]);
        const loads = [a1, a2, b1, b2].map((w) => w.service.get());
        await vi.advanceTimersByTimeAsync(1_000);
        meA.resolve(ME);
        meB.resolve(ME);
        await vi.advanceTimersByTimeAsync(100);
        const [homeA1, homeA2, homeB1, homeB2] = await Promise.all(loads);
        expect([a1, a2, b1, b2].map((w) => w.session.me.mock.calls.length)).toEqual([1, 0, 1, 0]);
        expect(homeA2).toEqual(homeA1);
        expect(homeB2).toEqual(homeB1);
        expect([a2.loads[0]?.source, b2.loads[0]?.source]).toEqual(['shared', 'shared']);
        expect(a2.loads[0]?.leaseWaitMs).toBe(1_100);
    });

    it('a window of the same profile holds the lease: this window waits for its home, no second computation', async () => {
        vi.useFakeTimers();
        const dir = tempDir();
        const meA1 = deferred<User | null>();
        const a1 = profileWindow(dir, [YANN], () => meA1.promise);
        const a1Load = a1.service.get();
        await vi.advanceTimersByTimeAsync(0);

        const a2 = profileWindow(dir, [YANN]);
        const a2Load = a2.service.get();
        expect(await settledAfter(a2Load, 5_000)).toBe(false);
        meA1.resolve(ME);
        const computed = await a1Load;
        expect(await settledAfter(a2Load, 100)).toBe(true);
        expect(await a2Load).toEqual(computed);
        expect(a2.session.me).not.toHaveBeenCalled();
        expect(a2.loads).toEqual([expect.objectContaining({ source: 'shared', leaseWaitMs: 5_100 })]);
        expect(a2.loads[0]?.identity).toBe(a1.loads[0]?.identity);
    });

    it('a lease left by 3.4 (home.lock) is not waited for', async () => {
        vi.useFakeTimers();
        const dir = tempDir();
        fs.writeFileSync(path.join(dir, 'home.lock'), JSON.stringify({ token: 'older-version', at: Date.now() }));
        const a = profileWindow(dir, [YANN]);
        expect(await settledAfter(a.service.get())).toBe(true);
        expect(a.loads).toEqual([expect.objectContaining({ source: 'computed', leaseWaitMs: 0 })]);
        expect(lockFiles(dir)).toEqual(['home.lock']);
    });

    it('load events: duration, fresh, and the error code of a failed load (no PR data)', async () => {
        vi.useFakeTimers();
        const dir = tempDir();
        const me = deferred<User | null>();
        const a = profileWindow(dir, [YANN], () => me.promise);
        const load = a.service.get({ fresh: true });
        await vi.advanceTimersByTimeAsync(1_500);
        me.resolve(ME);
        await load;
        expect(a.loads).toEqual([{ fresh: true, startedAt: expect.any(Number), durationMs: 1_500, leaseWaitMs: 0, identity: expect.stringMatching(/^[0-9a-f]{16}$/), source: 'computed' }]);

        a.session.getClient.mockRejectedValueOnce(new AppError(409, 'NO_TOKEN', 'No token'));
        await expect(a.service.get()).rejects.toThrow('No token');
        expect(a.loads[1]).toEqual({ fresh: false, startedAt: expect.any(Number), durationMs: 0, leaseWaitMs: 0, identity: a.loads[0]?.identity, error: 'NO_TOKEN' });
    });
});
