import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const windowsChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4187',
    viewport: { width: 1440, height: 960 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (process.platform === 'win32' && existsSync(windowsChrome) ? windowsChrome : undefined) },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: { command: 'npm exec -- vite preview --host 127.0.0.1 --port 4187 --strictPort', url: 'http://127.0.0.1:4187', reuseExistingServer: false },
});
