import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    emptyOutDir: false,
    lib: {
      entry: "src/preload/preload.ts",
      formats: ["cjs"],
      fileName: () => "preload.cjs"
    },
    outDir: "dist-electron",
    rollupOptions: {
      external: ["electron"]
    }
  }
});
