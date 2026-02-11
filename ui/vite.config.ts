import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
  css: {
    preprocessorOptions: {
      scss: {
        additionalData: '@import "src/styles/variables.scss";'
      }
    }
  },
  plugins: [sveltekit()],
  server: {
    port: 5173,
    proxy: {
      // Proxy API requests to Disc server during development
      '/api': {
        changeOrigin: true,
        target: 'http://localhost:5656'
      }
    }
  }
});
