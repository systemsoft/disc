import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // P1-25: design tokens moved to ui/src/styles/tokens.css and imported
  // once in app.scss; per-file SCSS partials read CSS custom properties
  // directly. The previous `additionalData` injection of variables.scss
  // is no longer needed.
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
        rewrite: path => path.replace(/^\/api/, ""),
        target: "http://localhost:5656"
      }
    }
  }
});
