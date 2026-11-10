import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BitbucketClient } from '../../src/server/bitbucket/client.ts';
import { Cache } from '../../src/server/infra/cache.ts';
import { summarizeBuild } from '../../src/server/core/build.ts';
import { FAKE_EMAIL, FAKE_PRS, FAKE_TOKEN, REPO, WS, startFakeBitbucket, type FakeBitbucket } from '../support/fake-bitbucket.ts';

describe('fake Bitbucket: build statuses and branch heads', () => {
    let fake: FakeBitbucket;
    let client: BitbucketClient;
    beforeAll(async () => {
        fake = await startFakeBitbucket();
        client = new BitbucketClient({ baseUrl: fake.url, auth: { email: FAKE_EMAIL, token: FAKE_TOKEN }, cache: new Cache(null) });
    });
    afterAll(() => fake.close());

    const buildOf = async (id: number) => {
        const pr = await client.pullRequest(WS, REPO, id);
        return summarizeBuild(await client.headChecks(WS, REPO, id, pr.source?.commit?.hash ?? ''));
    };

    it('serves one failed, one running and one PR without status', async () => {
        expect((await buildOf(FAKE_PRS.main)).state).toBe('failed');
        expect((await buildOf(FAKE_PRS.mine)).state).toBe('running');
        expect((await buildOf(FAKE_PRS.neverReviewed)).state).toBe('none');
    });

    it('serves the statuses of one commit on the commit route, whichever PR they were attached to', async () => {
        const head = (await client.pullRequest(WS, REPO, FAKE_PRS.main)).source?.commit?.hash ?? '';
        const response = await fetch(`${fake.url}/repositories/${WS}/${REPO}/commit/${head}/statuses`, {
            headers: { Authorization: `Basic ${Buffer.from(`${FAKE_EMAIL}:${FAKE_TOKEN}`).toString('base64')}` },
        });
        const body = await response.json() as { values: { key: string; commit: { hash: string } }[] };
        expect(body.values.map((s) => s.key).sort()).toEqual(['pipeline', 'scan']);
        expect(body.values.every((s) => s.commit.hash.startsWith(head))).toBe(true);
    });

    it('has a master that moved past the base of a PR but not of another', async () => {
        const head = await client.branchHead(WS, REPO, 'master');
        const base = async (id: number) => (await client.pullRequest(WS, REPO, id)).destination?.commit?.hash ?? '';
        expect(head?.startsWith(await base(FAKE_PRS.rebaseOnly))).toBe(true);
        expect(head?.startsWith(await base(FAKE_PRS.mine))).toBe(false);
        await expect(client.branchHead(WS, REPO, 'nope')).resolves.toBeNull();
    });
});
