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
let service: PrService;

beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revspan-prcache-'));
    fake = await startFakeBitbucket();
    const store = new Store(dir);
    await store.saveConfig({ email: FAKE_EMAIL, repos: [`${WS}/${REPO}`] });
    const secrets = { kind: 'file', get: async () => FAKE_TOKEN, set: async () => undefined, remove: async () => undefined } as unknown as SecretStore;
    const cache = new Cache(null);
    const session = new BitbucketSession({ store, secrets, cache, baseUrl: fake.url });
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

    it('reloads after five minutes', async () => {
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
});
