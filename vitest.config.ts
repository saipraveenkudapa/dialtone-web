import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      // Outside Next's own webpack build there is no bundler-level
      // "react-server" condition to resolve the `server-only` package to
      // its no-op `empty.js`, so its default entry point unconditionally
      // throws. Point straight at that same empty.js so modules marked
      // server-only can still be imported (and mocked) under Vitest.
      "server-only": fileURLToPath(
        new URL("./node_modules/server-only/empty.js", import.meta.url),
      ),
    },
  },
});
