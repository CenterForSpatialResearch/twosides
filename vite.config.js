import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';

// Allow overriding the base path at build time (e.g., BASE_PATH=/moma/ for the
// exhibition build under twosides.earth/moma).
// Default to root '/' so custom domains (twosides.earth) serve assets correctly.
const BASE_PATH = process.env.BASE_PATH || '/';

export default defineConfig(({ mode }) => ({
  base: mode === 'production' ? BASE_PATH : '/',
  plugins: [svelte()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        loading: resolve(__dirname, 'loading.html'),
        anthromes: resolve(__dirname, 'src/anthromes/index.html'),
        biomes: resolve(__dirname, 'src/biomes/index.html')
      }
    }
  },
  server: {
    open: true
  }
}));
