// Builds the VS Code extension into extension/dist: host bundle (extension.cjs) + page (web/).
// Also copies LICENSE and CHANGELOG.md next to the manifest (vsce looks for them in extension/).
// Prerequisite: the page is built (build:web script).
import fs from 'node:fs';
import { build } from 'vite';

const WEB = 'dist/web';
const OUT = 'extension/dist';

if (!fs.existsSync(`${WEB}/index.html`)) {
    console.error('Page not built: run "npm run build:web" first.');
    process.exit(1);
}
fs.rmSync(OUT, { recursive: true, force: true });
await build({ configFile: 'vite.extension.config.ts', logLevel: 'warn' });
fs.cpSync(WEB, `${OUT}/web`, { recursive: true });
for (const file of ['LICENSE', 'CHANGELOG.md']) {
    fs.copyFileSync(file, `extension/${file}`);
}
console.log(`Extension built in ${OUT}`);
