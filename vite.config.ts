import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../dist/renderer",
    // This only clears dist/renderer, preserving the separately compiled main/core output.
    emptyOutDir: true,
    sourcemap: false,
  },
});
