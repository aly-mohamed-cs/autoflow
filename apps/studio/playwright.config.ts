import { defineConfig } from '@playwright/test';

// End-to-end tests drive the built Electron app (run `pnpm build` first).
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
