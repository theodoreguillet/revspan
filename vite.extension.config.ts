import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

// Extension VS Code : un seul fichier CommonJS (hôte d'extensions de VS Code), dépendances incluses, `vscode` fourni par VS Code.
export default defineConfig({
    build: {
        ssr: 'src/extension/extension.ts',
        outDir: 'extension/dist',
        emptyOutDir: false,
        target: 'node20',
        sourcemap: true,
        minify: false,
        rollupOptions: {
            external: ['vscode', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
            output: { format: 'cjs', entryFileNames: 'extension.cjs' },
        },
    },
    ssr: { noExternal: true },
});
