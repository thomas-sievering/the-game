import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    port: 5174,
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
