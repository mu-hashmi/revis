import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  entry: {
    "bin/revis": "src/bin/revis.ts"
  },
  format: "esm",
  outDir: "dist",
  platform: "node",
  sourcemap: true,
  target: "node20"
});
