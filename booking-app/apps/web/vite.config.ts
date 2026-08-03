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
        // separating them means a deploy does not invalidate the cached framework chunk.
        //
        // Vendor is the only manual chunk, and a named `office` chunk was tried and removed:
        // adding one made Rollup fold `vendor` into it, producing a single 316 kB file that
        // the entry depends on — so every customer would have downloaded the staff interface
        // to get Vue. The office area splits itself through its route-level dynamic imports,
        // which `office/isolation.spec.ts` pins.
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
  /**
   * What the end-to-end suite drives: the built bundle, proxied the same way.
   *
   * A production build rather than the dev server, because that is what ships — the
   * chunking above, the minified templates, the router's lazy office chunk. The proxy
   * has to be repeated here because `server` and `preview` are separate configurations
   * in Vite, and a same-origin dev server with a cross-origin preview would mean the
   * suite proving the cookie behaviour of a setup nobody deploys.
   */
  preview: {
    port: 4173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
});
