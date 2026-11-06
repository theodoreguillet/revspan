// Construit l'extension VS Code dans extension/dist : bundle de l'hôte (extension.cjs) + page (web/).
// Copie aussi LICENSE et CHANGELOG.md à côté du manifeste (vsce les cherche dans extension/).
// Prérequis : la page est construite (npm run build:web).
import fs from 'node:fs';
import { build } from 'vite';

const WEB = 'dist/web';
const OUT = 'extension/dist';

if (!fs.existsSync(`${WEB}/index.html`)) {
    console.error('Page non construite : lance d\'abord « npm run build:web ».');
    process.exit(1);
}
fs.rmSync(OUT, { recursive: true, force: true });
await build({ configFile: 'vite.extension.config.ts', logLevel: 'warn' });
fs.cpSync(WEB, `${OUT}/web`, { recursive: true });
for (const file of ['LICENSE', 'CHANGELOG.md']) {
    fs.copyFileSync(file, `extension/${file}`);
}
console.log(`Extension construite dans ${OUT}`);
