// Development without touching the real Bitbucket: fake Bitbucket + Revspan server on port 7420
// (temporary configuration, per-run secret like the CLI). Then run `npm run dev:web` for the page with hot reload.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp } from '../../src/server/app.ts';
import { newSecret } from '../../src/server/http/cli-secret.ts';
import { FAKE_EMAIL, FAKE_PRS, FAKE_TOKEN, REPO, WS, startFakeBitbucket } from './fake-bitbucket.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revspan-dev-'));
const fake = await startFakeBitbucket();
const app = await startApp({ port: 7420, maxPortTries: 1, secret: newSecret(), env: { REVSPAN_CONFIG_DIR: dir, REVSPAN_TOKEN_STORE: 'file', REVSPAN_BITBUCKET_API: fake.url } });
await app.settings.update({ email: FAKE_EMAIL, token: FAKE_TOKEN, repos: [`${WS}/${REPO}`] });

// The ?k= addresses set the secret cookie; it also covers the Vite page (cookies ignore the port).
console.log(`Fake Bitbucket : ${fake.url}`);
console.log(`Revspan        : ${app.openUrl()}  (built page)`);
for (const [name, id] of Object.entries(FAKE_PRS)) {
    console.log(`  ${name.padEnd(14)} ${app.openUrl(`#/pr/${WS}/${REPO}/${id}`)}`);
}
console.log('Dev page       : npm run dev:web → http://127.0.0.1:5173 (open one of the addresses above first)');

const stop = (): void => {
    void Promise.all([app.close(), fake.close()]).then(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        process.exit(0);
    });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
