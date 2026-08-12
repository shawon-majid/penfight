import { defineConfig } from 'vitest/config';

/**
 * The tests cover `src/shared` — the physics and the rules. That code has no
 * DOM and no network in it, which is exactly why it can be tested this
 * plainly.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
