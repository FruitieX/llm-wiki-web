import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    port: Number(process.env.LLM_WIKI_DEV_PORT ?? 3102),
    strictPort: true,
    proxy: { '/api': process.env.LLM_WIKI_API_URL ?? 'http://127.0.0.1:3002' },
  },
  build: { chunkSizeWarningLimit: 900 },
})
