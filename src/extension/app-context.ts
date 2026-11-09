// Assemblage côté extension : les mêmes services et la même application HTTP que le serveur local,
// avec le jeton dans le stockage sécurisé de VS Code, les dépôts suivis dans le réglage revspan.repositories
// et les autres données dans le stockage global de l'extension.
import path from 'node:path';
import * as vscode from 'vscode';
import type { Hono } from 'hono';
import type { SecretStore } from '../server/infra/secrets.ts';
import { DEFAULT_BASE_URL } from '../server/bitbucket/client.ts';
import { createHttpApp } from '../server/http/app.ts';
import { Cache } from '../server/infra/cache.ts';
import { Store, type RepoSource } from '../server/infra/config.ts';
import { createServices, type Services } from '../server/services/index.ts';
import { IN_MEMORY_HOST } from './lib/bridge.ts';
import { settingTarget } from './lib/setting-target.ts';

export interface ExtensionApp {
    services: Services;
    http: Hono;
}

/** Réglage VS Code des dépôts suivis : visible dans les Réglages, synchronisé par Settings Sync, propre au profil. */
export const REPOS_SETTING = { section: 'revspan', key: 'repositories', id: 'revspan.repositories' } as const;

const TOKEN_KEY_PREFIX = 'revspan.bitbucket-token:';

function vscodeRepoSource(): RepoSource {
    const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration(REPOS_SETTING.section);
    return {
        get() {
            const value = config().get<unknown>(REPOS_SETTING.key);
            return Array.isArray(value) ? value.filter((repo): repo is string => typeof repo === 'string') : [];
        },
        async set(repos) {
            // Écrit au niveau qui donne la valeur effective (sinon un .vscode/settings.json masquerait l'enregistrement).
            const target = settingTarget(config().inspect(REPOS_SETTING.key), vscode.workspace.isTrusted) === 'workspace'
                ? vscode.ConfigurationTarget.Workspace
                : vscode.ConfigurationTarget.Global;
            await config().update(REPOS_SETTING.key, repos, target);
        },
    };
}

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
        baseUrl: env.REVSPAN_BITBUCKET_API || undefined,
        email: env.REVSPAN_TEST_EMAIL || undefined,
        token: env.REVSPAN_TEST_TOKEN || undefined,
        repos: env.REVSPAN_TEST_REPOS ? env.REVSPAN_TEST_REPOS.split(',') : undefined,
    };
}

export async function createExtensionApp(context: vscode.ExtensionContext): Promise<ExtensionApp> {
    const dir = context.globalStorageUri.fsPath;
    const store = new Store(dir, { repoSource: vscodeRepoSource() });
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
