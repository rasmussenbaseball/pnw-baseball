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

function CrashFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-white px-4">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-bold text-pnw-slate mb-2">Something went wrong</h1>
        <p className="text-gray-600 mb-6">
          We hit an unexpected error and have been notified. Try reloading the page.
          If it keeps happening,{' '}
          <a href="/feature-request" className="text-pnw-green underline hover:text-pnw-forest">
            let us know
          </a>{' '}
          so we can take a look.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="px-5 py-2.5 bg-pnw-green text-white rounded-lg font-semibold hover:bg-pnw-forest transition-colors"
        >
          Reload
        </button>
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={<CrashFallback />} showDialog={false}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
)
