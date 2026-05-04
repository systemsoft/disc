import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";

export default defineConfig({
  css: {
    preprocessorOptions: {
      scss: {
        additionalData: '@import "src/styles/variables.scss";',
      },
    },
  },
  plugins: [sveltekit()],
  server: {
    port: 5173,
    proxy: {
      // Proxy API requests to Disc server during development.
      // Strip the `/api` prefix — the server exposes bare routes
      // (`/schema`, `/query`, `/health`, ...). The `/api` namespace
      // exists only on the browser side to avoid colliding with
      // SvelteKit page routes like `/schema` and `/query`.
      "/api": {
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
        target: "http://localhost:5656",
      },
    },
  },
});
