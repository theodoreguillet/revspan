import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const API_TARGET = `http://127.0.0.1:${process.env.REVSPAN_PORT ?? '7420'}`;

// The page lives in src/web; in dev, Vite serves the page and relays /api to the Revspan server.
export default defineConfig({
    root: 'src/web',
    // Relative paths: the same page is served by the local server and loaded in a VS Code panel.
    base: './',
    plugins: [vue()],
    build: {
        outDir: '../../dist/web',
        emptyOutDir: true,
    },
    server: {
        host: '127.0.0.1',
        port: 5173,
        strictPort: true,
        proxy: {
            // The server checks Host and Origin: we rewrite them to its own address.
            '/api': { target: API_TARGET, changeOrigin: true, headers: { origin: API_TARGET } },
            '/open': { target: API_TARGET, changeOrigin: true },
        },
    },
});
