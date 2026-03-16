import { mkdir, rm, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(repoRoot, "dist", "dashboard");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [join(repoRoot, "src", "dashboard", "main.tsx")],
  bundle: true,
  format: "esm",
  outfile: join(outDir, "app.js"),
  jsx: "automatic",
  platform: "browser",
  sourcemap: true,
  target: ["es2022"]
});

await copyFile(
  join(repoRoot, "src", "dashboard", "index.html"),
  join(outDir, "index.html")
);
