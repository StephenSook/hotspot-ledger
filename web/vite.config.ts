/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const pkgOf = (id: string): string => /.*node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(id)?.[1] ?? ''

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        // Chunk groups by the package a module belongs to (the last node_modules segment), React first.
        // pnpm folder names such as .pnpm/@deck.gl+react@... contain other packages' names, and the
        // old substring manualChunks rule also pulled React into the deck chunk as a dependency of
        // @deck.gl/react, so every page (the notice check page too) downloaded the 3D map engine.
        codeSplitting: {
          groups: [
            // Vite's dynamic-import helper is shared by the entry and the deck chunk; left alone it lands in deck.
            { name: 'preload', test: (id: string) => id.includes('vite/preload-helper'), priority: 40 },
            { name: 'react', test: (id: string) => /^(react|react-dom|scheduler)$/.test(pkgOf(id)), priority: 30 },
            { name: 'deck', test: (id: string) => /^@(deck|luma|math|loaders|probe)\.gl\/|^(mjolnir\.js|earcut|@mapbox\/tiny-sdf)$/.test(pkgOf(id)), priority: 20 },
            { name: 'mediapipe', test: (id: string) => pkgOf(id).startsWith('@mediapipe/'), priority: 10 },
          ],
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
