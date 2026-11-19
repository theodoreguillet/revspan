// Prints the CLI's ?k= address and opens it in the browser following launchPlan (browser-command.ts): the secret never
// goes into a process argument (except on Windows), and a failure only ever prints how to open the address by hand.
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REDIRECT_PAGE_HINT, launchPlan, type LaunchPlan } from './browser-command.ts';
import { isPrivateFolder } from './infra/ownership.ts';

export interface OpenDeps {
    platform: NodeJS.Platform;
    spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
    log: (line: string) => void;
    /** Registers a cleanup to run when the process exits. */
    onExit: (cleanup: () => void) => void;
    /** Current user (null on Windows): the redirect page is only written in a folder private to it. */
    uid: number | null;
    /** Time the browser gets to read the redirect page before it is deleted (it is also deleted at exit). */
    fileMs: number;
}

const defaults = (): OpenDeps => ({
    platform: process.platform,
    spawn: nodeSpawn,
    log: (line) => console.log(line),
    onExit: (cleanup) => process.on('exit', cleanup),
    uid: process.getuid?.() ?? null,
    fileMs: 10_000,
});

/** Writes the redirect page (0600, new file only) and schedules its removal; false if it could not be written. */
function writeRedirectPage({ path: file, content }: NonNullable<LaunchPlan['file']>, deps: OpenDeps): boolean {
    try {
        fs.writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
    } catch {
        return false;
    }
    const remove = (): void => {
        try {
            fs.rmSync(file, { force: true });
        } catch {
            // Best effort (EACCES, EPERM…): never a reason to stop the running server.
        }
    };
    // Not unref'd: a second `revspan` waits for it before exiting, so the browser can still read the page.
    setTimeout(remove, deps.fileMs);
    deps.onExit(remove);
    return true;
}

function launch(plan: LaunchPlan | null, url: string, deps: OpenDeps): void {
    let told = false;
    const fallback = (): void => {
        if (!told) {
            told = true;
            deps.log(`Open ${url} in your browser.`);
        }
    };
    if (!plan) {
        fallback();
        return;
    }
    try {
        const child = deps.spawn(plan.command, plan.args, { stdio: [plan.stdin === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'], detached: true });
        child.on('error', fallback);
        // osascript and xdg-open report a failure by their exit code; explorer.exe exits with 1 even when it worked.
        child.on('exit', (code) => {
            if (code && deps.platform !== 'win32') {
                fallback();
            }
        });
        if (plan.stdin !== undefined) {
            child.stdin?.on('error', fallback);
            child.stdin?.end(plan.stdin);
        }
        child.unref();
    } catch {
        fallback();
    }
}

/**
 * Prints `${label}${url}` and, when `open`, opens the browser on it. `dir`: configuration folder, where the Linux
 * redirect page is written only if it is private to the user (otherwise the address is just printed).
 */
export function showAndOpen(label: string, url: string, dir: string, open: boolean, overrides: Partial<OpenDeps> = {}): void {
    const deps = { ...defaults(), ...overrides };
    deps.log(`${label}${url}`);
    if (!open) {
        return;
    }
    const tempFile = isPrivateFolder(dir, deps.uid) ? path.join(dir, `open-${randomBytes(8).toString('hex')}.html`) : null;
    let plan = launchPlan(deps.platform, url, tempFile);
    if (plan?.file) {
        if (writeRedirectPage(plan.file, deps)) {
            deps.log(REDIRECT_PAGE_HINT);
        } else {
            plan = null;
        }
    }
    launch(plan, url, deps);
}
