import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: "src/preload/preload.ts",
      formats: ["es"],
      fileName: () => "preload.mjs"
    },
    outDir: "dist-electron",
    rollupOptions: {
      external: ["electron"]
    }
  }
});
