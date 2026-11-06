// Construit l'extension VS Code dans extension/dist : bundle de l'hôte (extension.cjs) + page (web/).
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
console.log(`Extension construite dans ${OUT}`);
