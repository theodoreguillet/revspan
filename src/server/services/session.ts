// Bitbucket session: client built from the e-mail (config) and the token (secure storage),
// profile of the token's user kept in memory.
import type { User } from '../../shared/api.ts';
import { BitbucketClient, DEFAULT_BASE_URL } from '../bitbucket/client.ts';
import { AppError } from '../errors.ts';
import type { Cache } from '../infra/cache.ts';
import type { Store } from '../infra/config.ts';
import type { SecretStore } from '../infra/secrets.ts';

interface Connection {
    email: string;
    client: BitbucketClient;
    profile?: User | null;
}

export class BitbucketSession {
    private readonly store: Store;
    private readonly secrets: SecretStore;
    private readonly cache: Cache;
    private readonly baseUrl: string;
    private readonly fetchImpl: typeof fetch;
    private connection: Connection | null = null;

    constructor({ store, secrets, cache, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch }: {
        store: Store;
        secrets: SecretStore;
        cache: Cache;
        baseUrl?: string;
        fetchImpl?: typeof fetch;
    }) {
        this.store = store;
        this.secrets = secrets;
        this.cache = cache;
        this.baseUrl = baseUrl;
        this.fetchImpl = fetchImpl;
    }

    async hasToken(): Promise<boolean> {
        const { email } = this.store.config;
        return Boolean(email && await this.secrets.get(email));
    }

    async getClient(): Promise<BitbucketClient> {
        return (await this.connect()).client;
    }

    /** Profile of the token's user; null if the read:user:bitbucket scope is missing. */
    async me(): Promise<User | null> {
        const connection = await this.connect();
        if (connection.profile === undefined) {
            try {
                connection.profile = await connection.client.me();
            } catch (error) {
                if (!(error instanceof AppError) || error.code !== 'BB_FORBIDDEN') {
                    throw error;
                }
                connection.profile = null;
            }
        }
        return connection.profile;
    }

    /** Account or token change: no data left from the old one. */
    reset(): void {
        this.connection = null;
        this.cache.invalidateLive('live:');
    }

    /** The token is read once (on macOS, one `security` subprocess per read) then kept until reset(). */
    private async connect(): Promise<Connection> {
        const { email } = this.store.config;
        if (this.connection && this.connection.email === email) {
            return this.connection;
        }
        const token = email ? await this.secrets.get(email) : null;
        if (!email || !token) {
            throw new AppError(409, 'NO_TOKEN', 'No Bitbucket token is configured. Open the settings to add one.');
        }
        this.connection = {
            email,
            client: new BitbucketClient({ baseUrl: this.baseUrl, auth: { email, token }, cache: this.cache, fetchImpl: this.fetchImpl }),
        };
        return this.connection;
    }
}
