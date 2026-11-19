// Entry point: starts Revspan and opens the browser on its per-run secret address (/open?k=…).
// Usage: revspan [Bitbucket PR URL] [--port 7420] [--no-open]
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parsePrUrl } from '../shared/pr-url.ts';
import { launchPlan } from './browser-command.ts';
import { startApp } from './app.ts';
import { newSecret, openUrlOf, portFallbackWarning } from './http/cli-secret.ts';
import { configDir } from './infra/config.ts';
import { removeRunFile, runningInstance, writeRunFile } from './infra/run-file.ts';

interface CliArgs {
    port: number;
    open: boolean;
    url: string | null;
    help: boolean;
}

const USAGE = 'Usage: revspan [Bitbucket PR URL] [--port 7420] [--no-open]';
// Time the browser gets to read the Linux redirect page before it is deleted (it is also deleted at exit).
const LAUNCH_FILE_MS = 10_000;

function parseArgs(argv: readonly string[]): CliArgs {
    const args: CliArgs = { port: 7420, open: true, url: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i] ?? '';
        if (arg === '--port') {
            args.port = Number(argv[++i]);
        } else if (arg.startsWith('--port=')) {
            args.port = Number(arg.slice('--port='.length));
        } else if (arg === '--no-open') {
            args.open = false;
        } else if (arg === '-h' || arg === '--help') {
            args.help = true;
        } else {
            args.url = arg;
        }
    }
    return args;
}

/** Opens the ?k= address without putting the secret in a process argument (browser-command.ts); `dir`: 0700 config folder. */
function openBrowser(url: string, dir: string): void {
    const fallback = (): void => console.log(`Open ${url} in your browser.`);
    const plan = launchPlan(process.platform, url, path.join(dir, `open-${randomBytes(8).toString('hex')}.html`));
    if (!plan) {
        fallback();
        return;
    }
    try {
        if (plan.file) {
            const file = plan.file.path;
            fs.writeFileSync(file, plan.file.content, { mode: 0o600, flag: 'wx' });
            const remove = (): void => fs.rmSync(file, { force: true });
            // Not unref'd: a second `revspan` waits for it before exiting, so the browser can still read the page.
            setTimeout(remove, LAUNCH_FILE_MS);
            process.on('exit', remove);
        }
        const child = spawn(plan.command, plan.args, { stdio: [plan.stdin === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'], detached: true });
        child.on('error', fallback);
        // osascript and xdg-open report a failure by their exit code; explorer.exe exits with 1 even when it worked.
        child.on('exit', (code) => {
            if (code && process.platform !== 'win32') {
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

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(USAGE);
        return;
    }
    if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
        throw new Error(`Invalid port. ${USAGE}`);
    }
    const ref = args.url ? parsePrUrl(args.url) : null;
    if (args.url && !ref) {
        throw new Error(`Unrecognized Bitbucket PR URL: ${args.url}`);
    }
    const hash = ref ? `#/pr/${encodeURIComponent(ref.workspace)}/${encodeURIComponent(ref.repo)}/${ref.id}` : '';

    // An instance already running for this configuration (run.json, checked with its secret): open it instead.
    // --port 0 (a random port, for scripts) neither looks for one nor records itself.
    const dir = configDir();
    const running = args.port === 0 ? null : await runningInstance(dir);
    if (running) {
        const existing = openUrlOf(`http://127.0.0.1:${running.port}`, running.secret, hash);
        console.log(`Revspan is already running: ${existing}`);
        if (args.open) {
            openBrowser(existing, dir);
        }
        return;
    }

    const secret = newSecret();
    const app = await startApp({ port: args.port, secret });
    if (args.port !== 0) {
        writeRunFile(app.dir, { port: app.port, secret, pid: process.pid });
        process.on('exit', () => removeRunFile(app.dir));
    }
    const warning = portFallbackWarning(args.port, app.port);
    if (warning) {
        console.warn(`\n${warning}\n`);
    }
    // Printed with --no-open too: reopening it gives the cookie back (lost cookie, other browser).
    const url = app.openUrl(hash);
    console.log(`Revspan: ${url}`);
    console.log(`Configuration: ${app.dir}  --  Ctrl+C to stop.`);
    if (args.open) {
        openBrowser(url, app.dir);
    }
    const stop = (): void => {
        void app.close().then(() => process.exit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}

main().catch((error: Error) => {
    console.error(error.message);
    process.exit(2);
});
