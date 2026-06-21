/**
 * Homepage feature widgets — the marketing / product-discovery cards of
 * the June 2026 homepage redesign. All nine build on WidgetShell so the
 * grid reads as one design. Stats-flavored cards stay teal; the product
 * cards (GM, portal, tiers, grid) use their own identities on purpose.
 *
 * Route notes (verified against App.jsx):
 *  - Player profiles live at /player/:playerId (NOT /players/:id).
 *  - /recruiting/rankings is admin-only, so the Recruiting Hub links to
 *    /recruiting-classes (the public-facing class rankings page) instead.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import PixelHeadshot from '../../gm/components/PixelHeadshot'
import {
  WidgetCard, Carousel, PillToggle, GroupLabel, WidgetSkeleton, WidgetNote,
} from './WidgetShell'
import { useApi } from '../../hooks/useApi'
import { DRAFT_DATA, DRAFT_YEARS, getSchoolLogo } from '../../data/draftData'

// "Jun 9" style short date for article / commitment rows.
function fmtShortDate(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch { return '' }
}

// Small teal link chip used across the promo slides.
function LinkChip({ to, children }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold
                 bg-nw-teal/10 text-nw-teal dark:bg-nw-teal/20 dark:text-nw-teal-light
                 hover:bg-nw-teal hover:text-white transition-colors"
    >
      {children} →
    </Link>
  )
}

// ─── 1. MLB Draft Board ─────────────────────────────────────────

export function DraftBoardWidget() {
  const [year, setYear] = useState(DRAFT_YEARS[0])
  const board = DRAFT_DATA[year]
  const prospects = (board?.prospects || []).slice(0, 10)

  return (
    <WidgetCard
      title="MLB Draft Board"
      to="/draftboard"
      linkLabel="Full board"
      controls={
        <PillToggle
          light
          options={DRAFT_YEARS.map(y => ({ value: y, label: `'${y}` }))}
          value={year}
          onChange={setYear}
        />
      }
    >
      {prospects.length === 0 ? (
        <WidgetNote>Rankings for the '{year} class are coming soon.</WidgetNote>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
          {prospects.map(p => {
            const inner = (
              <>
                <span className="w-4 text-[10px] font-bold text-gray-400 tabular-nums shrink-0">{p.rank}</span>
                <img
                  src={getSchoolLogo(p.school)} alt="" loading="lazy"
                  className="w-5 h-5 object-contain shrink-0"
                  onError={(e) => { e.target.style.visibility = 'hidden' }}
                />
                <span className="flex-1 min-w-0">
                  <span className="block text-xs font-semibold text-gray-800 dark:text-gray-100 truncate leading-tight">
                    {p.name}
                  </span>
                  <span className="block text-[10px] text-gray-400 truncate leading-tight">
                    {p.pos} · {p.school}
                  </span>
                </span>
              </>
            )
            const cls = 'flex items-center gap-2 py-0.5'
            return p.playerId ? (
              <Link
                key={`${year}-${p.rank}`}
                to={`/player/${p.playerId}`}
                className={`${cls} hover:bg-nw-cream dark:hover:bg-gray-700/50 rounded px-1 -mx-1`}
              >
                {inner}
              </Link>
            ) : (
              <div key={`${year}-${p.rank}`} className={cls}>{inner}</div>
            )
          })}
        </div>
      )}
    </WidgetCard>
  )
}

// ─── 2. Today's PNW Grid ────────────────────────────────────────

export function GridPreviewWidget() {
  const { data, loading, error } = useApi('/grid/config')
  const columns = data?.columns || []
  const rows = data?.rows || []

  return (
    <WidgetCard title="Today's PNW Grid" to="/pnw-grid" linkLabel="Play today's grid" accent="dark">
      {loading ? (
        <WidgetSkeleton rows={4} />
      ) : error || columns.length === 0 || rows.length === 0 ? (
        <WidgetNote>Today's puzzle isn't loaded yet — tap through to play.</WidgetNote>
      ) : (
        <>
          <div className="grid grid-cols-[minmax(0,5rem)_repeat(3,minmax(0,1fr))] gap-1">
            {/* corner spacer */}
            <div />
            {columns.slice(0, 3).map((c, i) => (
              <div key={`c-${i}`} className="text-[9px] font-bold text-gray-600 dark:text-gray-300 text-center leading-tight truncate self-end pb-0.5">
                {c.label}
              </div>
            ))}
            {rows.slice(0, 3).map((r, ri) => (
              <div key={`r-${ri}`} className="contents">
                <div className="text-[9px] font-bold text-gray-600 dark:text-gray-300 leading-tight truncate self-center text-right pr-1">
                  {r.label}
                </div>
                {[0, 1, 2].map(ci => (
                  <div
                    key={`cell-${ri}-${ci}`}
                    className="h-9 rounded-md bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700
                               flex items-center justify-center text-sm font-bold text-gray-300 dark:text-gray-600"
                  >
                    ?
                  </div>
                ))}
              </div>
            ))}
          </div>
          <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-2">
            New puzzle daily — guess players to fill the grid.
          </p>
        </>
      )}
    </WidgetCard>
  )
}

// ─── 3. Latest Articles ─────────────────────────────────────────

export function ArticlesWidget() {
  const { data, loading, error } = useApi('/articles', { limit: 4 })
  const articles = data?.articles || []
  const gated = (t) => ['premium', 'recruiting', 'coach'].includes(t)

  return (
    <WidgetCard title="Latest Articles" to="/news" linkLabel="All articles">
      {loading ? (
        <WidgetSkeleton rows={4} />
      ) : error ? (
        <WidgetNote>Couldn't load articles right now.</WidgetNote>
      ) : articles.length === 0 ? (
        <WidgetNote>No articles yet — check back soon.</WidgetNote>
      ) : (
        <div className="space-y-1">
          {articles.map(a => (
            <Link
              key={a.id || a.slug}
              to={`/news/${a.slug}`}
              className="flex items-center gap-2 py-1 hover:bg-nw-cream dark:hover:bg-gray-700/50 rounded px-1 -mx-1"
            >
              {a.hero_image_url ? (
                <img
                  src={a.hero_image_url} alt="" loading="lazy"
                  className="w-10 h-10 rounded object-cover shrink-0"
                  onError={(e) => { e.target.style.visibility = 'hidden' }}
                />
              ) : (
                <span className="w-10 h-10 rounded bg-gray-100 dark:bg-gray-700 shrink-0" />
              )}
              <span className="flex-1 min-w-0">
                <span className="block text-xs font-semibold text-gray-800 dark:text-gray-100 leading-tight line-clamp-2">
                  {a.title}
                  {gated(a.requires_tier) && (
                    <span className="ml-1.5 inline-block align-middle text-[8px] font-bold uppercase tracking-wider
                                     px-1 py-px rounded bg-amber-100 text-amber-800
                                     dark:bg-amber-900/50 dark:text-amber-300">
                      Premium
                    </span>
                  )}
                </span>
                <span className="block text-[10px] text-gray-400 leading-tight mt-0.5">
                  {fmtShortDate(a.published_at)}
                </span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </WidgetCard>
  )
}

// ─── 4. Recent Moves (transfer + JUCO portal commitments) ───────

export function RecentMovesWidget() {
  const { data, loading, error } = useApi('/commitments', { level: 'all', limit: 5 })
  const moves = (data?.commitments || []).slice(0, 5)

  return (
    <WidgetCard title="Recent Moves" to="/news/commitments" linkLabel="All commitments">
      {loading ? (
        <WidgetSkeleton rows={5} />
      ) : error ? (
        <WidgetNote>Couldn't load recent moves right now.</WidgetNote>
      ) : moves.length === 0 ? (
        <WidgetNote>No recent commitments yet — check back soon.</WidgetNote>
      ) : (
        <div className="space-y-0.5">
          {moves.map((m) => {
            const juco = m.division_level === 'JUCO'
            const inner = (
              <>
                {m.team_logo ? (
                  <img src={m.team_logo} alt="" loading="lazy" className="w-5 h-5 object-contain shrink-0"
                    onError={(e) => { e.target.style.visibility = 'hidden' }} />
                ) : <span className="w-5 shrink-0" />}
                <span className="flex-1 min-w-0">
                  <span className="block text-xs font-semibold text-gray-800 dark:text-gray-100 truncate leading-tight">
                    {m.first_name} {m.last_name}
                  </span>
                  <span className="block text-[10px] text-gray-400 truncate leading-tight">
                    {m.team_short} → {m.committed_to}
                  </span>
                </span>
                <span className="flex flex-col items-end shrink-0">
                  <span className={`text-[8px] font-bold uppercase tracking-wider px-1 py-px rounded ${
                    juco
                      ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                      : 'bg-nw-teal/10 text-nw-teal dark:bg-nw-teal/20 dark:text-nw-teal-light'
                  }`}>{juco ? 'JUCO' : 'Portal'}</span>
                  <span className="text-[9px] text-gray-400 tabular-nums mt-0.5">{fmtShortDate(m.commitment_date)}</span>
                </span>
              </>
            )
            const cls = 'flex items-center gap-2 py-1'
            return m.player_id ? (
              <Link key={m.player_id} to={`/player/${m.player_id}`}
                className={`${cls} hover:bg-nw-cream dark:hover:bg-gray-700/50 rounded px-1 -mx-1`}>
                {inner}
              </Link>
            ) : (
              <div key={`${m.first_name}-${m.last_name}`} className={cls}>{inner}</div>
            )
          })}
        </div>
      )}
    </WidgetCard>
  )
}

// ─── New on the site (recent additions carousel) ────────────────

function NewBadge() {
  return (
    <span className="text-[8px] font-extrabold uppercase tracking-widest px-1.5 py-0.5 rounded-full
                     bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
      New
    </span>
  )
}

// A 3-slide carousel previewing the most recently added pages. Each slide shows
// a small representative mock of the page + a link. Order = newest first.
// Level chip colors — covers pro levels (MLB/AAA/AA…) and divisions (D1/D2/NAIA).
const LVL_CHIP = {
  MLB: 'bg-emerald-600 text-white',
  AAA: 'bg-blue-600 text-white',
  AA: 'bg-purple-600 text-white',
  'High-A': 'bg-sky-600 text-white', A: 'bg-sky-700 text-white', 'Low-A': 'bg-sky-800 text-white',
  D1: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  D2: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  NAIA: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  D3: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300',
}
const lvlChip = (lvl) => LVL_CHIP[lvl] || 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300'

function SlideHead({ children }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <NewBadge />
      <span className="text-sm font-bold text-gray-800 dark:text-gray-100">{children}</span>
    </div>
  )
}

function PreviewSkeleton({ rows = 3 }) {
  return (
    <div className="space-y-1.5 py-1">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-3 rounded bg-gray-100 dark:bg-gray-700 animate-pulse" />
      ))}
    </div>
  )
}

export function NewFeaturesWidget() {
  // Real data: a few WCL portal players, top PNW pros, and the top class per
  // division. Public/teaser endpoints so it works for every visitor.
  const { data: wcl } = useApi('/wcl-portal/preview', { limit: 3 })
  const { data: pro } = useApi('/pro-alumni')
  const { data: rcD1 } = useApi('/recruiting/classes/top', { level: 'D1', limit: 1 })
  const { data: rcD2 } = useApi('/recruiting/classes/top', { level: 'D2', limit: 1 })
  const { data: rcNAIA } = useApi('/recruiting/classes/top', { level: 'NAIA', limit: 1 })

  const wclPlayers = (wcl?.players || []).slice(0, 3)

  // Flatten the by-school pro list, dedupe by name, MLB first, take 3.
  const seen = new Set()
  const proPlayers = []
  for (const t of (pro?.teams || [])) {
    for (const p of (t.players || [])) {
      if (seen.has(p.name)) continue
      seen.add(p.name); proPlayers.push(p)
    }
  }
  proPlayers.sort((a, b) => (a.level === 'MLB' ? 0 : 1) - (b.level === 'MLB' ? 0 : 1))
  const pros = proPlayers.slice(0, 3)

  const classes = [rcD1, rcD2, rcNAIA].map(d => d?.classes?.[0]).filter(Boolean)

  const slides = [
    // 1. WCL Portal Tracker (newest)
    <div key="wcl" className="min-h-[150px]">
      <SlideHead>WCL Portal Tracker</SlideHead>
      <div className="rounded-lg border border-gray-100 dark:border-gray-700 overflow-hidden mb-2">
        <div className="grid grid-cols-[1fr_auto_auto] gap-2 px-2 py-1 bg-gray-50 dark:bg-gray-900/40 text-[8px] font-bold uppercase tracking-wider text-gray-400">
          <span>Player</span><span>Spring</span><span>WAR</span>
        </div>
        {wclPlayers.length ? wclPlayers.map((p, i) => (
          <div key={i} className="grid grid-cols-[1fr_auto_auto] gap-2 px-2 py-1 text-[10px] border-t border-gray-100 dark:border-gray-700 items-center">
            <span className="text-gray-700 dark:text-gray-300 truncate">{p.name}{p.position ? ` · ${p.position}` : ''}</span>
            <span className="text-gray-400 truncate">{p.school || '—'}</span>
            <span className="font-bold tabular-nums text-nw-teal text-right">{Number(p.war).toFixed(1)}</span>
          </div>
        )) : <div className="p-2"><PreviewSkeleton rows={2} /></div>}
      </div>
      <p className="text-[11px] text-gray-500 dark:text-gray-400 leading-snug mb-2">
        West Coast League players in the transfer portal, shown with their summer (WCL) stats.
      </p>
      <LinkChip to="/coaching/wcl-portal">Open the WCL portal</LinkChip>
    </div>,

    // 2. Pro Tracker
    <div key="pro" className="min-h-[150px]">
      <SlideHead>Pro Tracker</SlideHead>
      <div className="rounded-lg border border-gray-100 dark:border-gray-700 p-2 mb-2 space-y-1.5">
        {pros.length ? pros.map((p, i) => (
          <div key={i} className="flex items-center gap-2 text-[11px]">
            <span className={`text-[8px] font-extrabold px-1.5 py-0.5 rounded shrink-0 ${lvlChip(p.level)}`}>{p.level}</span>
            <span className="flex-1 truncate font-semibold text-gray-800 dark:text-gray-100">{p.name}</span>
            <span className="text-gray-400 truncate max-w-[45%] text-right">{p.current_team}</span>
          </div>
        )) : <PreviewSkeleton rows={3} />}
      </div>
      <p className="text-[11px] text-gray-500 dark:text-gray-400 leading-snug mb-2">
        Every PNW college alum playing pro ball (MiLB + MLB), grouped by school.
      </p>
      <LinkChip to="/pro-tracker">See PNW pros</LinkChip>
    </div>,

    // 3. Recruiting Classes
    <div key="rc" className="min-h-[150px]">
      <SlideHead>Recruiting Classes</SlideHead>
      <div className="rounded-lg border border-gray-100 dark:border-gray-700 p-2 mb-2 space-y-1.5">
        {classes.length ? classes.map((c, i) => (
          <div key={i} className="flex items-center gap-2 text-[11px]">
            <span className={`text-[8px] font-extrabold px-1.5 py-0.5 rounded shrink-0 ${lvlChip(c.division)}`}>{c.division}</span>
            {c.logo_url
              ? <img src={c.logo_url} alt="" className="w-4 h-4 object-contain shrink-0" onError={(e) => { e.target.style.visibility = 'hidden' }} />
              : <span className="w-4 shrink-0" />}
            <span className="flex-1 truncate font-semibold text-gray-800 dark:text-gray-100">{c.short_name}</span>
            <span className="font-bold tabular-nums text-nw-teal">{c.class_score}</span>
          </div>
        )) : <PreviewSkeleton rows={3} />}
      </div>
      <p className="text-[11px] text-gray-500 dark:text-gray-400 leading-snug mb-2">
        The top incoming recruiting class in each division (D1, D2, NAIA).
      </p>
      <LinkChip to="/recruiting-classes">View class rankings</LinkChip>
    </div>,
  ]

  return (
    <WidgetCard title="New on the site" accent="summer">
      <Carousel slides={slides} ariaLabel="Recently added features" />
    </WidgetCard>
  )
}

// ─── 5. PNW Coach Sim (GM game) ─────────────────────────────────

// Example pixel-art player portraits straight from the sim (PixelHeadshot is the
// same component the GM game renders for its generated players). Fixed seeds +
// varied cap/jersey colors so the strip looks like a mixed roster.
const SIM_FACES = [
  { id: 'sim-a', capColor: '#1a2f5e', jerseyColor: '#c8102e' },
  { id: 'sim-b', capColor: '#0a3d2a', jerseyColor: '#f0a000' },
  { id: 'sim-c', capColor: '#3a1010', jerseyColor: '#d8d8d8' },
  { id: 'sim-d', capColor: '#101a3a', jerseyColor: '#5aa0d0' },
  { id: 'sim-e', capColor: '#2a2a2a', jerseyColor: '#fbbf24' },
]

export function GmPreviewWidget() {
  const MODES = [
    ['TRADITIONAL', 'Take over any of the 57 real PNW programs — Gonzaga to Grays Harbor — and build a dynasty.'],
    ['STORY MODE', 'Start as an unknown JUCO assistant. Win, interview, and climb the career ladder to a D1 job.'],
    ['EXPANSION', 'Found a brand-new program from scratch: name, colors, conference, and a startup budget.'],
  ]
  const SYSTEMS = ['Recruiting', 'Player development', 'Budgets', 'Coaching staff',
                   'Academics', 'Summer ball', 'Transfers', 'Lineups & bullpen']
  return (
    <WidgetCard title="PNW Coach Sim" to="/gm" linkLabel="Start your dynasty" accent="pixel">
      <div className="rounded-lg bg-[#1a1a2e] border border-[#3a3a5e] p-3 font-mono">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[9px] font-bold uppercase tracking-widest text-[#fbbf24]">Choose your career</span>
          <span className="w-1.5 h-1.5 rounded-full bg-[#fbbf24] animate-pulse" />
        </div>
        {/* Sample generated players — the sim's own pixel-art portraits */}
        <div className="flex gap-1.5 mb-2.5">
          {SIM_FACES.map((f) => (
            <div key={f.id} className="rounded overflow-hidden border border-[#3a3a5e] bg-[#0f0f1e] shrink-0">
              <PixelHeadshot playerId={f.id} capColor={f.capColor} jerseyColor={f.jerseyColor} size={40} />
            </div>
          ))}
        </div>
        {/* Three ways to play — the game's real headline */}
        <div className="space-y-1.5 mb-2.5">
          {MODES.map(([name, desc]) => (
            <div key={name} className="rounded bg-[#0f0f1e] px-2 py-1.5">
              <div className="text-[10px] font-bold tracking-widest text-[#fbbf24]">▸ {name}</div>
              <div className="text-[10px] text-gray-300 leading-snug">{desc}</div>
            </div>
          ))}
        </div>
        {/* Everything a real coach juggles */}
        <div className="text-[8px] font-bold uppercase tracking-widest text-gray-500 mb-1">You run all of it</div>
        <div className="flex flex-wrap gap-1">
          {SYSTEMS.map(s => (
            <span key={s} className="px-1.5 py-0.5 rounded text-[9px] text-[#fbbf24] border border-[#3a3a5e] bg-[#1a1a2e]">
              {s}
            </span>
          ))}
        </div>
        <div className="mt-2 text-[10px] text-gray-400 leading-snug">
          Play games pitch by pitch with full bullpen control, or sim ahead a week at a time.
        </div>
      </div>
      <div className="flex justify-around mt-2 text-center">
        {[['57', 'Real programs'], ['5', 'Levels'], ['3', 'Game modes'], ['52', 'Week seasons']].map(([v, l]) => (
          <div key={l}>
            <div className="text-sm font-extrabold text-nw-teal dark:text-nw-teal-light tabular-nums">{v}</div>
            <div className="text-[8px] uppercase tracking-wider text-gray-400">{l}</div>
          </div>
        ))}
      </div>
    </WidgetCard>
  )
}

// ─── 6. Coach & Scouting Portal ─────────────────────────────────

export function PortalPreviewWidget() {
  const sheet = [
    ['1B vs RHP', 'Air-pull 38%', 'shade pull'],
    ['CF vs LHP', 'Chase 31%', 'expand away'],
    ['RHP putaway', 'Whiff 41% SL', 'bury 0-2'],
  ]
  return (
    <WidgetCard title="Coach & Scouting Portal" to="/portal" linkLabel="Open the portal" accent="indigo">
      <div className="rounded-lg bg-portal-purple p-2.5 mb-2">
        <div className="text-[8px] font-bold uppercase tracking-widest text-portal-accent-light mb-1.5">
          Scouting Sheet · sample
        </div>
        <table className="w-full text-[10px] text-portal-cream">
          <thead>
            <tr className="text-[8px] uppercase tracking-wider text-portal-cream/50">
              <th className="text-left font-bold pb-0.5">Player</th>
              <th className="text-left font-bold pb-0.5">Tendency</th>
              <th className="text-left font-bold pb-0.5">Edge</th>
            </tr>
          </thead>
          <tbody>
            {sheet.map((row, i) => (
              <tr key={i} className="border-t border-portal-purple-light">
                {row.map((cell, j) => (
                  <td key={j} className="py-0.5 pr-1.5 whitespace-nowrap tabular-nums">{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-1 mb-1.5">
        {['Scouting Sheets', 'Bullpen Cards', 'Lineup Helper', 'Catcher Cards'].map(p => (
          <span
            key={p}
            className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-indigo-50 text-portal-purple
                       dark:bg-indigo-900/40 dark:text-indigo-300"
          >
            {p}
          </span>
        ))}
      </div>
      <p className="text-[11px] text-gray-500 dark:text-gray-400">
        Game-prep PDFs and matchup data built from play-by-play.
      </p>
    </WidgetCard>
  )
}

// ─── 56-0 PNW Draft game ────────────────────────────────────────

export function DraftGameWidget() {
  return (
    <WidgetCard title="56-0 · The PNW Draft" to="/draft" linkLabel="Play 56-0" accent="dark">
      <div className="rounded-lg bg-gradient-to-br from-[#0a2518] to-[#1e5c35] border border-emerald-900/60 p-4 text-center mb-2">
        <div className="text-4xl font-black tracking-tight text-[#e8c96a] leading-none" style={{ fontFamily: 'Georgia, serif' }}>56-0</div>
        <p className="text-[11px] text-emerald-50/90 leading-snug mt-2">
          Spin a team, draft a player, build the best roster in the Pacific Northwest. One shot at a perfect season.
        </p>
      </div>
      <div className="flex flex-wrap gap-1 mb-2">
        {['14 picks', '9 hitters + 5 arms', 'Every PNW team', '5 levels'].map(s => (
          <span key={s} className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-emerald-50 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">{s}</span>
        ))}
      </div>
      <LinkChip to="/draft">Build your roster</LinkChip>
    </WidgetCard>
  )
}

// ─── PNW Pickle (guess the player) ──────────────────────────────

export function PnwPickleWidget() {
  return (
    <WidgetCard title="PNW Pickle" to="/pnw-pickle" linkLabel="Play Pickle" accent="summer">
      <p className="text-[12px] text-gray-600 dark:text-gray-300 leading-snug mb-2">
        Guess the mystery PNW player from the clues: team, position, class, handedness, and stats.
      </p>
      <div className="flex gap-1.5 mb-2">
        {['Team', 'Pos', 'Class', 'B/T', 'Stats'].map(c => (
          <div key={c} className="flex-1 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 py-1.5 text-center">
            <div className="text-sm font-black text-gray-300 dark:text-gray-600 leading-none">?</div>
            <div className="text-[7px] font-bold uppercase tracking-wider text-gray-400 mt-1">{c}</div>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-2">A new player every day. How few guesses do you need?</p>
      <LinkChip to="/pnw-pickle">Guess today's player</LinkChip>
    </WidgetCard>
  )
}

// ─── Games (56-0 + PNW Pickle combined) ─────────────────────────

export function GamesWidget() {
  return (
    <WidgetCard title="Games" accent="dark">
      {/* 56-0 */}
      <Link to="/draft"
        className="block rounded-lg bg-gradient-to-br from-[#0a2518] to-[#1e5c35] border border-emerald-900/60 p-3 text-center mb-2.5 hover:brightness-110 transition">
        <div className="text-3xl font-black tracking-tight text-[#e8c96a] leading-none" style={{ fontFamily: 'Georgia, serif' }}>56-0</div>
        <p className="text-[10px] text-emerald-50/90 leading-snug mt-1.5">
          Draft the best roster in the Pacific Northwest. One shot at a perfect season.
        </p>
        <div className="text-[10px] font-bold text-[#e8c96a] mt-1.5">Play 56-0 →</div>
      </Link>
      {/* PNW Pickle */}
      <Link to="/pnw-pickle"
        className="block rounded-lg border border-gray-200 dark:border-gray-700 p-3 hover:border-nw-teal dark:hover:border-teal-400 transition">
        <div className="font-bold text-sm text-gray-900 dark:text-gray-100">PNW Pickle</div>
        <p className="text-[11px] text-gray-600 dark:text-gray-300 leading-snug mt-1">
          Guess the mystery PNW player from the clues. A new player every day.
        </p>
        <div className="flex gap-1 mt-1.5">
          {['Team', 'Pos', 'Class', 'B/T', 'Stats'].map(c => (
            <div key={c} className="flex-1 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 py-1 text-center">
              <div className="text-xs font-black text-gray-300 dark:text-gray-600 leading-none">?</div>
              <div className="text-[6px] font-bold uppercase tracking-wider text-gray-400 mt-0.5">{c}</div>
            </div>
          ))}
        </div>
        <div className="text-[10px] font-bold text-nw-teal dark:text-teal-300 mt-1.5">Guess today's player →</div>
      </Link>
    </WidgetCard>
  )
}

// ─── Player Comps (PNW ↔ MLB comparables) ───────────────────────

export function ComparablesWidget() {
  // Small random seed → the reverse MLB player rotates each visit (bounded so
  // the backend only caches ~20 variants).
  const [seed] = useState(() => Math.floor(Math.random() * 20))
  const { data } = useApi('/home/comps-showcase', { seed }, [seed])
  const forward = data?.forward || []
  const reverse = data?.reverse

  const pct = (s) => `${Math.round(s)}%`

  const slides = [
    // 1. PNW player → MLB comp
    <div key="fwd" className="min-h-[150px]">
      <GroupLabel className="mb-1.5">Top PNW players, MLB comps</GroupLabel>
      {forward.length ? (
        <div className="space-y-1 mb-2">
          {forward.map((f, i) => (
            <Link key={i} to={`/player-comps?player_id=${f.player.id}&pool=mlb&side=${f.player.side}`}
              className="block py-1 px-1 -mx-1 rounded hover:bg-nw-cream dark:hover:bg-gray-700/50">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-gray-800 dark:text-gray-100 truncate">{f.player.name}</span>
                <span className="text-[10px] font-bold text-nw-teal tabular-nums shrink-0">{pct(f.comp.score)} match</span>
              </div>
              <div className="text-[10px] text-gray-500 dark:text-gray-400 truncate">≈ {f.comp.name}{f.comp.team ? ` · ${f.comp.team}` : ''}</div>
            </Link>
          ))}
        </div>
      ) : <WidgetSkeleton rows={3} />}
      <LinkChip to="/player-comps">Compare any player</LinkChip>
    </div>,

    // 2. MLB player → closest PNW players (rotates per visit)
    <div key="rev" className="min-h-[150px]">
      <GroupLabel className="mb-1.5">An MLB hitter's closest PNW comps</GroupLabel>
      {reverse ? (
        <div className="mb-2">
          <div className="text-xs font-bold text-gray-800 dark:text-gray-100 mb-1">
            {reverse.mlb.name}
            <span className="text-[10px] font-normal text-gray-400 ml-1.5">{reverse.mlb.team}{reverse.mlb.season ? ` · ${reverse.mlb.season}` : ''}</span>
          </div>
          <div className="space-y-0.5">
            {reverse.comps.map((c, i) => (
              <Link key={i} to={`/player/${c.id}`}
                className="flex items-center justify-between gap-2 py-0.5 px-1 -mx-1 rounded text-[11px] hover:bg-nw-cream dark:hover:bg-gray-700/50">
                <span className="truncate text-gray-700 dark:text-gray-300">
                  {c.name}{c.team ? <span className="text-gray-400"> · {c.team}</span> : ''}
                </span>
                <span className="text-nw-teal font-bold tabular-nums shrink-0">{pct(c.score)}</span>
              </Link>
            ))}
          </div>
        </div>
      ) : <WidgetSkeleton rows={4} />}
      <LinkChip to="/player-comps">Find PNW comps</LinkChip>
    </div>,
  ]

  return (
    <WidgetCard title="Player Comps" to="/player-comps" linkLabel="Comp tool" accent="indigo">
      <Carousel slides={slides} ariaLabel="Player comparables" />
    </WidgetCard>
  )
}

// ─── 9. Choose Your Tier ────────────────────────────────────────

// Mirrors the real tier data in pages/Pricing.jsx — keep in sync.
const TIER_STRIP = [
  {
    name: 'Free', price: '$0',
    features: ['PNW Grid + Team Quiz', 'Percentiles, Records & more'],
  },
  {
    name: 'Premium', price: '$5/mo', popular: true,
    features: ['NW Coaching Simulator', 'Recruiting guides + Draft Board'],
  },
  {
    name: 'Recruiting', price: '$10/mo',
    features: ['JUCO + Transfer Portal trackers', 'Commitments tracker'],
  },
  {
    name: 'Coach & Scout', price: '$25/mo',
    features: ['Full scouting portal', 'Printable PDFs + CSV exports'],
  },
]

export function TiersWidget({ className = '' }) {
  return (
    <WidgetCard title="Choose Your Tier" to="/pricing" linkLabel="Compare plans" accent="gold" className={className}>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {TIER_STRIP.map(t => (
          <div
            key={t.name}
            className={`relative rounded-lg border p-2.5 ${
              t.popular
                ? 'border-nw-teal ring-1 ring-nw-teal/40'
                : 'border-gray-200 dark:border-gray-700'
            }`}
          >
            {t.popular && (
              <span className="absolute -top-2 right-2 px-1.5 py-px rounded-full text-[8px] font-bold uppercase
                               tracking-wider bg-nw-teal text-white">
                Popular
              </span>
            )}
            <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {t.name}
            </div>
            <div className="text-sm font-extrabold text-gray-900 dark:text-gray-100 tabular-nums mb-1">
              {t.price}
            </div>
            <ul className="space-y-0.5">
              {t.features.map(f => (
                <li key={f} className="flex items-start gap-1 text-[10px] text-gray-600 dark:text-gray-300 leading-snug">
                  <span className="text-nw-teal mt-px">✓</span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </WidgetCard>
  )
}
