import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@features': new URL('./src/features', import.meta.url).pathname,
      '@shared': new URL('./src/shared', import.meta.url).pathname,
      '@ui': new URL('./src/ui', import.meta.url).pathname,
      '@icons': new URL('./src/ui/icons/index.ts', import.meta.url).pathname,
      '@klankish/shared': new URL('../../packages/shared/src/index.ts', import.meta.url).pathname,
      '@klankish/expr': new URL('../../packages/expr/src/index.ts', import.meta.url).pathname,
    },
  },
  server: {
    port: 5173,
    proxy: {
      // The API runs on 3100 (3000 is taken by another local app). Proxying in dev keeps the
      // browser on one origin, so there is no CORS preflight and cookies behave as in production,
      // where the SPA is served by the API process itself.
      '/api': { target: 'http://localhost:3100', changeOrigin: true },
      '/health': { target: 'http://localhost:3100', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
