import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results/browser",
  fullyParallel: false,
  reporter: [["list"], ["./e2e/reporter.mjs"]],
  use: {
    baseURL: "http://127.0.0.1:7349",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/dashboard-fixture.mjs",
    url: "http://127.0.0.1:7349",
    reuseExistingServer: false,
    timeout: 60000,
  },
});
