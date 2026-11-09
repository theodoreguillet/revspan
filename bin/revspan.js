#!/usr/bin/env node
// Launcher: runs the built server (dist/). Build first (see the README).
import { existsSync } from 'node:fs';

const main = new URL('../dist/server/main.js', import.meta.url);
const page = new URL('../dist/web/index.html', import.meta.url);
if (!existsSync(main) || !existsSync(page)) {
    console.error('Revspan is not built: install the dependencies and run the build script in the revspan folder.');
    process.exit(1);
}
await import(main.href);
