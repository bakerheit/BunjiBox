import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Anchored to this file, not the cwd, so `npm run dev -w @bunji/app` from the repo root resolves.
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  server: {
    host: '0.0.0.0',
    // Preserve the browser-facing host so the API can reject cross-origin writes.
    proxy: { '/api': { target: process.env.BUNJI_API_PROXY_TARGET || 'http://127.0.0.1:4318', changeOrigin: false } },
  },
})
