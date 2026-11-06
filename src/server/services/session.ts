// Session Bitbucket : client construit à partir de l'e-mail (config) et du jeton (stockage sécurisé),
// profil de l'utilisateur du jeton mis en mémoire.
import type { User } from '../../shared/api.ts';
import { BitbucketClient, DEFAULT_BASE_URL } from '../bitbucket/client.ts';
import { AppError } from '../errors.ts';
import type { Cache } from '../infra/cache.ts';
import type { Store } from '../infra/config.ts';
import type { SecretStore } from '../infra/secrets.ts';

interface Connection {
    /** Identifie l'e-mail et le jeton sans les garder en clair (longueur + fin du jeton). */
    key: string;
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

    /** Profil de l'utilisateur du jeton ; null si le droit read:user:bitbucket manque. */
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

    /** Changement de compte ou de jeton : plus aucune donnée de l'ancien. */
    reset(): void {
        this.connection = null;
        this.cache.invalidateLive('live:');
    }

    private async connect(): Promise<Connection> {
        const { email } = this.store.config;
        const token = email ? await this.secrets.get(email) : null;
        if (!email || !token) {
            throw new AppError(409, 'NO_TOKEN', 'Aucun jeton Bitbucket configuré. Ouvre les réglages pour en ajouter un.');
        }
        const key = `${email}:${token.length}:${token.slice(-6)}`;
        if (this.connection?.key !== key) {
            this.connection = {
                key,
                client: new BitbucketClient({ baseUrl: this.baseUrl, auth: { email, token }, cache: this.cache, fetchImpl: this.fetchImpl }),
            };
        }
        return this.connection;
    }
}
