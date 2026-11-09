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
                    // The <iframe>s of the tested hostile HTML point to about:blank (no network access): happy-dom may
                    // "load" them like a browser instead of reporting an error in the console.
                    environmentOptions: { happyDOM: { settings: { enableIframePageLoading: true } } },
                },
            },
            { test: { name: 'live', include: ['test/live/**/*.test.ts'], environment: 'node', testTimeout: 120000 } },
        ],
    },
});
