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
    // ── Code-splitting ──────────────────────────────────────────────────
    // manualChunks gives big, stable libs their own content-hashed chunks so
    // the browser caches them across deploys (app code changes far more often
    // than React/recharts). The GM dynasty game + recharts + the markdown stack
    // are LAZY (React.lazy in App.jsx / lazy wrappers), so their chunks must NOT
    // be preloaded on initial load — that's handled by modulePreload below.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/src/gm/data/')) return 'gm-data'
          if (id.includes('/src/gm/') || id.includes('/src/pages/gm/')) return 'gm'
          if (id.includes('/node_modules/')) {
            if (/\/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom)\//.test(id)) return 'vendor-react'
            if (id.includes('/node_modules/@supabase/')) return 'vendor-supabase'
            if (id.includes('/node_modules/@sentry')) return 'vendor-sentry'
            if (id.includes('/node_modules/recharts/') || id.includes('/node_modules/d3-') || id.includes('/node_modules/victory')) return 'vendor-charts'
            if (/\/node_modules\/(react-markdown|remark|micromark|mdast|hast|unified|unist|vfile|property-information|space-separated-tokens|comma-separated-tokens|decode-named-character-reference|character-entities|trim-lines|trough|bail|is-plain-obj|mdurl|ccount|markdown-table|zwitch|longest-streak|html-void-elements|web-namespaces)/.test(id)) return 'vendor-markdown'
          }
        },
      },
    },
    // Only modulepreload the genuinely-eager vendor chunks. Strip the lazy
    // feature chunks (GM game, recharts charts, markdown editor) so the browser
    // doesn't download ~1.9 MB of code that 99% of page views never use.
    modulePreload: {
      resolveDependencies(url, deps) {
        const LAZY = /\/(gm|gm-data|vendor-charts|vendor-markdown)-[A-Za-z0-9_-]+\.js$/
        return deps.filter((d) => !LAZY.test('/' + d))
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
