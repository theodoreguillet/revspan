import { describe, expect, it, vi } from 'vitest';
import { Cache } from '../../src/server/infra/cache.ts';
import type { Store } from '../../src/server/infra/config.ts';
import type { SecretStore } from '../../src/server/infra/secrets.ts';
import { BitbucketSession } from '../../src/server/services/session.ts';

describe('BitbucketSession', () => {
    it('reads the token only once until reset()', async () => {
        const get = vi.fn(async () => 'tok-123456');
        const secrets = { kind: 'file', get, set: vi.fn(), remove: vi.fn() } as unknown as SecretStore;
        const store = { config: { email: 'a@acme.test', repos: [] } } as unknown as Store;
        const session = new BitbucketSession({ store, secrets, cache: new Cache(null) });
        const first = await session.getClient();
        expect(await session.getClient()).toBe(first);
        expect(get).toHaveBeenCalledTimes(1);
        session.reset();
        await session.getClient();
        expect(get).toHaveBeenCalledTimes(2);
    });
});
