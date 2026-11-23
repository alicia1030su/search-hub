import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const resolvePath = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary"],
      include: ["packages/*/src/**/*.ts", "apps/api/src/**/*.ts"],
      exclude: ["**/*.d.ts", "packages/db/migrations/**"],
    },
  },
  resolve: {
    alias: {
      "@search-hub/shared": resolvePath("./packages/shared/src/index.ts"),
      "@search-hub/db": resolvePath("./packages/db/src/index.ts"),
      "@search-hub/core": resolvePath("./packages/core/src/index.ts"),
      "@search-hub/providers": resolvePath("./packages/providers/src/index.ts"),
      "@search-hub/models": resolvePath("./packages/models/src/index.ts"),
      "@search-hub/mcp": resolvePath("./packages/mcp/src/index.ts"),
      "@search-hub/backup": resolvePath("./packages/backup/src/index.ts"),
    },
  },
});
