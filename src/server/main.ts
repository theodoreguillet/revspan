// Entry point: starts Revspan and opens the browser on its per-run secret address (/open?k=…).
// Usage: revspan [Bitbucket PR URL] [--port 7420] [--no-open]
import { parsePrUrl } from '../shared/pr-url.ts';
import { startApp } from './app.ts';
import { newSecret, openUrlOf, portFallbackWarning } from './http/cli-secret.ts';
import { configDir } from './infra/config.ts';
import { removeRunFile, runningInstance, writeRunFile } from './infra/run-file.ts';
import { showAndOpen } from './open-browser.ts';

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
        showAndOpen('Revspan is already running: ', openUrlOf(`http://127.0.0.1:${running.port}`, running.secret, hash), dir, args.open);
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
    showAndOpen('Revspan: ', app.openUrl(hash), app.dir, args.open);
    console.log(`Configuration: ${app.dir}  --  Ctrl+C to stop.`);
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
