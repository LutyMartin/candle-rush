import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" keeps asset paths relative, so the build works from a GitHub Pages subfolder.
export default defineConfig({
  base: "./",
  plugins: [react()],
  optimizeDeps: { include: ["@coral-xyz/anchor", "@solana/web3.js", "buffer"] },
  define: { "process.env": {}, global: "globalThis" },
});
