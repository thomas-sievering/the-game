import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  // Real-time matches on slow CI runners occasionally miss a wait; one retry keeps that from failing a run.
  retries: process.env.CI ? 1 : 0,
  use: {
    screenshot: "only-on-failure",
    baseURL: process.env.BASE_URL ?? "http://localhost:2570",
    viewport: { width: 1280, height: 800 },
    // Headless Chromium renders WebGL in software (SwiftShader) by default, which
    // pins the CPU. Use the real GPU via D3D11 on Windows.
    launchOptions:
      process.platform === "win32"
        ? { args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] }
        : {},
  },
  outputDir: "test-results",
});
