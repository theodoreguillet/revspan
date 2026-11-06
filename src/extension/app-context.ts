// Assemblage côté extension : les mêmes services et la même application HTTP que le serveur local,
// avec le jeton dans le stockage sécurisé de VS Code et les données dans le stockage global de l'extension.
import path from 'node:path';
import * as vscode from 'vscode';
import type { Hono } from 'hono';
import type { SecretStore } from '../server/infra/secrets.ts';
import { DEFAULT_BASE_URL } from '../server/bitbucket/client.ts';
import { createHttpApp } from '../server/http/app.ts';
import { Cache } from '../server/infra/cache.ts';
import { Store } from '../server/infra/config.ts';
import { createServices, type Services } from '../server/services/index.ts';
import { IN_MEMORY_HOST } from './lib/bridge.ts';

export interface ExtensionApp {
    services: Services;
    http: Hono;
}

const TOKEN_KEY_PREFIX = 'strata.bitbucket-token:';

function vscodeSecretStore(secrets: vscode.SecretStorage): SecretStore {
    const key = (account: string): string => `${TOKEN_KEY_PREFIX}${account}`;
    return {
        kind: 'vscode',
        async get(account) {
            return account ? (await secrets.get(key(account))) ?? null : null;
        },
        async set(account, token) {
            await secrets.store(key(account), token);
        },
        async remove(account) {
            if (account) {
                await secrets.delete(key(account));
            }
        },
    };
}

/** En développement ou en test seulement : API Bitbucket et jeton de test fournis par l'environnement (faux Bitbucket). */
function testOverrides(mode: vscode.ExtensionMode): { baseUrl?: string; email?: string; token?: string; repos?: string[] } {
    if (mode === vscode.ExtensionMode.Production) {
        return {};
    }
    const env = process.env;
    return {
        baseUrl: env.STRATA_BITBUCKET_API || undefined,
        email: env.STRATA_TEST_EMAIL || undefined,
        token: env.STRATA_TEST_TOKEN || undefined,
        repos: env.STRATA_TEST_REPOS ? env.STRATA_TEST_REPOS.split(',') : undefined,
    };
}

export async function createExtensionApp(context: vscode.ExtensionContext): Promise<ExtensionApp> {
    const dir = context.globalStorageUri.fsPath;
    const store = new Store(dir);
    const cache = new Cache(path.join(dir, 'cache'));
    const overrides = testOverrides(context.extensionMode);
    const services = createServices({ store, secrets: vscodeSecretStore(context.secrets), cache, baseUrl: overrides.baseUrl ?? DEFAULT_BASE_URL });
    if (overrides.email && overrides.token) {
        await services.settings.update({ email: overrides.email, token: overrides.token, ...(overrides.repos ? { repos: overrides.repos } : {}) });
    }
    const version = String((context.extension.packageJSON as { version?: string }).version ?? '0.0.0');
    const http = createHttpApp({ version, settings: services.settings, home: services.home, prs: services.prs, allowedHosts: () => [IN_MEMORY_HOST] });
    return { services, http };
}
