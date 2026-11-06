// Stockage du jeton Bitbucket.
// macOS : trousseau (commande `security`, jeton transmis par stdin, jamais en argument).
// Linux : `secret-tool` (libsecret) s'il est installé.
// Sinon (ou STRATA_TOKEN_STORE=file) : fichier token.json en 0600 dans le dossier de config.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { TokenStoreKind } from '../../shared/api.ts';
import { writeJsonAtomic } from './config.ts';

export interface SecretStore {
    readonly kind: TokenStoreKind;
    get(account: string): Promise<string | null>;
    set(account: string, token: string): Promise<void>;
    remove(account: string): Promise<void>;
}

const DEFAULT_SERVICE = 'strata-bitbucket';
const LABEL = 'Strata (Bitbucket)';
const SAFE_VALUE = /^[^"\\\r\n]+$/;

interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}

function run(cmd: string, args: readonly string[], input: string | null = null): Promise<RunResult> {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on('error', (error) => resolve({ code: -1, stdout, stderr: error.message }));
        child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
        // Un outil qui se termine avant d'avoir lu stdin (EPIPE) ne doit pas faire tomber le serveur.
        child.stdin.on('error', () => undefined);
        if (input !== null) {
            child.stdin.write(input);
        }
        child.stdin.end();
    });
}

const commandExists = (cmd: string): Promise<boolean> => new Promise((resolve) => {
    execFile('which', [cmd], (error) => resolve(!error));
});

function assertSafe(value: string, what: string): void {
    if (!SAFE_VALUE.test(value)) {
        throw new Error(`${what} invalide (guillemets, antislash ou retour à la ligne interdits)`);
    }
}

const stripNewline = (text: string): string | null => text.replace(/\n$/, '') || null;

function keychainStore(service: string): SecretStore {
    return {
        kind: 'keychain',
        async get(account) {
            if (!account) {
                return null;
            }
            const { code, stdout } = await run('security', ['find-generic-password', '-a', account, '-s', service, '-w']);
            return code === 0 ? stripNewline(stdout) : null;
        },
        async set(account, token) {
            assertSafe(account, 'E-mail');
            assertSafe(token, 'Jeton');
            // Mode interactif : la commande (donc le jeton) passe par stdin, pas par la liste des processus.
            const { code, stderr } = await run('security', ['-i'],
                `add-generic-password -U -a "${account}" -s "${service}" -l "${LABEL}" -w "${token}"\n`);
            if (code !== 0 || /error/i.test(stderr)) {
                throw new Error(`Enregistrement dans le trousseau impossible : ${stderr.trim() || `code ${code}`}`);
            }
        },
        async remove(account) {
            if (account) {
                await run('security', ['delete-generic-password', '-a', account, '-s', service]);
            }
        },
    };
}

function secretToolStore(service: string): SecretStore {
    return {
        kind: 'secret-tool',
        async get(account) {
            if (!account) {
                return null;
            }
            const { code, stdout } = await run('secret-tool', ['lookup', 'service', service, 'account', account]);
            return code === 0 ? stripNewline(stdout) : null;
        },
        async set(account, token) {
            const { code, stderr } = await run('secret-tool', ['store', `--label=${LABEL}`, 'service', service, 'account', account], token);
            if (code !== 0) {
                throw new Error(`Enregistrement via secret-tool impossible : ${stderr.trim() || `code ${code}`}`);
            }
        },
        async remove(account) {
            if (account) {
                await run('secret-tool', ['clear', 'service', service, 'account', account]);
            }
        },
    };
}

function fileStore(dir: string): SecretStore {
    const file = path.join(dir, 'token.json');
    const read = (): Record<string, string> => {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
        } catch {
            return {};
        }
    };
    return {
        kind: 'file',
        async get(account) {
            return account ? read()[account] ?? null : null;
        },
        async set(account, token) {
            writeJsonAtomic(file, { ...read(), [account]: token });
            fs.chmodSync(file, 0o600);
        },
        async remove(account) {
            const data = read();
            delete data[account];
            writeJsonAtomic(file, data);
        },
    };
}

export async function createSecretStore({ dir, env = process.env, platform = process.platform }: {
    dir: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
}): Promise<SecretStore> {
    const service = env.STRATA_KEYCHAIN_SERVICE || DEFAULT_SERVICE;
    const forced = env.STRATA_TOKEN_STORE;
    if (forced === 'file') {
        return fileStore(dir);
    }
    if ((!forced || forced === 'keychain') && platform === 'darwin' && await commandExists('security')) {
        return keychainStore(service);
    }
    if ((!forced || forced === 'secret-tool') && platform === 'linux' && await commandExists('secret-tool')) {
        return secretToolStore(service);
    }
    return fileStore(dir);
}
