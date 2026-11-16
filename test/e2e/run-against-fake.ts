// Runs the REAL Revspan server (built page) wired to the fake Bitbucket, then the Playwright UI test.
// Usage: npm run test:e2e   (builds then runs; Python: argument or PYTHON variable)
//        npm run test:perf  (--perf: the fake also serves the large PR and perf_test.py measures the diff's long tasks)
// The UI test receives the server URL, the URLs of the recorded calls and requests and the list of the fake Bitbucket's PRs.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from '../../src/server/app.ts';
import { FAKE_BIG_PR, FAKE_EMAIL, FAKE_PRS, FAKE_TOKEN, REPO, WS, startFakeBitbucket } from '../support/fake-bitbucket.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const perf = args.includes('--perf');
const python = args.find((arg) => arg !== '--perf') ?? process.env.PYTHON ?? '/Library/Frameworks/Python.framework/Versions/3.10/bin/python3';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revspan-e2e-'));
const fake = await startFakeBitbucket({ bigPr: perf });
const app = await startApp({ port: 0, env: { REVSPAN_CONFIG_DIR: dir, REVSPAN_TOKEN_STORE: 'file', REVSPAN_BITBUCKET_API: fake.url } });
await app.settings.update({ email: FAKE_EMAIL, token: FAKE_TOKEN, repos: [`${WS}/${REPO}`] });

const code = await new Promise<number>((resolve) => {
    const child = spawn(python, ['-I', path.join(here, perf ? 'perf_test.py' : 'ui_test.py')], {
        stdio: 'inherit',
        env: {
            ...process.env,
            REVSPAN_BASE_URL: app.url,
            REVSPAN_CALLS_URL: `http://127.0.0.1:${fake.port}/__calls`,
            REVSPAN_REQUESTS_URL: `http://127.0.0.1:${fake.port}/__requests`,
            REVSPAN_PR: `${WS}/${REPO}/${perf ? FAKE_BIG_PR : FAKE_PRS.main}`,
            REVSPAN_FAKE_PRS: JSON.stringify(FAKE_PRS),
            REVSPAN_FAKE_EMAIL: FAKE_EMAIL,
            REVSPAN_FAKE_TOKEN: FAKE_TOKEN,
        },
    });
    child.on('close', (status) => resolve(status ?? 1));
});
await app.close();
await fake.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(code);
