import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/**
 * The API in development. Same-origin in production, so only the dev server proxies.
 *
 * Port 3000 and dev server 5173, matching `PORT` and `PUBLIC_WEB_ORIGIN` in `booking-app/.env` —
 * the API allow-lists the success and cancel URLs against `PUBLIC_WEB_ORIGIN`, so a mismatched
 * dev port makes every booking fail validation.
 */
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        // The function form, because Rollup 5 — which Vite 8 uses — removed the object form.
        // Framework code changes on an upgrade, application code changes on every deploy, so
        // separating them means a deploy does not invalidate the cached framework chunk. The
        // office area splits itself: its routes are dynamic imports.
        manualChunks: (id: string) => (id.includes('node_modules') ? 'vendor' : undefined),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Development is same-origin like production. Without the proxy the browser would send
      // cross-origin requests, and the session cookie and CSRF header behaviour would differ
      // from what actually ships — the class of bug that only appears in production.
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
});
