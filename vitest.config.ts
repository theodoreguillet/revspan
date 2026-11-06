import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        projects: [
            { test: { name: 'unit', include: ['test/unit/**/*.test.ts'], environment: 'node' } },
            { test: { name: 'integration', include: ['test/integration/**/*.test.ts'], environment: 'node' } },
            {
                test: {
                    name: 'web',
                    include: ['test/web/**/*.test.ts'],
                    environment: 'happy-dom',
                    // Les <iframe> des HTML hostiles testés pointent sur about:blank (aucun accès réseau) : happy-dom peut
                    // les « charger » comme un navigateur au lieu de signaler une erreur dans la console.
                    environmentOptions: { happyDOM: { settings: { enableIframePageLoading: true } } },
                },
            },
            { test: { name: 'live', include: ['test/live/**/*.test.ts'], environment: 'node', testTimeout: 120000 } },
        ],
    },
});
