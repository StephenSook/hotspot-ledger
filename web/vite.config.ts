/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes('@deck.gl') || id.includes('@luma.gl') || id.includes('@math.gl') || id.includes('@loaders.gl')) return 'deck'
          if (id.includes('@mediapipe')) return 'mediapipe'
          return undefined
        },
      },
    },
  },
  server: { port: 5173 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
