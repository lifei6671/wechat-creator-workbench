import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  workers: 2,
  outputDir: "output/playwright/test-results",
  use: { baseURL: "http://127.0.0.1:1421", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: {
    command: "pnpm exec vite --host 127.0.0.1 --port 1421 --strictPort",
    url: "http://127.0.0.1:1421/tests/theme-quotes.html",
  },
});
