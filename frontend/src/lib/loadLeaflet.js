// Load Leaflet (CSS + UMD script defining window.L) on demand. It used to be
// a render-blocking <script> in index.html on every page, but only the
// Recruiting Map uses it.
let _promise = null

export function loadLeaflet() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'))
  if (window.L) return Promise.resolve(window.L)
  if (_promise) return _promise
  _promise = new Promise((resolve, reject) => {
    const css = document.createElement('link')
    css.rel = 'stylesheet'
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
    document.head.appendChild(css)
    const s = document.createElement('script')
    s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
    s.async = true
    s.onload = () => resolve(window.L)
    s.onerror = () => { _promise = null; reject(new Error('Leaflet failed to load')) }
    document.head.appendChild(s)
  })
  return _promise
}
