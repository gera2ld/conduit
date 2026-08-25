import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

const { dependencies = {}, peerDependencies = {} } = pkg as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "index",
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
