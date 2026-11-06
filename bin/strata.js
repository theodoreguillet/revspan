#!/usr/bin/env node
// Lanceur : exécute le serveur construit (dist/). Construire avant : npm ci && npm run build
import { existsSync } from 'node:fs';

const main = new URL('../dist/server/main.js', import.meta.url);
const page = new URL('../dist/web/index.html', import.meta.url);
if (!existsSync(main) || !existsSync(page)) {
    console.error('Strata n\'est pas construit : lance `npm ci && npm run build` dans le dossier strata.');
    process.exit(1);
}
await import(main.href);
