// Lance le VRAI serveur Strata (page construite) branché sur le faux Bitbucket, puis le test UI Playwright.
// Usage : npm run test:e2e   (construit puis lance ; Python : argument ou variable PYTHON)
// Le test UI reçoit l'URL du serveur, celle des appels enregistrés et la liste des PR du faux Bitbucket.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from '../../src/server/app.ts';
import { FAKE_EMAIL, FAKE_PRS, FAKE_TOKEN, REPO, WS, startFakeBitbucket } from '../support/fake-bitbucket.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const python = process.argv[2] ?? process.env.PYTHON ?? '/Library/Frameworks/Python.framework/Versions/3.10/bin/python3';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-e2e-'));
const fake = await startFakeBitbucket();
const app = await startApp({ port: 0, env: { STRATA_CONFIG_DIR: dir, STRATA_TOKEN_STORE: 'file', STRATA_BITBUCKET_API: fake.url } });
await app.settings.update({ email: FAKE_EMAIL, token: FAKE_TOKEN, repos: [`${WS}/${REPO}`] });

const code = await new Promise<number>((resolve) => {
    const child = spawn(python, ['-I', path.join(here, 'ui_test.py')], {
        stdio: 'inherit',
        env: {
            ...process.env,
            STRATA_BASE_URL: app.url,
            STRATA_CALLS_URL: `http://127.0.0.1:${fake.port}/__calls`,
            STRATA_PR: `${WS}/${REPO}/${FAKE_PRS.main}`,
            STRATA_FAKE_PRS: JSON.stringify(FAKE_PRS),
            STRATA_FAKE_EMAIL: FAKE_EMAIL,
            STRATA_FAKE_TOKEN: FAKE_TOKEN,
        },
    });
    child.on('close', (status) => resolve(status ?? 1));
});
await app.close();
await fake.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(code);
