// Access lists. The site has no paid tiers (September 2026): everything
// built on public data is open to everyone, signed in or not. The only
// remaining distinction is the developer allowlist, which unlocks internal
// tools (commitment editor, in-progress pages, raw TrackMan tables).
//
// Frontend lists are for UI only. The backend mirrors each one
// (_tier_allowlist.py DEVELOPER_EMAILS / COMMITMENT_EDITOR_EMAILS,
// articles.py authors, email_broadcasts.py owners) and enforces them.

// ──────────────────────────────────────────────────────────────
// Developer allowlist
// ──────────────────────────────────────────────────────────────
//
// Anyone whose Supabase account email matches one of these gets developer
// access from useTier(): RequireDev gates pass and dev-only menu items
// show. Lowercased comparison. Add or remove emails here (and in the
// backend mirror); no DB migration needed.
export const DEVELOPER_EMAILS = [
  'nate.rasmussen26@gmail.com',
  'zackaryahn2026@gmail.com',
  'naterpetz@gmail.com',
  'kai.malloch@gmail.com',
  'oliver.duthie1010@gmail.com',
  'connorbroschard@gmail.com',
  'trevorkazahaya@gmail.com',
  'zews2005@outlook.com',
  'pnwcbr@gmail.com',
  'jawomack@bushnell.edu',
  'cameronkundig@gmail.com',
  'tommy.richards@wsu.edu',
  'smith55@uw.edu',
  'willytcell@gmail.com',
  'olearyjoe101@gmail.com',
]

// Commitment Editor — narrower than developer access. Only these accounts may open
// the commitment / portal / freshman / link tools, even though DEVELOPER_EMAILS
// unlocks every other internal tool.
export const COMMITMENT_EDITOR_EMAILS = [
  'nate.rasmussen26@gmail.com',
  'pnwcbr@gmail.com',
]

export function isDeveloper(email) {
  if (!email) return false
  return DEVELOPER_EMAILS.includes(email.toLowerCase())
}

// Site admins — full access to admin-only tools (recruiting guide editor, etc.).
// Mirrors the allowlist in App.jsx's RequireAdmin. Developers are admins too.
export const ADMIN_EMAILS = [
  'nate.rasmussen26@gmail.com',
  'pnwcbr@gmail.com',
]

export function isAdminEmail(email) {
  if (!email) return false
  const e = email.toLowerCase()
  return ADMIN_EMAILS.includes(e) || isDeveloper(e)
}

// Article authors. INTENTIONALLY does NOT include the developer/intern
// list — authoring is granted per-person, separate from the dev tools
// devs can use. Mirror the backend _DEFAULT_AUTHORS / ARTICLE_AUTHOR_EMAILS
// env in articles.py.
export const ARTICLE_AUTHOR_EMAILS = [
  'nate.rasmussen26@gmail.com',
  'pnwcbr@gmail.com',
  'olearyjoe101@gmail.com',
]

// Email broadcasts stay owner-only — a stricter list than article
// authors. Mirror _BROADCAST_OWNER_EMAILS in email_broadcasts.py.
export const BROADCAST_OWNER_EMAILS = [
  'nate.rasmussen26@gmail.com',
  'pnwcbr@gmail.com',
]

export function isArticleAuthor(email) {
  if (!email) return false
  return ARTICLE_AUTHOR_EMAILS.includes(email.toLowerCase())
}
