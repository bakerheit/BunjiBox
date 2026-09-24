import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Anchored to this file, not the cwd, so `npm run dev:site` from the repo root resolves.
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  // 5174 keeps the site clear of the workbench on 5173, so both can run at once.
  server: { port: 5174 },
})
