// run.json in the configuration folder: port, secret and process of the running CLI instance (mode 0600, written at
// start, removed at exit). A second `revspan` reads it to open the running instance instead of starting another one.
import fs from 'node:fs';
import path from 'node:path';
import { SECRET_COOKIE } from '../http/cli-secret.ts';
import { writeJsonAtomic } from './config.ts';

export interface RunInfo {
    port: number;
    secret: string;
    pid: number;
}

const RUN_FILE = 'run.json';
// Local route protected by the secret, with no Bitbucket call and no token needed (unlike /api/home, which can take
// seconds or answer 409 before the first token): a fast, reliable "this instance knows the secret" check.
const PROBE_ROUTE = '/api/settings/followed';
const PROBE_TIMEOUT_MS = 1000;

const runFile = (dir: string): string => path.join(dir, RUN_FILE);
const isInteger = (value: unknown, min: number, max: number): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

export function writeRunFile(dir: string, info: RunInfo): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(runFile(dir), { port: info.port, secret: info.secret, pid: info.pid });
}

/** null when the file is missing, unreadable or not a run file. */
export function readRunFile(dir: string): RunInfo | null {
    try {
        const raw = JSON.parse(fs.readFileSync(runFile(dir), 'utf8')) as Partial<Record<keyof RunInfo, unknown>> | null;
        const { port, secret, pid } = raw ?? {};
        if (!isInteger(port, 1, 65535) || typeof secret !== 'string' || !secret || !isInteger(pid, 1, Number.MAX_SAFE_INTEGER)) {
            return null;
        }
        return { port, secret, pid };
    } catch {
        return null;
    }
}

/** Removes run.json if it names `pid` (best effort): the file of an instance started since then stays. */
export function removeRunFile(dir: string, pid: number = process.pid): void {
    try {
        if (readRunFile(dir)?.pid === pid) {
            fs.rmSync(runFile(dir), { force: true });
        }
    } catch {
        // Best effort: a leftover file is detected as dead by the next start.
    }
}

/** The process exists and belongs to this user (EPERM: another user's process, so not one of our instances). */
function isOwnProcess(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * The instance named by run.json, if it is still running: its process is alive and it answers a protected route with
 * the stored secret. Otherwise null (no file, garbage, dead process, port closed or held by something else).
 */
export async function runningInstance(dir: string, fetchImpl: typeof fetch = fetch): Promise<RunInfo | null> {
    const run = readRunFile(dir);
    if (!run || !isOwnProcess(run.pid)) {
        return null;
    }
    try {
        const response = await fetchImpl(`http://127.0.0.1:${run.port}${PROBE_ROUTE}`, {
            headers: { Cookie: `${SECRET_COOKIE}=${run.secret}` },
            redirect: 'manual',
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        const body = (await response.json()) as { followed?: unknown } | null;
        return response.status === 200 && Array.isArray(body?.followed) ? run : null;
    } catch {
        return null;
    }
}
