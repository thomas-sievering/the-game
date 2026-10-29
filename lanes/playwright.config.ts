import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:2568",
    viewport: { width: 1280, height: 800 },
  },
  outputDir: "test-results",
});
