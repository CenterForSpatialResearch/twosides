import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve, join, normalize } from 'path';
import { existsSync, statSync, createReadStream } from 'fs';

// The 33km tile set is ~1.8GB (25MB per year) and its cell history is another
// 166MB — far too large for the repo, for Git LFS, or for a Pages deploy. It
// lives in the gitignored temp/ folder instead, and this middleware serves it
// at the same URLs the 100km set uses so the app needs no special-casing:
//
//   /topojson/33km/<year>.topojson  ->  temp/topojson/33km/<year>.topojson
//   /data/cell-history-33km.json    ->  temp/data/cell-history-33km.json
//
// DEV ONLY, and only when the file is actually present — without temp/ the
// request falls through to public/ and 404s, which is what the resolution
// toggle reports. Nothing here affects `npm run build`.
function serveTempAssets() {
  const root = process.cwd();
  const tempDir = join(root, 'temp');

  return {
    name: 'serve-temp-assets',
    apply: 'serve',
    // Registered without a returned post-hook, so it runs BEFORE Vite's own
    // static handler and wins over any stray file of the same name in public/.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url || '').split('?')[0];
        const m =
          /^\/topojson\/33km\/[A-Za-z0-9_.-]+\.topojson$/.test(path) ||
          /^\/data\/cell-history-33km\.json$/.test(path);
        if (!m) return next();

        const file = normalize(join(tempDir, path));
        // normalize + prefix check keeps a crafted ../ out of the rest of disk.
        if (!file.startsWith(tempDir) || !existsSync(file)) return next();

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Length', statSync(file).size);
        // These are immutable snapshots; let the browser keep them so flipping
        // years back and forth doesn't refetch 25MB each time.
        res.setHeader('Cache-Control', 'public, max-age=3600');
        createReadStream(file).pipe(res);
      });
    }
  };
}

// Allow overriding the base path at build time (e.g., BASE_PATH=/twosides/ for repo pages).
// Default to root '/' so custom domains (twosides.earth) serve assets correctly.
const BASE_PATH = process.env.BASE_PATH || '/';

export default defineConfig(({ mode }) => ({
  base: mode === 'production' ? BASE_PATH : '/',
  plugins: [svelte(), serveTempAssets()],
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
