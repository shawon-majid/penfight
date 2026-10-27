import { defineConfig } from 'vite';

/**
 * `npm run dev` serves the game on its own. Solo play needs nothing else, so
 * that is enough for most work — including all physics tuning.
 *
 * For online tables, run `npm run dev:server` alongside it. These proxy rules
 * hand `/api` (and the websocket behind it) to the local Worker.
 *
 * `npm run build:itch` builds the itch.io copy (mode `itch`, settings in
 * `.env.itch`). itch serves a game from a sub-folder inside a frame, so its
 * files are linked relative to the page, and it lands in its own folder so it
 * never replaces the build the Worker serves.
 */
export default defineConfig(({ mode }) => {
  const itch = mode === 'itch';
  return {
    base: itch ? './' : '/',
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
      outDir: itch ? 'dist-itch' : 'dist',
      sourcemap: !itch,
    },
  };
});
