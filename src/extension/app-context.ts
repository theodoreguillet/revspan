// Extension-side assembly: the same services and the same HTTP application as the local server,
// with the token in VS Code's secure storage, the tracked repositories and the review settings in the revspan.* settings
// and the other data in the extension's global storage.
import path from 'node:path';
import * as vscode from 'vscode';
import type { Hono } from 'hono';
import type { SecretStore } from '../server/infra/secrets.ts';
import { DEFAULT_BASE_URL } from '../server/bitbucket/client.ts';
import { createHttpApp } from '../server/http/app.ts';
import { Cache } from '../server/infra/cache.ts';
import { Store, type RepoSource, type ReviewSource } from '../server/infra/config.ts';
import { createServices, type Services } from '../server/services/index.ts';
import { AppError } from '../server/errors.ts';
import { IN_MEMORY_HOST } from './lib/bridge.ts';
import { isUnregisteredSetting, settingTarget } from './lib/setting-target.ts';

export interface ExtensionApp {
    services: Services;
    http: Hono;
    /** Shared local state (the notifier records there what was already notified). */
    store: Store;
}

/** VS Code setting for the tracked repositories: visible in Settings, synced by Settings Sync, per profile. */
export const REPOS_SETTING = { section: 'revspan', key: 'repositories', id: 'revspan.repositories' } as const;

const TOKEN_KEY_PREFIX = 'revspan.bitbucket-token:';

/**
 * Writes a revspan.* setting at the level that gives the effective value (otherwise a .vscode/settings.json would mask the
 * save). A setting VS Code does not know yet (extension updated, window not reloaded) gives SETTING_UNREGISTERED, which
 * the page turns into "reload the window" instead of an internal error.
 */
async function writeSetting(key: string, value: unknown): Promise<void> {
    const config = vscode.workspace.getConfiguration(REPOS_SETTING.section);
    const inspection = config.inspect(key);
    const target = settingTarget(inspection, vscode.workspace.isTrusted) === 'workspace'
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    try {
        await config.update(key, value, target);
    } catch (error) {
        if (isUnregisteredSetting(error, inspection)) {
            const setting = `${REPOS_SETTING.section}.${key}`;
            throw new AppError(409, 'SETTING_UNREGISTERED', `Revspan was just updated: reload the VS Code window (Developer: Reload Window) to save settings (${setting} is not registered yet).`, { setting });
        }
        throw error;
    }
}

function vscodeRepoSource(): RepoSource {
    const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration(REPOS_SETTING.section);
    return {
        get() {
            const value = config().get<unknown>(REPOS_SETTING.key);
            return Array.isArray(value) ? value.filter((repo): repo is string => typeof repo === 'string') : [];
        },
        set: (repos) => writeSetting(REPOS_SETTING.key, repos),
    };
}

/** VS Code settings behind each field of the review settings (keys under "revspan."). */
export const REVIEW_SETTING_KEYS = {
    requiredApprovals: 'review.requiredApprovals',
    requiredApprovalsByRepo: 'review.requiredApprovalsByRepository',
    followed: 'review.followedContributors',
    hideUnfollowed: 'review.hideUnfollowed',
    newPullRequest: 'notifications.newPullRequest',
    newVersion: 'notifications.newVersion',
    buildFailed: 'notifications.buildFailed',
    refreshMinutes: 'refreshIntervalMinutes',
} as const;

/** Review queue, notification and refresh settings kept in the VS Code settings (the Store normalizes what is read). */
export function vscodeReviewSource(): ReviewSource {
    const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration(REPOS_SETTING.section);
    const read = (key: string): unknown => config().get<unknown>(key);
    const keys = REVIEW_SETTING_KEYS;
    return {
        get() {
            return {
                requiredApprovals: read(keys.requiredApprovals),
                requiredApprovalsByRepo: read(keys.requiredApprovalsByRepo),
                followed: read(keys.followed),
                hideUnfollowed: read(keys.hideUnfollowed),
                notifications: { newPullRequest: read(keys.newPullRequest), newVersion: read(keys.newVersion), buildFailed: read(keys.buildFailed) },
                refreshMinutes: read(keys.refreshMinutes),
            };
        },
        async set(review) {
            const values: [string, unknown][] = [
                [keys.requiredApprovals, review.requiredApprovals],
                [keys.requiredApprovalsByRepo, review.requiredApprovalsByRepo],
                [keys.followed, review.followed],
                [keys.hideUnfollowed, review.hideUnfollowed],
                [keys.newPullRequest, review.notifications.newPullRequest],
                [keys.newVersion, review.notifications.newVersion],
                [keys.buildFailed, review.notifications.buildFailed],
                [keys.refreshMinutes, review.refreshMinutes],
            ];
            for (const [key, value] of values) {
                // Only what changed: an untouched setting stays absent from the user's settings.json.
                if (JSON.stringify(read(key)) !== JSON.stringify(value)) {
                    await writeSetting(key, value);
                }
            }
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

/** In development or test only: Bitbucket API and test token provided by the environment (fake Bitbucket). */
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
    const store = new Store(dir, { repoSource: vscodeRepoSource(), reviewSource: vscodeReviewSource() });
    const cache = new Cache(path.join(dir, 'cache'));
    const overrides = testOverrides(context.extensionMode);
    const services = createServices({ store, secrets: vscodeSecretStore(context.secrets), cache, baseUrl: overrides.baseUrl ?? DEFAULT_BASE_URL });
    if (overrides.email && overrides.token) {
        await services.settings.update({ email: overrides.email, token: overrides.token, ...(overrides.repos ? { repos: overrides.repos } : {}) });
    }
    const version = String((context.extension.packageJSON as { version?: string }).version ?? '0.0.0');
    const http = createHttpApp({ version, settings: services.settings, home: services.home, prs: services.prs, allowedHosts: () => [IN_MEMORY_HOST] });
    return { services, http, store };
}
