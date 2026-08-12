import { defineConfig } from 'vite';

/**
 * `npm run dev` serves the game on its own. Solo play needs nothing else, so
 * that is enough for most work — including all physics tuning.
 *
 * For online tables, run `npm run dev:server` alongside it. These proxy rules
 * hand `/api` (and the websocket behind it) to the local Worker.
 */
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
