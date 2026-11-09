// Entry point: starts Revspan and opens the browser.
// Usage: revspan [Bitbucket PR URL] [--port 7420] [--no-open]
import { spawn } from 'node:child_process';
import { parsePrUrl } from '../shared/pr-url.ts';
import { startApp } from './app.ts';

interface CliArgs {
    port: number;
    open: boolean;
    url: string | null;
    help: boolean;
}

const USAGE = 'Usage: revspan [Bitbucket PR URL] [--port 7420] [--no-open]';

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

function openBrowser(url: string): void {
    const [cmd, cmdArgs]: [string, string[]] = process.platform === 'darwin' ? ['open', [url]]
        : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
            : ['xdg-open', [url]];
    const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true });
    child.on('error', () => console.log(`Open ${url} in your browser.`));
    child.unref();
}

async function alreadyRunning(port: number): Promise<boolean> {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
        return ((await response.json()) as { app?: string }).app === 'revspan';
    } catch {
        return false;
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
    const hash = ref ? `#/pr/${ref.workspace}/${ref.repo}/${ref.id}` : '';

    if (args.port !== 0 && await alreadyRunning(args.port)) {
        const url = `http://127.0.0.1:${args.port}/${hash}`;
        console.log(`Revspan is already running: ${url}`);
        if (args.open) {
            openBrowser(url);
        }
        return;
    }

    const app = await startApp({ port: args.port });
    const url = `${app.url}/${hash}`;
    console.log(`Revspan: ${url}`);
    console.log(`Configuration: ${app.dir}  --  Ctrl+C to stop.`);
    if (args.open) {
        openBrowser(url);
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
