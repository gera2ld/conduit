import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

const { dependencies = {}, peerDependencies = {} } = pkg as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

export default defineConfig({
  build: {
    lib: {
      entry: { index: "src/index.ts", cli: "src/cli.ts" },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: [/^node:/, ...Object.keys({ ...dependencies, ...peerDependencies })],
    },
    target: "esnext",
    minify: false,
    outDir: "dist",
    emptyOutDir: true,
  },
});
