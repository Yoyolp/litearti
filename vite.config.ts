import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

// Tauri drives the dev server on a fixed port and expects the frontend to be
// reachable there; failing loudly beats a silent port change.
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: {
      // Rust sources are rebuilt by cargo, not Vite. Scratch dirs and transient
      // editor swap files are excluded too: a watcher that picks up a locked
      // temp file crashes the whole dev server, and that failure mode is
      // confusing because nothing in the app is actually broken.
      ignored: [
        '**/src-tauri/**',
        '**/.shots/**',
        '**/.testdata/**',
        '**/dist/**',
        '**/*.tmpdir/**',
        '**/.*.tmp',
        '**/*.swp',
      ],
    },
  },
  build: {
    // WebView2 on Windows and modern Android WebViews both handle es2020.
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  optimizeDeps: {
    // pdf.js ships as ESM with a worker entry; pre-bundling it is safe but
    // excluding keeps the worker URL resolution predictable in dev.
    exclude: ['pdfjs-dist'],
  },
})
