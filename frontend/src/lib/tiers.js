// Subscription tier matrix — the single source of truth for what
// each tier gets access to. Used by:
//   • <RequireTier> component (gate a route by minimum tier)
//   • useTier() hook (read current user's tier in components)
//   • /pricing page (display tier features)
//   • Future: backend mirror for API gating (do NOT trust the client)
//
// Tier ladder (lowest → highest):
//
//   ┌──────────┬─────────────┬─────────────────────────────────────┐
//   │  Slug    │ Price       │ Who                                 │
//   ├──────────┼─────────────┼─────────────────────────────────────┤
//   │ none     │ $0          │ Anonymous visitor (not signed in)   │
//   │ free     │ $0          │ Signed-in free account              │
//   │ premium  │ $5 / month  │ Paid subscriber, full public access │
//   │ coach    │ $25 / month │ Coach / scout — portal access too   │
//   └──────────┴─────────────┴─────────────────────────────────────┘
//
// IMPORTANT: This file is FRONTEND-only and is for UI rendering /
// route gating UX. It is NOT a security boundary on its own. The
// canonical decision MUST also be enforced server-side (e.g. inside
// the FastAPI route or the cached_endpoint decorator) before any
// premium / coach data is returned. Hiding pages in JS is just polish.

// ──────────────────────────────────────────────────────────────
// Tier definitions
// ──────────────────────────────────────────────────────────────

export const TIERS = ['none', 'free', 'premium', 'recruiting', 'coach', 'dev']

// Display metadata for each tier.
// `dev` is a hidden internal tier above coach. It's not sold and is
// never shown on /pricing or the signup popup; it exists so site
// developers and interns (DEVELOPER_EMAILS below) can bypass every
// gate and preview in-progress features. tierMeets() naturally handles
// it because dev's rank is the highest.
export const TIER_META = {
  none:       { label: 'Anonymous',     short: 'Anon',    rank: 0 },
  free:       { label: 'Free',          short: 'Free',    rank: 1 },
  premium:    { label: 'Premium',       short: 'Premium', rank: 2 },
  recruiting: { label: 'Recruiting',    short: 'Recruit', rank: 3 },
  coach:      { label: 'Coach & Scout', short: 'Coach',   rank: 4 },
  dev:        { label: 'Developer',     short: 'Dev',     rank: 99 },
}


// ──────────────────────────────────────────────────────────────
// Developer allowlist
// ──────────────────────────────────────────────────────────────
//
// Anyone whose Supabase account email matches one of these gets the
// `dev` tier from useTier(), bypassing every RequireTier gate AND
// seeing items the menu hides from non-devs (requires: 'dev').
//
// Lowercased comparison. Add or remove emails here; no DB migration
// needed. Site developers + interns only.
export const DEVELOPER_EMAILS = [
  'nate.rasmussen26@gmail.com',
  'zackaryahn2026@gmail.com',
  'naterpetz@gmail.com',
  'kai.malloch@gmail.com',
  'oliver.duthie1010@gmail.com',
  'connorbroschard@gmail.com',
  'trevorkazahaya@gmail.com',
  'zews2005@outlook.com',
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


/**
 * Compare tiers: returns true if `actual` is at-or-above `required`.
 * E.g. tierMeets('premium', 'free') === true.
 */
export function tierMeets(actual, required) {
  const a = TIER_META[actual]?.rank ?? -1
  const r = TIER_META[required]?.rank ?? -1
  return a >= r
}


// ──────────────────────────────────────────────────────────────
// Feature → minimum tier mapping
// ──────────────────────────────────────────────────────────────
//
// Names here are LOGICAL FEATURES, not route paths. Multiple routes
// can map to the same feature. Route-to-feature mapping below.
//
// Keep this in sync with /pricing (Pricing.jsx FEATURES array). If
// a tier moves here, the public-facing page should reflect it too.

export const FEATURE_MIN_TIER = {
  // ─── NONE (anonymous browsing) ─────────────────────────────
  homepage:               'none',
  scoreboard:             'none',
  standings:              'none',
  stat_leaders:           'none',
  hitting_leaderboard:    'none',
  pitching_leaderboard:   'none',
  player_page_basic:      'none',
  team_page:              'none',
  team_stats:             'none',
  national_rankings:      'none',
  team_ratings:           'none',
  articles_free:          'none',  // free-tier articles
  news_list:              'none',
  game_detail:            'none',
  team_history:           'none',
  scatter_plot:           'none',
  about:                  'none',
  feature_request:        'none',
  pricing:                'none',
  login:                  'none',
  unsubscribe:            'none',  // token-based, no auth needed

  // ─── FREE (signed-in, free account) ─────────────────────────
  player_page_advanced:   'free',  // savant pages, percentiles, WAR breakdowns
  favorites:              'free',  // save players & teams
  newsletter:             'free',  // opt-in to broadcasts
  account_page:           'free',
  summerball:             'free',
  percentiles:            'free',
  records:                'free',
  playoff_projections:    'free',
  team_compare:           'free',
  war_leaderboard:        'free',

  // ─── PREMIUM ($5/mo) ───────────────────────────────────────
  articles_premium:       'premium',  // paywalled article bodies
  recruiting_classes:     'premium',
  recruiting_breakdown:   'premium',
  recruiting_hometown:    'premium',
  draft_board:            'premium',
  park_factors:           'premium',
  historic_matchups:      'premium',
  gm_simulator:           'premium',  // /gm/* — coaching simulator

  // ─── RECRUITING ($10/mo) — everything Premium + the recruiting
  // tools, aimed at college coaches. No Coach & Scout portal. ──
  commitments:            'recruiting',
  juco_tracker:           'recruiting',
  transfer_portal:        'recruiting',

  // ─── COACH & SCOUT ($25/mo) — portal + extras ─────────────
  portal_home:            'coach',
  portal_opponent_trends: 'coach',
  portal_lineup_helper:   'coach',
  portal_team_scouting:   'coach',
  portal_historic:        'coach',  // portal-wrapped historic matchups
  portal_player_scouting: 'coach',
  portal_player_pdfs:     'coach',  // all printable PDF pickers + cards
  portal_scouting_sheet:  'coach',
  portal_bullpen_sheet:   'coach',
  portal_catcher_cards:   'coach',
  portal_juco_tracker:    'coach',  // moved from premium 2026-05-25
  portal_all_conference:  'coach',
  portal_trackman:        'coach',  // coming soon
}


// ──────────────────────────────────────────────────────────────
// Route → feature mapping
// ──────────────────────────────────────────────────────────────
//
// Used by <RequireTier> when called with a route, and by future
// tooling that crawls App.jsx for unprotected routes.
//
// Patterns ending in :id / :slug / etc. are matched by prefix. Order
// matters — first match wins. Leave routes that aren't on this list
// as `none` (publicly visible) by default; that's the safer default
// for an evolving codebase. New paid features must be added here.

export const ROUTE_FEATURE = [
  // Public
  ['/',                       'homepage'],
  ['/hitting',                'hitting_leaderboard'],
  ['/pitching',               'pitching_leaderboard'],
  ['/war',                    'war_leaderboard'],
  ['/team-stats',             'team_stats'],
  ['/stat-leaders',           'stat_leaders'],
  ['/teams',                  'team_page'],
  ['/team/:teamId',           'team_page'],
  ['/standings',              'standings'],
  ['/scoreboard',             'scoreboard'],
  ['/results',                'scoreboard'],
  ['/game/:gameId',           'game_detail'],
  ['/national-rankings',      'national_rankings'],
  ['/team-ratings',           'team_ratings'],
  ['/team-history',           'team_history'],
  ['/scatter',                'scatter_plot'],
  ['/news',                   'news_list'],
  ['/news/:slug',             'articles_free'],     // some are premium — gating decided at article level
  ['/news/commitments',       'commitments'],
  ['/about',                  'about'],
  ['/feature-request',        'feature_request'],
  ['/pricing',                'pricing'],
  ['/login',                  'login'],
  ['/unsubscribe',            'unsubscribe'],

  // Player page is public but its ADVANCED tab is FREE — that's a
  // mid-page gate, handled in the component itself, not here.
  ['/player/:playerId',       'player_page_basic'],

  // Free
  ['/account',                'account_page'],
  ['/favorites',              'favorites'],
  ['/percentiles',            'percentiles'],
  ['/records',                'records'],
  ['/playoff-projections',    'playoff_projections'],
  ['/summerball',             'summerball'],
  ['/compare',                'team_compare'],

  // Premium
  ['/recruiting-classes',         'recruiting_classes'],
  ['/recruiting/breakdown',       'recruiting_breakdown'],
  ['/recruiting/hometown',        'recruiting_hometown'],
  ['/draftboard',                 'draft_board'],
  ['/draftboard/2026',            'draft_board'],
  ['/draftboard/2027',            'draft_board'],
  ['/draftboard/2028',            'draft_board'],
  ['/park-factors',               'park_factors'],
  ['/historic',                   'historic_matchups'],
  ['/opponent-trends',            'historic_matchups'],
  ['/gm',                         'gm_simulator'],

  // Recruiting tier
  ['/coaching/juco-tracker',      'juco_tracker'],
  ['/coaching/transfer-portal',   'transfer_portal'],

  // Coach & Scout (portal)
  ['/portal',                     'portal_home'],
  ['/portal/trends',              'portal_opponent_trends'],
  ['/portal/lineup-helper',       'portal_lineup_helper'],
  ['/portal/team-scouting',       'portal_team_scouting'],
  ['/portal/historic',            'portal_historic'],
  ['/portal/player-scouting',     'portal_player_scouting'],
  ['/portal/pdfs',                'portal_player_pdfs'],
  ['/portal/scouting-sheet',      'portal_scouting_sheet'],
  ['/portal/bullpen-sheet',       'portal_bullpen_sheet'],
  ['/portal/catcher-cards',       'portal_catcher_cards'],
  ['/portal/juco-tracker',        'portal_juco_tracker'],
]


/**
 * Look up the minimum tier needed to access a route path.
 * Defaults to 'none' for unmatched paths — safer for new public pages.
 */
export function tierForRoute(pathname) {
  // Try exact match first, then prefix.
  for (const [pattern, feature] of ROUTE_FEATURE) {
    // Convert :param segments to a simple wildcard for matching.
    const re = new RegExp('^' + pattern.replace(/:[\w]+/g, '[^/]+') + '$')
    if (re.test(pathname)) return FEATURE_MIN_TIER[feature] || 'none'
  }
  return 'none'
}
