import { defineConfig, defineProject } from "vitest/config";

const sharedNodeConfig = {
  environment: "node",
  watch: false
} as const;

export default defineConfig({
  test: {
    projects: [
      defineProject({
        test: {
          ...sharedNodeConfig,
          name: "contracts",
          include: ["tests/contracts/**/*.test.ts"],
          testTimeout: 10_000
        }
      }),
      defineProject({
        test: {
          ...sharedNodeConfig,
          name: "transport",
          include: ["tests/transport/**/*.test.ts"],
          testTimeout: 10_000
        }
      }),
      defineProject({
        test: {
          ...sharedNodeConfig,
          name: "orchestration",
          include: ["tests/orchestration/**/*.test.ts"],
          testTimeout: 10_000
        }
      }),
      defineProject({
        test: {
          ...sharedNodeConfig,
          name: "acceptance",
          include: ["tests/acceptance/**/*.test.ts"],
          sequence: {
            concurrent: false,
            shuffle: false
          },
          testTimeout: 30_000,
          hookTimeout: 30_000
        }
      })
    ]
  }
});
