/**
 * Inject a Google Fonts stylesheet on demand.
 *
 * The GM game (VT323 + Press Start 2P) and the Coach Portal (Outfit) are
 * the only consumers of their fonts, but index.html used to load them for
 * every visitor on every page. Their shells call this on mount instead.
 *
 * Idempotent: repeated calls with the same id reuse the existing <link>.
 * The link is deliberately NOT removed on unmount — the stylesheet is
 * cached, and removing/re-adding it on every navigation would cause
 * flashes of unstyled text.
 */
export function ensureGoogleFonts(id, familiesQuery) {
  if (typeof document === 'undefined') return
  if (document.getElementById(id)) return
  const link = document.createElement('link')
  link.id = id
  link.rel = 'stylesheet'
  link.href = `https://fonts.googleapis.com/css2?${familiesQuery}&display=swap`
  document.head.appendChild(link)
}
