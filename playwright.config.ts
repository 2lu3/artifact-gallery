import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './src',
  testMatch: '**/*.e2e.ts',
  use: {
    browserName: 'chromium',
    ...devices['Desktop Chrome'],
  },
})
