import { defineConfig } from 'vitest/config';

// Real-browser suite; kept out of `npm test` (which uses vite.config.ts and only matches *.test.ts).
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
