import { defineConfig, devices } from '@playwright/test'

// E2E runs against the production build served by `vite preview`, or against a deployed URL
// when BASE_URL is set (the post-deploy smoke test).
const BASE_URL = process.env.BASE_URL || 'http://localhost:4173'

export default defineConfig({
  testDir: './e2e',
  // Remote runs download the map data and the 3D bundle over the network, so allow more time.
  timeout: process.env.BASE_URL ? 120_000 : 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    // The line reveal fades text in; axe must measure settled colors, and the CSS honors this.
    reducedMotion: 'reduce',
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: process.env.BASE_URL
    ? undefined
    : { command: 'pnpm build && pnpm preview --port 4173 --strictPort', url: BASE_URL, reuseExistingServer: !process.env.CI, timeout: 180_000 },
})
