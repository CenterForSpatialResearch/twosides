import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve, join, normalize } from 'path';
import { existsSync, statSync, createReadStream } from 'fs';

// Map data too large for the repo, Git LFS, or a Pages deploy lives in the
// gitignored temp/ folder, and this middleware serves it at the URLs the app
// expects:
//
//   /grid/<profile>/<file>               ->  temp/grid/<profile>/<file>
//   /topojson/<profile>/<year>.topojson  ->  temp/topojson/<profile>/<year>.topojson
//   /data/cell-history-<profile>.json    ->  temp/data/cell-history-<profile>.json
//
// The grid routes are the ones that matter now — all six profiles together are
// ~214MB, against 1.8GB for the 33km TopoJSON set alone. The topojson and
// cell-history routes stay so the two formats can be compared on screen.
//
// Profiles offered in the picker are listed in src/shared/topoProfile.svelte.js;
// those all live in public/grid/ and never reach this middleware.
//
// DEV ONLY, and only when the file is actually present — without temp/ the
// request falls through to public/ and 404s, which is what the resolution
// toggle reports. Nothing here affects `npm run build`.
// Only profiles that are NOT shipped. 50-100km live in public/grid/ and are
// served by Vite's own static handler in dev and prod alike, so what you see
// locally is what deploys. These finer ones stay dev-only for inspection;
// the middleware 404s anything not actually present on disk.
const TEMP_PROFILES = ['10km', '25km', '33km'];

function serveTempAssets() {
  const root = process.cwd();
  const tempDir = join(root, 'temp');
  const profiles = TEMP_PROFILES.join('|');
  const tileRe = new RegExp(`^/topojson/(?:${profiles})/[A-Za-z0-9_.-]+\\.topojson$`);
  const historyRe = new RegExp(`^/data/cell-history-(?:${profiles})\\.json$`);
  // Grid format: manifest.json plus the mask/codes/countries blobs.
  const gridRe = new RegExp(`^/grid/(?:${profiles})/[A-Za-z0-9_-]+\\.(?:json|bin)$`);

  return {
    name: 'serve-temp-assets',
    apply: 'serve',
    // Registered without a returned post-hook, so it runs BEFORE Vite's own
    // static handler and wins over any stray file of the same name in public/.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url || '').split('?')[0];
        const m = tileRe.test(path) || historyRe.test(path) || gridRe.test(path);
        if (!m) return next();

        const file = normalize(join(tempDir, path));
        // normalize + prefix check keeps a crafted ../ out of the rest of disk.
        if (!file.startsWith(tempDir) || !existsSync(file)) return next();

        res.setHeader(
          'Content-Type',
          path.endsWith('.bin') ? 'application/octet-stream' : 'application/json'
        );
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
