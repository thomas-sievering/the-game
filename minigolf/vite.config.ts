import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
