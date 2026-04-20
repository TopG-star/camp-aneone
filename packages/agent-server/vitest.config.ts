import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@oneon/domain": path.resolve(__dirname, "../domain/src/index.ts"),
      "@oneon/application": path.resolve(__dirname, "../application/src/index.ts"),
      "@oneon/infrastructure": path.resolve(__dirname, "../infrastructure/src/index.ts"),
      "@oneon/contracts": path.resolve(__dirname, "../contracts/src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    globals: true,
  },
});
