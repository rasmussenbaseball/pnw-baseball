import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { sentryVitePlugin } from '@sentry/vite-plugin'

// Sentry sourcemap upload — gated on env vars so local + preview builds
// never try to upload. Set these in Vercel:
//   SENTRY_AUTH_TOKEN   — internal-integration token (Sentry → Settings →
//                         Developer Settings → New Internal Integration with
//                         "Releases: Admin" + "Issues & Events: Read")
//   SENTRY_ORG          — your Sentry org slug (NOT the numeric id). Find it
//                         at https://sentry.io/settings/<slug>/
//   SENTRY_PROJECT      — your project slug (e.g. "javascript-react")
const SENTRY_TOKEN = process.env.SENTRY_AUTH_TOKEN
const SENTRY_ORG = process.env.SENTRY_ORG
const SENTRY_PROJECT = process.env.SENTRY_PROJECT
const enableSentryUpload = !!(SENTRY_TOKEN && SENTRY_ORG && SENTRY_PROJECT)

export default defineConfig({
  plugins: [
    react(),
    // Upload sourcemaps to Sentry on every prod build. Without this, alerts
    // arrive with opaque single-letter function names and we burn hours
    // decoding minified stacks. Wraps Vite, runs after the build.
    enableSentryUpload && sentryVitePlugin({
      authToken: SENTRY_TOKEN,
      org: SENTRY_ORG,
      project: SENTRY_PROJECT,
      // Keep sourcemaps available at the deployed URL too — Sentry uses
      // both the uploaded copy AND the public //# sourceMappingURL fallback.
      sourcemaps: { assets: './dist/**' },
      // Disable telemetry — the plugin pings sentry.io for analytics by
      // default. We don't need that data and it can fail builds in some
      // network configs.
      telemetry: false,
    }),
  ].filter(Boolean),
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
          // chunk so dynasty creation doesn't blow up the GM bundle.
          if (id.includes('/src/gm/data/')) return 'gm-data'
          // Everything else GM (engine + components + pages) → one chunk.
          // Splitting engine from ui produced a gm-engine<->gm-ui circular
          // chunk warning and bought nothing (the whole game loads together on
          // first /gm hit), so collapse it.
          if (id.includes('/src/gm/') || id.includes('/src/pages/gm/')) return 'gm'
          // ── Vendor splits ──────────────────────────────────────────────
          // Pull big, stable third-party libs into their own chunks. They
          // change far less often than app code, so the browser can cache them
          // across deploys instead of re-downloading them inside index.js.
          if (id.includes('/node_modules/')) {
            if (/\/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom)\//.test(id)) return 'vendor-react'
            if (id.includes('/node_modules/@supabase/')) return 'vendor-supabase'
            if (id.includes('/node_modules/@sentry')) return 'vendor-sentry'
            if (id.includes('/node_modules/recharts/') || id.includes('/node_modules/d3-') || id.includes('/node_modules/victory')) return 'vendor-charts'
            if (/\/node_modules\/(react-markdown|remark|remark-gfm|micromark|mdast|hast|unified|unist|vfile|property-information|space-separated-tokens|comma-separated-tokens|decode-named-character-reference|character-entities|trim-lines|trough|bail|is-plain-obj|mdurl|ccount|markdown-table|escape-string-regexp|zwitch|longest-streak|html-void-elements|web-namespaces)/.test(id)) return 'vendor-markdown'
          }
        },
      },
    },
    // Bump chunk-size warning threshold from default 500kb to 1mb. The
    // GM engine chunk is intentionally large (full sim + data); warning
    // would just be noise.
    chunkSizeWarningLimit: 1024,
    // Emit sourcemaps alongside minified JS so Sentry can symbolicate
    // production stack traces. Without these, alerts arrive with opaque
    // single-letter function names (`De`, `Yd`, `zR`) and the React
    // boundary can't tell us which component threw. Sourcemaps are
    // hosted publicly — fine for this project since the GM game is
    // hobby-scale and the code's not proprietary.
    sourcemap: true,
  },
})
