import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  use: {
    screenshot: "only-on-failure",
    baseURL: process.env.BASE_URL ?? "http://localhost:2569",
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
