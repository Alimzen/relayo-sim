import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The panel has its own test setup (ng test).
  test: { testTimeout: 15_000, include: ['test/**/*.test.ts'] },
});
