import { resolve } from "node:path";

import { buildSync } from "esbuild";
import { defineConfig } from "vitest/config";

buildSync({
    entryPoints: [resolve("src/index.ts")],
    outfile: resolve("dist-test/index.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    sourcemap: true,
});

export default defineConfig({ test: { testTimeout: 30000 } });
