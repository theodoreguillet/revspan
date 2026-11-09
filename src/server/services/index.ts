// Service composition (used by the local server and by the VS Code extension).
import { DEFAULT_BASE_URL } from '../bitbucket/client.ts';
import type { Cache } from '../infra/cache.ts';
import type { Store } from '../infra/config.ts';
import type { SecretStore } from '../infra/secrets.ts';
import { HomeService } from './home-service.ts';
import { PrService } from './pr-service.ts';
import { BitbucketSession } from './session.ts';
import { SettingsService } from './settings-service.ts';

export interface Services {
    session: BitbucketSession;
    settings: SettingsService;
    home: HomeService;
    prs: PrService;
}

export function createServices({ store, secrets, cache, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch }: {
    store: Store;
    secrets: SecretStore;
    cache: Cache;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
}): Services {
    const session = new BitbucketSession({ store, secrets, cache, baseUrl, fetchImpl });
    return {
        session,
        settings: new SettingsService({ session, store, secrets }),
        home: new HomeService({ session, store, cache }),
        prs: new PrService({ session, store, cache }),
    };
}
