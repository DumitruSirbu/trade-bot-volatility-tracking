import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev proxy targets the engine on its default port (ADR 0026 §2.2).
// Same-origin design — the browser never learns the engine URL directly.
const ENGINE_DEV_TARGET = 'http://localhost:3000';

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
    server: {
        port: 8080,
        strictPort: true,
        proxy: {
            '/v1': {
                target: ENGINE_DEV_TARGET,
                changeOrigin: false,
            },
            '/socket.io': {
                target: ENGINE_DEV_TARGET,
                ws: true,
                changeOrigin: false,
            },
        },
    },
    preview: {
        port: 8080,
        strictPort: true,
    },
});
