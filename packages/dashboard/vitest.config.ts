import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // next-auth imports "next/server" without an extension, which Node ESM cannot resolve; let Vite do it.
    server: { deps: { inline: ["next-auth"] } },
  },
});
