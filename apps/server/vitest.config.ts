import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // node:sqlite is still flagged experimental in Node 24; the warning is noise in test output.
    execArgv: ['--disable-warning=ExperimentalWarning'],
  },
});
