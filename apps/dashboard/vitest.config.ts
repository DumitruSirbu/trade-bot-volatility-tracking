import path from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Vitest config for the dashboard. Mirrors the vite.config.ts alias so
// absolute `@/` imports resolve inside test files without a build step.
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
            // Keep the workspace package resolvable in the test environment.
            '@bot/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
        },
    },
    test: {
        environment: 'jsdom',
        globals: true,
        setupFiles: ['./src/test-setup.ts'],
        // Co-located spec files under src/ — consistent with the testing.md rule.
        include: ['src/**/*.spec.{ts,tsx}'],
    },
});
