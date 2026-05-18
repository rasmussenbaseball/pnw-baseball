import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    // Code-splitting: separate the GM dynasty game from the main analytics
    // site so visitors who never hit /gm/* don't download ~1.5MB of game
    // code. The main bundle stays lean for the public site.
    rollupOptions: {
      output: {
        manualChunks(id) {
          // GM data JSONs are large (non_naia_teams.json ~5000 lines,
          // pear_ratings_2026.json ~1500 lines) — pull them into their own
          // chunk so dynasty creation doesn't blow up the GM engine bundle.
          if (id.includes('/src/gm/data/')) return 'gm-data'
          // GM engine modules (sim, rankings, schedule, etc.)
          if (id.includes('/src/gm/engine/')) return 'gm-engine'
          // GM page components + GM-only UI components
          if (id.includes('/src/pages/gm/') || id.includes('/src/gm/components/')) return 'gm-ui'
          // Heavy 3rd-party chart libs — only used on main-site analytics pages
          if (id.includes('/node_modules/recharts/')) return 'vendor-charts'
          if (id.includes('/node_modules/d3-')) return 'vendor-d3'
        },
      },
    },
    // Bump chunk-size warning threshold from default 500kb to 1mb. The
    // GM engine chunk is intentionally large (full sim + data); warning
    // would just be noise.
    chunkSizeWarningLimit: 1024,
  },
})
