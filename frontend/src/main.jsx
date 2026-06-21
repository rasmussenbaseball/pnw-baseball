import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './styles/index.css'
import { initSentry, Sentry } from './lib/sentry'

// Initialize Sentry before mounting React so init runs before any component
// code that might throw. No-ops in dev and when VITE_SENTRY_DSN is unset.
initSentry()

// Recover from stale dynamically-imported chunks after a redeploy. Each new
// frontend build gives every code-split chunk a fresh content-hash filename and
// the old names stop existing; our SPA host then answers the missing-asset
// request with index.html (text/html), which the browser can't evaluate as a
// module. A tab still running the previous build therefore throws
// "Failed to fetch dynamically imported module" the first time it lazy-loads a
// route (e.g. /recruiting/guide). Vite dispatches a cancelable vite:preloadError
// on that failure; reload once to pull the current asset manifest. A timestamp
// guard keeps a genuinely-broken chunk from looping (the second failure inside
// the window falls through to the Sentry ErrorBoundary below).
window.addEventListener('vite:preloadError', (event) => {
  const KEY = 'nwbb_chunk_reload_ts'
  let last = 0
  try { last = Number(sessionStorage.getItem(KEY) || 0) } catch { /* storage blocked */ }
  if (Date.now() - last > 10000) {
    try { sessionStorage.setItem(KEY, String(Date.now())) } catch { /* storage blocked */ }
    event.preventDefault()   // we handle it via reload; skip Vite's default re-throw
    window.location.reload()
  }
})

// A stale code-split chunk can also detonate INSIDE React.lazy after the
// per-route recovery above has already used its one reload (e.g. several
// redeploys land within seconds, so the fresh build is itself stale on the
// retry). Those surface here as React.lazy errors like "undefined is not an
// object (evaluating '…_result.default')" / "reading 'default'" / a failed
// dynamic import. As a last resort, reload once more on that signature, with a
// SEPARATE wider guard so a genuinely-broken build still can't reload-loop —
// after the cap it falls through to the crash UI.
const CHUNK_ERROR_RE =
  /_result\.default|reading 'default'|dynamically imported module|importing a module|Failed to fetch|Load failed|ChunkLoadError/i

function isChunkError(error) {
  return CHUNK_ERROR_RE.test(String(error?.message || error || ''))
}

function tryChunkRecovery() {
  const KEY = 'nwbb_chunk_recover_ts'
  const WINDOW_MS = 60000   // wider than the 10s per-route guard
  let last = 0
  try { last = Number(sessionStorage.getItem(KEY) || 0) } catch { /* storage blocked */ }
  if (Date.now() - last > WINDOW_MS) {
    try { sessionStorage.setItem(KEY, String(Date.now())) } catch { /* storage blocked */ }
    window.location.reload()
    return true
  }
  return false
}

function CrashFallback({ error }) {
  // If this looks like a stale-chunk crash, quietly reload to the current build
  // instead of showing the error screen (guarded so it can't loop).
  const recovering = isChunkError(error) && tryChunkRecovery()
  if (recovering) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white px-4">
        <div className="text-gray-500">Updating to the latest version…</div>
      </div>
    )
  }
  return (
    <div className="min-h-screen flex items-center justify-center bg-white px-4">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-bold text-nw-teal dark:text-gray-100 mb-2">Something went wrong</h1>
        <p className="text-gray-600 mb-6">
          We hit an unexpected error and have been notified. Try reloading the page.
          If it keeps happening,{' '}
          <a href="/feature-request" className="text-nw-teal underline hover:text-nw-teal-dark">
            let us know
          </a>{' '}
          so we can take a look.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="px-5 py-2.5 bg-nw-teal text-white rounded-lg font-semibold hover:bg-nw-teal-dark transition-colors"
        >
          Reload
        </button>
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={({ error }) => <CrashFallback error={error} />} showDialog={false}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
)
