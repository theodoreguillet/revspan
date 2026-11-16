// In-memory cache of the loaded PR: what the page reads costs in Bitbucket requests (counted on the fake Bitbucket).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Cache } from '../../src/server/infra/cache.ts';
import { Store } from '../../src/server/infra/config.ts';
import type { SecretStore } from '../../src/server/infra/secrets.ts';
import { PrService } from '../../src/server/services/pr-service.ts';
import { BitbucketSession } from '../../src/server/services/session.ts';
import { FAKE_EMAIL, FAKE_PRS, FAKE_TOKEN, REPO, WS, pushVersion, startFakeBitbucket, type FakeBitbucket } from '../support/fake-bitbucket.ts';

const ref = { workspace: WS, repo: REPO, id: FAKE_PRS.mine };

let fake: FakeBitbucket;
let dir: string;
let clock: number;
let arm: () => void;
let service: PrService;
let store: Store;
/** Held (once) before the comments of the PR are answered, to simulate a slow read in flight. */
let gate: { release: () => void; reached: Promise<void> } | null = null;

beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revspan-prcache-'));
    fake = await startFakeBitbucket();
    store = new Store(dir);
    await store.saveConfig({ email: FAKE_EMAIL, repos: [`${WS}/${REPO}`] });
    const secrets = { kind: 'file', get: async () => FAKE_TOKEN, set: async () => undefined, remove: async () => undefined } as unknown as SecretStore;
    const cache = new Cache(null);
    let armed = false;
    gate = null;
    const slowFetch: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (armed && new RegExp(`/pullrequests/${ref.id}/comments(\\?|$)`).test(String(input)) && (init?.method ?? 'GET') === 'GET') {
            armed = false;
            let reached!: () => void;
            let release!: () => void;
            const open = new Promise<void>((resolve) => { release = resolve; });
            gate = { release, reached: new Promise<void>((resolve) => { reached = resolve; }) };
            reached();
            await open;
        }
        return response;
    };
    arm = () => { armed = true; };
    const session = new BitbucketSession({ store, secrets, cache, baseUrl: fake.url, fetchImpl: slowFetch });
    clock = 1_000_000;
    service = new PrService({ session, store, cache, now: () => clock });
});

afterEach(async () => {
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

/** Requests of the PR itself, its activity and its comments (a PR read costs one of each, plus pages). */
const reads = (): { pr: number; activity: number; comments: number } => {
    const count = (re: RegExp): number => fake.requests.filter((r) => r.method === 'GET' && re.test(r.path)).length;
    return {
        pr: count(new RegExp(`/pullrequests/${ref.id}$`)),
        activity: count(new RegExp(`/pullrequests/${ref.id}/activity$`)),
        comments: count(new RegExp(`/pullrequests/${ref.id}/comments$`)),
    };
};

describe('PrService in-memory cache', () => {
    it('serves compare and summary from the PR loaded by detail', async () => {
        await service.detail(ref);
        await service.compare(ref, 1, 2, 3);
        await service.summary(ref);
        expect(reads()).toEqual({ pr: 1, activity: 1, comments: 1 });
    });

    it('shares one load between concurrent reads', async () => {
        await Promise.all([service.compare(ref, 1, 2, 3), service.summary(ref)]);
        expect(reads().pr).toBe(1);
    });

    it('reloads after a write', async () => {
        await service.detail(ref);
        await service.createComment(ref, { raw: 'hello' });
        await service.compare(ref, 1, 2, 3);
        expect(reads().pr).toBe(2);
        expect(fake.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    });

    it('reloads after the refresh interval', async () => {
        await service.detail(ref);
        clock += 300_001;
        await service.compare(ref, 1, 2, 3);
        expect(reads().pr).toBe(2);
    });

    it('detail always reads Bitbucket again', async () => {
        await service.detail(ref);
        await service.detail(ref);
        expect(reads().pr).toBe(2);
    });

    it('versionKinds reads fresh versions', async () => {
        await service.detail(ref);
        expect((await service.versionKinds(ref)).map((v) => v.kind)).toEqual(['creation', 'code']);
        pushVersion(fake.data, ref.id, {
            commit: 'mine:v3', from: 'mine:v1', base: 'mine:m0', changes: { 'src/mine.ts': 'x\ny1\ny2\ny3\n' }, date: '2026-10-20T09:00:00Z',
        });
        expect(await service.versionKinds(ref)).toHaveLength(3);
    });

    it('never serves data read before a write', async () => {
        arm();
        const cold = service.compare(ref, 1, 2, 3);
        while (!gate) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await service.createComment(ref, { raw: 'brand new' });
        const detail = service.detail(ref);
        gate.release();
        await cold;
        expect(JSON.stringify((await detail).threads)).toContain('brand new');
        // The following compare reuses the post-write load (no third read).
        await service.compare(ref, 1, 2, 3);
        expect(reads()).toMatchObject({ pr: 2, comments: 2 });
    });

    it('reads the source branch without a new PR read after detail', async () => {
        const { pr } = await service.detail(ref);
        expect(await service.sourceBranch(ref)).toBe(pr.sourceBranch);
        await service.sourceBranch(ref);
        expect(reads().pr).toBe(1);
    });

    describe('reopening a PR', () => {
        const open = async (): Promise<void> => {
            await service.detail(ref, { fresh: false });
            await service.compare(ref, 1, 2, 3);
        };

        it('reopening within the refresh interval reads nothing from Bitbucket', async () => {
            await service.detail(ref);
            await service.compare(ref, 1, 2, 3);
            const before = fake.requests.length;
            clock += 299_000;
            await open();
            expect(fake.requests.length - before).toBe(0);
        });

        it('reopening after the interval reads Bitbucket again', async () => {
            await service.detail(ref);
            await service.compare(ref, 1, 2, 3);
            const before = fake.requests.length;
            clock += 300_001;
            await open();
            expect(fake.requests.length - before).toBeGreaterThan(0);
            expect(reads().pr).toBe(2);
        });

        it('a write makes the next open read Bitbucket', async () => {
            await service.detail(ref);
            await service.compare(ref, 1, 2, 3);
            await service.createComment(ref, { raw: 'hello' });
            await open();
            expect(reads().pr).toBe(2);
        });

        it('memoizes a comparison until the load is replaced', async () => {
            await service.detail(ref);
            const first = await service.compare(ref, 1, 2, 3);
            expect(await service.compare(ref, 1, 2, 3)).toBe(first);
            expect(await service.compare(ref, 1, 2, 4)).not.toBe(first);
            await service.detail(ref);
            expect(await service.compare(ref, 1, 2, 3)).not.toBe(first);
        });

        it('a reopen shows the files marked as seen', async () => {
            await service.detail(ref);
            service.markViewed(ref, { path: 'src/mine.ts', contentHash: 'abc', viewed: true });
            expect((await service.detail(ref, { fresh: false })).review.viewed).toEqual({ 'src/mine.ts': 'abc' });
            expect(reads().pr).toBe(1);
        });

        it('a reopen shows the new reviewed mark', async () => {
            await service.detail(ref);
            await service.markReviewed(ref, 1);
            expect((await service.detail(ref, { fresh: false })).review.lastReviewed).toBe(1);
        });

        it('freshness carries the configured interval and the load time', async () => {
            const first = await service.detail(ref);
            expect(first.freshness).toEqual({ loadedAt: new Date(clock).toISOString(), refreshMinutes: 5 });
            clock += 60_000;
            const again = await service.detail(ref, { fresh: false });
            expect(again.freshness.loadedAt).toBe(first.freshness.loadedAt);
        });

        it('follows a changed interval at once', async () => {
            await service.detail(ref);
            await store.saveConfig({ review: { ...store.config.review, refreshMinutes: 1 } });
            clock += 61_000;
            const detail = await service.detail(ref, { fresh: false });
            expect(detail.freshness.refreshMinutes).toBe(1);
            expect(reads().pr).toBe(2);
        });
    });
});
