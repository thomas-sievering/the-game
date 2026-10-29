import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  use: {
    screenshot: "only-on-failure",
    baseURL: process.env.BASE_URL ?? "http://localhost:2567",
    viewport: { width: 1280, height: 800 },
  },
  outputDir: "test-results",
});
