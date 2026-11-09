import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const API_TARGET = `http://127.0.0.1:${process.env.REVSPAN_PORT ?? '7420'}`;

// La page vit dans src/web ; en dev, Vite sert la page et relaie /api vers le serveur Revspan.
export default defineConfig({
    root: 'src/web',
    // Chemins relatifs : la même page est servie par le serveur local et chargée dans un panneau VS Code.
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
            // Le serveur vérifie Host et Origin : on les réécrit vers sa propre adresse.
            '/api': { target: API_TARGET, changeOrigin: true, headers: { origin: API_TARGET } },
            '/open': { target: API_TARGET, changeOrigin: true },
        },
    },
});
