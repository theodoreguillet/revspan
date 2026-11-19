// Service composition (used by the local server and by the VS Code extension).
import { DEFAULT_BASE_URL, type PrListLimit } from '../bitbucket/client.ts';
import type { Cache } from '../infra/cache.ts';
import type { Store } from '../infra/config.ts';
import type { SecretStore } from '../infra/secrets.ts';
import { HomeService, type HomeLoad } from './home-service.ts';
import { PrService } from './pr-service.ts';
import { BitbucketSession } from './session.ts';
import { SettingsService } from './settings-service.ts';

export interface Services {
    session: BitbucketSession;
    settings: SettingsService;
    home: HomeService;
    prs: PrService;
}

/**
 * prListLimit: lowered by the tests only (a repository with more open PRs than the list reads). onHomeLoad: told of
 * every home load (the VS Code extension logs them).
 */
export function createServices({ store, secrets, cache, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch, prListLimit, onHomeLoad }: {
    store: Store;
    secrets: SecretStore;
    cache: Cache;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    prListLimit?: PrListLimit;
    onHomeLoad?: (load: HomeLoad) => void;
}): Services {
    const session = new BitbucketSession({ store, secrets, cache, baseUrl, fetchImpl, prListLimit });
    return {
        session,
        settings: new SettingsService({ session, store, secrets }),
        home: new HomeService({ session, store, cache, onLoad: onHomeLoad }),
        prs: new PrService({ session, store, cache }),
    };
}
