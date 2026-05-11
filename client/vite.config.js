import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  worker: { format: 'es' },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // jassub (libass-wasm) uses emscripten pthread workers, which require
    // SharedArrayBuffer. SharedArrayBuffer is only exposed in a cross-
    // origin isolated context — meaning the page must be served with
    // COOP: same-origin and COEP set to require-corp or credentialless.
    // Without these headers the jassub worker pool init hangs silently
    // (no error fires; SAB access is just blocked), so renderer.ready
    // never resolves.
    //
    // Using `credentialless` instead of `require-corp` because the app
    // pulls cover images from external CDNs (AniList, Bangumi) that
    // don't send Cross-Origin-Resource-Policy: cross-origin. With
    // require-corp those images would 404; with credentialless they
    // load as no-cors no-credentials, which is what <img> defaults to
    // anyway.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      // CORP is required for workers even under credentialless — the
      // credentialless relaxation only applies to top-level subresources
      // like images/scripts/css; workers must still be CORP-clean.
      // Without this, new Worker(...) under COEP fails with a generic
      // "Event { type: 'error' }" (no message), confusingly indistinguishable
      // from a runtime crash.
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
    proxy: {
      '/api': {
        target: 'http://localhost:5001',
        changeOrigin: true
      }
    }
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Split shared infra so the route chunks stay small. Heavy single-route
        // libraries (artplayer, motion) intentionally are NOT chunked here so
        // they ride along with their own route's lazy chunk.
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-query': ['@tanstack/react-query'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.js',
  },
})
