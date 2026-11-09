import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

// VS Code extension: a single CommonJS file (VS Code's extension host), dependencies included, `vscode` provided by VS Code.
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
