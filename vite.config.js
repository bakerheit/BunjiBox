import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(process.cwd(), './src') } },
  server: {
    host: '0.0.0.0',
    // Preserve the browser-facing host so the API can reject cross-origin writes.
    proxy: { '/api': { target: 'http://127.0.0.1:4318', changeOrigin: false } },
  },
})
