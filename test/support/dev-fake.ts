// Développement sans toucher au vrai Bitbucket : faux Bitbucket + serveur Revspan sur le port 7420
// (configuration temporaire). Lancer ensuite `npm run dev:web` pour la page avec rechargement à chaud.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp } from '../../src/server/app.ts';
import { FAKE_EMAIL, FAKE_PRS, FAKE_TOKEN, REPO, WS, startFakeBitbucket } from './fake-bitbucket.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revspan-dev-'));
const fake = await startFakeBitbucket();
const app = await startApp({ port: 7420, maxPortTries: 1, env: { REVSPAN_CONFIG_DIR: dir, REVSPAN_TOKEN_STORE: 'file', REVSPAN_BITBUCKET_API: fake.url } });
await app.settings.update({ email: FAKE_EMAIL, token: FAKE_TOKEN, repos: [`${WS}/${REPO}`] });

console.log(`Faux Bitbucket : ${fake.url}`);
console.log(`Revspan      : ${app.url}  (page construite)`);
for (const [name, id] of Object.entries(FAKE_PRS)) {
    console.log(`  ${name.padEnd(14)} ${app.url}/#/pr/${WS}/${REPO}/${id}`);
}
console.log('Page en dev    : npm run dev:web → http://127.0.0.1:5173');

const stop = (): void => {
    void Promise.all([app.close(), fake.close()]).then(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        process.exit(0);
    });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
