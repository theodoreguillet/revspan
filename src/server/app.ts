// Assemblage : configuration, jeton, cache, services, application HTTP et serveur Node (127.0.0.1 uniquement).
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdaptorServer } from '@hono/node-server';
import { DEFAULT_BASE_URL } from './bitbucket/client.ts';
import { createHttpApp } from './http/app.ts';
import { Cache } from './infra/cache.ts';
import { configDir, Store } from './infra/config.ts';
import { createSecretStore } from './infra/secrets.ts';
import { createServices } from './services/index.ts';
import type { HomeService } from './services/home-service.ts';
import type { PrService } from './services/pr-service.ts';
import type { SettingsService } from './services/settings-service.ts';

const HOST = '127.0.0.1';
// Même chemin relatif depuis src/server (dev) et dist/server (construit) : <racine>/dist/web.
const DEFAULT_WEB_DIR = fileURLToPath(new URL('../../dist/web', import.meta.url));
const { version: APP_VERSION } = createRequire(import.meta.url)('../../package.json') as { version: string };

export interface StartOptions {
    env?: NodeJS.ProcessEnv;
    /** 0 = port libre au hasard. */
    port?: number;
    maxPortTries?: number;
    webDir?: string;
    fetchImpl?: typeof fetch;
}

export interface RunningApp {
    url: string;
    port: number;
    dir: string;
    store: Store;
    settings: SettingsService;
    prs: PrService;
    home: HomeService;
    close(): Promise<void>;
}

function listen(server: Server, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = (): void => {
            server.off('error', onError);
            const address = server.address();
            resolve(typeof address === 'object' && address ? address.port : port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, HOST);
    });
}

export async function startApp({ env = process.env, port = 7420, maxPortTries = 10, webDir = DEFAULT_WEB_DIR, fetchImpl = fetch }: StartOptions = {}): Promise<RunningApp> {
    const dir = configDir(env);
    const store = new Store(dir);
    const secrets = await createSecretStore({ dir, env });
    const cache = new Cache(path.join(dir, 'cache'));
    const { settings, home, prs } = createServices({ store, secrets, cache, baseUrl: env.REVSPAN_BITBUCKET_API ?? DEFAULT_BASE_URL, fetchImpl });

    let bound = 0;
    const http = createHttpApp({ version: APP_VERSION, settings, home, prs, webDir, allowedHosts: () => [`${HOST}:${bound}`, `localhost:${bound}`] });
    const server = createAdaptorServer({ fetch: http.fetch }) as Server;

    for (let attempt = 0; ; attempt++) {
        try {
            bound = await listen(server, port === 0 ? 0 : port + attempt);
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || port === 0 || attempt + 1 >= maxPortTries) {
                throw error;
            }
        }
    }

    return {
        url: `http://${HOST}:${bound}`,
        port: bound,
        dir,
        store,
        settings,
        prs,
        home,
        close: () => new Promise((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
        }),
    };
}
