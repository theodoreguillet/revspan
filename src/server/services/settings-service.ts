// Réglages : e-mail Atlassian, jeton (stockage sécurisé), dépôts de l'accueil.
import type { ConnectionTest, Settings, SettingsUpdate } from '../../shared/api.ts';
import { AppError, badRequest } from '../errors.ts';
import { normalizeRepos, type Store } from '../infra/config.ts';
import type { SecretStore } from '../infra/secrets.ts';
import type { BitbucketSession } from './session.ts';

const EMAIL_PATTERN = /^[^\s@"\\]+@[^\s@"\\]+$/;

export class SettingsService {
    private readonly session: BitbucketSession;
    private readonly store: Store;
    private readonly secrets: SecretStore;

    constructor({ session, store, secrets }: { session: BitbucketSession; store: Store; secrets: SecretStore }) {
        this.session = session;
        this.store = store;
        this.secrets = secrets;
    }

    async get(): Promise<Settings> {
        const hasToken = await this.session.hasToken();
        const me = hasToken ? await this.session.me().catch(() => null) : null;
        return { email: this.store.config.email, hasToken, tokenStore: this.secrets.kind, repos: [...this.store.config.repos], me };
    }

    async update(patch: SettingsUpdate): Promise<Settings> {
        const { store, secrets } = this;
        const previousEmail = store.config.email;
        const next: { email?: string; repos?: string[] } = {};

        if (patch.email !== undefined) {
            const email = patch.email.trim();
            if (email && !EMAIL_PATTERN.test(email)) {
                throw badRequest('Invalid email address.', { reason: 'invalid-email' });
            }
            if (email !== previousEmail) {
                // Le jeton suit l'e-mail (il est rangé sous ce compte).
                const previousToken = previousEmail ? await secrets.get(previousEmail) : null;
                if (previousToken && email && patch.token === undefined) {
                    await secrets.set(email, previousToken);
                }
                if (previousEmail) {
                    await secrets.remove(previousEmail);
                }
            }
            next.email = email;
        }
        if (patch.repos !== undefined) {
            next.repos = normalizeRepos(patch.repos);
        }
        await store.saveConfig(next);

        if (patch.token !== undefined) {
            const { email } = store.config;
            const token = patch.token.trim();
            if (token) {
                if (!email) {
                    throw badRequest('Enter the Atlassian account email first.', { reason: 'email-required' });
                }
                await secrets.set(email, token).catch((error: Error) => {
                    throw badRequest(error.message);
                });
            } else if (email) {
                await secrets.remove(email);
            }
        }
        this.session.reset();
        return this.get();
    }

    async test(): Promise<ConnectionTest> {
        this.session.reset();
        try {
            const me = await this.session.me();
            if (!me) {
                return {
                    ok: false,
                    error: {
                        code: 'BB_FORBIDDEN',
                        message: 'Connected, but the profile cannot be read: add the read:user:bitbucket scope to the token.',
                        params: { reason: 'profile-unreadable' },
                    },
                };
            }
            return { ok: true, me };
        } catch (error) {
            if (error instanceof AppError) {
                return { ok: false, error: error.toPayload() };
            }
            throw error;
        }
    }
}
