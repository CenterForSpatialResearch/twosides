import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';

export default defineConfig({
  plugins: [svelte()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        anthromes: resolve(__dirname, 'src/anthromes/index.html'),
        biomes: resolve(__dirname, 'src/biomes/index.html')
      }
    }
  },
  server: {
    open: true
  }
});
