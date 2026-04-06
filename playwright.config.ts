import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    serviceWorkers: "block",
  },
  webServer: {
    command: "npm run build && python3 -m http.server 4173 -d public",
    port: 4173,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
