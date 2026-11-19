// Smoke test of the extension in a REAL VS Code, isolated (temporary profile and extensions folder),
// wired to the fake Bitbucket. It is driven by Playwright (Python) through VS Code's debugging port.
// Usage: npm run test:extension   (builds then runs; Python: argument or PYTHON variable)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_EMAIL, FAKE_PRS, FAKE_TOKEN, REPO, WS, startFakeBitbucket } from '../support/fake-bitbucket.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const python = process.argv[2] ?? process.env.PYTHON ?? '/Library/Frameworks/Python.framework/Versions/3.10/bin/python3';
const vscodeBinary = process.env.VSCODE_BINARY ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const extensionDir = path.join(root, 'extension');

if (!fs.existsSync(path.join(extensionDir, 'dist', 'extension.cjs'))) {
    console.error('Extension not built: run "npm run build:extension".');
    process.exit(2);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'revspan-vscode-'));
const userData = path.join(tmp, 'user');
const workspace = path.join(tmp, 'workspace');
const fake = await startFakeBitbucket();

// Workspace: "clone" of demo-repo on the main PR's branch (for "Open file").
const main = fake.data.prs.get(FAKE_PRS.main);
const tip = [...fake.data.repo.commits.keys()].find((hash) => hash.startsWith(main?.pr.source?.commit?.hash ?? '-'));
if (!main || !tip) {
    throw new Error('Main PR not found in the fake Bitbucket');
}
const repoDir = path.join(workspace, REPO);
for (const [file, content] of Object.entries(fake.data.repo.get(tip).files)) {
    fs.mkdirSync(path.dirname(path.join(repoDir, file)), { recursive: true });
    fs.writeFileSync(path.join(repoDir, file), content);
}
fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
fs.writeFileSync(path.join(repoDir, '.git', 'HEAD'), `ref: refs/heads/${main.pr.source?.branch?.name ?? 'master'}\n`);

// Quiet profile (no welcome editor, no updates, trust granted).
fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoCheckUpdates': false,
    'extensions.autoUpdate': false,
    'security.workspace.trust.enabled': false,
    'chat.disableAIFeatures': true,
}));

// A window of another profile computing its own home when this one starts (VS Code shares the extension's storage across
// profiles): its lease must not hold "My PRs" back.
const homeLockAt = Date.now();
const storage = path.join(userData, 'User', 'globalStorage', 'theodoreguillet.revspan');
fs.mkdirSync(storage, { recursive: true });
fs.writeFileSync(path.join(storage, 'home.lock'), JSON.stringify({ token: 'other-profile', at: homeLockAt, identity: 'other' }));

// Variables of the current VS Code session removed: otherwise the new process would attach to it.
const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VSCODE_') && key !== 'ELECTRON_RUN_AS_NODE'));
Object.assign(env, {
    REVSPAN_BITBUCKET_API: fake.url,
    REVSPAN_TEST_EMAIL: FAKE_EMAIL,
    REVSPAN_TEST_TOKEN: FAKE_TOKEN,
    REVSPAN_TEST_REPOS: `${WS}/${REPO}`,
});

const port = 9300 + Math.floor(Math.random() * 600);
// VS Code stays in English (no language pack in this profile) while Chromium's --lang switch gives the webview
// a French browser language: the page must follow VS Code's language passed by the host, not the browser's.
const code = spawn(vscodeBinary, [
    '--user-data-dir', userData,
    '--extensions-dir', path.join(tmp, 'extensions'),
    `--extensionDevelopmentPath=${extensionDir}`,
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-telemetry',
    '--new-window',
    `--remote-debugging-port=${port}`,
    '--lang=fr-FR',
    workspace,
], { env, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
code.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

async function cdpReady(): Promise<boolean> {
    for (let i = 0; i < 120; i++) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (response.ok) {
                return true;
            }
        } catch {
            // not ready yet
        }
        await sleep(500);
    }
    return false;
}

let status = 1;
try {
    if (!await cdpReady()) {
        throw new Error(`VS Code is not answering on port ${port}.\n${stderr.slice(-2000)}`);
    }
    status = await new Promise<number>((resolve) => {
        // SMOKE_SCRIPT: another driving script (diagnostics).
        const child = spawn(python, ['-I', process.env.SMOKE_SCRIPT ?? path.join(here, 'smoke.py')], {
            stdio: 'inherit',
            env: {
                ...process.env,
                CDP_URL: `http://127.0.0.1:${port}`,
                PR_TITLE: main.pr.title ?? '',
                HOME_LOCK_AT: String(homeLockAt),
                REVSPAN_CALLS_URL: `http://127.0.0.1:${fake.port}/__calls`,
                SHOTS_DIR: process.env.REVSPAN_SHOTS_DIR ?? path.join(tmp, 'shots'),
            },
        });
        child.on('close', (exitCode) => resolve(exitCode ?? 1));
    });
    // Tracked repositories are stored in the VS Code setting revspan.repositories (the profile's user settings).
    const userSettings = JSON.parse(fs.readFileSync(path.join(userData, 'User', 'settings.json'), 'utf8')) as Record<string, unknown>;
    const reposSaved = JSON.stringify(userSettings['revspan.repositories']) === JSON.stringify([`${WS}/${REPO}`]);
    console.log(`${reposSaved ? 'PASS' : 'FAIL'}  VS Code setting revspan.repositories written`);
    if (!reposSaved) {
        status = 1;
    }
    // The "Revspan" log output channel, as VS Code wrote it to the profile's logs: home loads, no PR data or token.
    const logsDir = path.join(userData, 'logs');
    const log = fs.readdirSync(logsDir, { recursive: true, encoding: 'utf8' })
        .filter((file) => file.includes('theodoreguillet.revspan') && file.endsWith('.log'))
        .map((file) => fs.readFileSync(path.join(logsDir, file), 'utf8'))
        .join('');
    const logged = /home load: source=(computed|shared) /.test(log) && ![main.pr.title || '-', FAKE_TOKEN, 'Thomas Girard'].some((secret) => log.includes(secret));
    console.log(`${logged ? 'PASS' : 'FAIL'}  "Revspan" log: one line per home load, no PR title, name or token${logged ? '' : ` — ${log.slice(0, 400)}`}`);
    if (!logged) {
        status = 1;
    }
} catch (error) {
    console.error((error as Error).message);
} finally {
    code.kill('SIGTERM');
    await sleep(1500);
    if (code.exitCode === null) {
        code.kill('SIGKILL');
    }
    await fake.close();
    fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(status);
