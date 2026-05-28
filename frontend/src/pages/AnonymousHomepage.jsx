// AnonymousHomepage — the homepage that anonymous (signed-out) visitors
// see. Goal: drive free-account signups. Style: hero + interleaved CTAs.
//
// Architecture note: App.jsx route conditionally renders this when
// `!user`. When the visitor is signed in, the existing Homepage
// (the dashboard with live widgets) renders instead. This sets up
// a clean pattern for future per-tier homepages (Free, Premium,
// Coach all get their own variant of /).

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  useBattingLeaderboard, usePitchingLeaderboard, useTeams,
} from '../hooks/useApi'
import { usePublishedArticles } from '../hooks/useArticles'
import PreviewTierWidget from '../components/PreviewTierWidget'

const SEASON = 2026

// Lower Columbia team_id for 2026 NWAC champ card.
const LCC_TEAM_ID = 52
const LCC_LOGO = '/logos/nwac/lower_columbia.png'

export default function AnonymousHomepage() {
  return (
    <div className="-mx-2 sm:-mx-4">
      {/* Author-only "view as tier" toggle (renders nothing for normal
          anonymous visitors). Inset above the full-bleed hero so the
          dev can switch tiers while building per-tier homepages. */}
      <div className="px-4 sm:px-6 lg:px-8 max-w-6xl mx-auto">
        <PreviewTierWidget />
      </div>
      <HeroSection />

      <div className="px-4 sm:px-6 lg:px-8 max-w-6xl mx-auto py-8 sm:py-12 space-y-12">
        <ByTheNumbersStrip />
        <TeamCoverageWall />
        <SeasonInReviewSection />
        <FreeToolsShowcase />
        <WhatsNextCard />
        <LockTeaseCta />
        <FeaturedArticles />
        <ClosingCtaWithFounder />
      </div>
    </div>
  )
}


// ============================================================
// HERO
// ============================================================
function HeroSection() {
  return (
    <section
      className="relative overflow-hidden text-white"
      style={{
        background:
          'linear-gradient(135deg, #003845 0%, #00687a 45%, #008ba6 100%)',
      }}
    >
      {/* Decorative diamond grid — subtle, evokes the field */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.06] pointer-events-none"
        style={{
          backgroundImage:
            'radial-gradient(circle at 1px 1px, white 1px, transparent 0)',
          backgroundSize: '24px 24px',
        }}
      />

      <div className="relative max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-24 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 mb-5 rounded-full bg-white/10 backdrop-blur border border-white/15 text-[11px] font-semibold uppercase tracking-[2px] text-amber-300">
          Pacific Northwest Baseball
        </div>

        <h1 className="text-3xl sm:text-5xl lg:text-6xl font-extrabold leading-[1.05] mb-5 tracking-tight">
          Northwest baseball,<br className="hidden sm:block" />{' '}
          <span className="text-amber-300">deeply analyzed.</span>
        </h1>

        <p className="text-base sm:text-xl text-white/85 max-w-2xl mx-auto leading-relaxed mb-8">
          Every D1, D2, D3, NAIA, and NWAC team in the PNW. FanGraphs and
          Baseball Savant-style advanced metrics for{' '}
          <span className="font-semibold text-white">11,000+ players</span>{' '}
          across <span className="font-semibold text-white">9 seasons</span>.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-3 mb-6">
          <Link
            to="/auth?mode=signup"
            className="px-6 py-3 rounded-lg bg-amber-400 text-[#003845] font-bold text-base hover:bg-amber-300 transition-colors shadow-lg"
          >
            Create free account
          </Link>
          <a
            href="#explore"
            className="px-6 py-3 rounded-lg bg-white/10 backdrop-blur border border-white/20 text-white font-semibold text-base hover:bg-white/20 transition-colors"
          >
            Explore as guest
          </a>
        </div>

        <p className="text-[11px] text-white/55 uppercase tracking-wider">
          Free forever. No credit card. Built by a coach, scout, and former pitcher.
        </p>
      </div>
    </section>
  )
}


// ============================================================
// BY THE NUMBERS
// ============================================================
function ByTheNumbersStrip() {
  const [stats, setStats] = useState(null)
  useEffect(() => {
    fetch('/api/v1/site-stats')
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {})
  }, [])

  const fmt = (n) => {
    if (n == null) return '...'
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
    if (n >= 10_000) return (n / 1_000).toFixed(0) + 'K'
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
    return n.toLocaleString()
  }

  const chips = [
    { label: 'Players',    value: fmt(stats?.total_players) },
    { label: 'Games',      value: fmt(stats?.total_games) },
    { label: 'HR tracked', value: fmt(stats?.total_home_runs) },
    { label: 'PBP events', value: fmt(stats?.total_pbp_events) },
    { label: 'Seasons',    value: fmt(stats?.seasons_tracked) },
  ]

  return (
    <div id="explore" className="grid grid-cols-2 sm:grid-cols-5 gap-3 -mt-12 sm:-mt-16 relative z-10">
      {chips.map((c) => (
        <div
          key={c.label}
          className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 px-4 py-3 sm:py-4 text-center"
        >
          <div className="text-2xl sm:text-3xl font-extrabold text-nw-teal tabular-nums">
            {c.value}
          </div>
          <div className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mt-0.5">
            {c.label}
          </div>
        </div>
      ))}
    </div>
  )
}


// ============================================================
// 2026 SEASON IN REVIEW
// ============================================================
function SeasonInReviewSection() {
  const { data: batting } = useBattingLeaderboard({
    season: SEASON, sort_by: 'offensive_war', sort_dir: 'desc', limit: 1, qualified: true,
  })
  const { data: pitching } = usePitchingLeaderboard({
    season: SEASON, sort_by: 'pitching_war', sort_dir: 'desc', limit: 1, qualified: true,
  })
  const topBatter = batting?.data?.[0]
  const topPitcher = pitching?.data?.[0]

  const fmtAvg = (v) =>
    v == null ? '-' : (v >= 1 ? v.toFixed(3) : v.toFixed(3).replace(/^0/, ''))
  const fmtIp = (v) => (v == null ? '-' : Number(v).toFixed(1))

  const hitterStats = topBatter ? [
    { label: 'AVG', value: fmtAvg(topBatter.batting_avg) },
    { label: 'HR', value: topBatter.home_runs ?? 0 },
    { label: 'RBI', value: topBatter.rbi ?? 0 },
    { label: 'OPS', value: fmtAvg(topBatter.ops) },
    { label: 'wRC+', value: Math.round(topBatter.wrc_plus ?? 0) },
    { label: 'WAR', value: (topBatter.offensive_war ?? 0).toFixed(1), highlight: true },
  ] : []

  const pitcherStats = topPitcher ? [
    { label: 'ERA', value: (topPitcher.era ?? 0).toFixed(2) },
    { label: 'SO', value: topPitcher.strikeouts ?? 0 },
    { label: 'IP', value: fmtIp(topPitcher.innings_pitched) },
    { label: 'WHIP', value: (topPitcher.whip ?? 0).toFixed(2) },
    { label: 'ERA+', value: Math.round(topPitcher.era_plus ?? 0) },
    { label: 'WAR', value: (topPitcher.pitching_war ?? 0).toFixed(1), highlight: true },
  ] : []

  return (
    <section>
      <SectionHeading
        eyebrow="2026 Season"
        title="The year in review"
        sub="The most-decorated players and the biggest moment of the spring."
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <NwacChampionCard />
        <PlayerHighlightCard
          eyebrow="Hitter of the Year"
          player={topBatter}
          stats={hitterStats}
        />
        <PlayerHighlightCard
          eyebrow="Pitcher of the Year"
          player={topPitcher}
          stats={pitcherStats}
        />
      </div>
    </section>
  )
}

// NWAC champion card — the school's actual logo + a quick numeric
// snapshot from the tournament instead of a trophy emoji.
function NwacChampionCard() {
  return (
    <Link
      to={`/team/${LCC_TEAM_ID}`}
      className="group rounded-xl bg-gradient-to-br from-amber-50 to-amber-100 dark:from-amber-900/30 dark:to-amber-900/10 border border-amber-200 dark:border-amber-800/40 p-5 flex flex-col h-full hover:border-amber-400 dark:hover:border-amber-600 transition-colors"
    >
      <div className="text-[10px] font-semibold uppercase tracking-[2px] text-amber-700 dark:text-amber-300 mb-3">
        2026 NWAC Champion
      </div>
      <div className="flex items-center gap-3 mb-3">
        <img
          src={LCC_LOGO}
          alt=""
          className="w-16 h-16 object-contain shrink-0 drop-shadow-sm"
          onError={(e) => { e.target.style.display = 'none' }}
        />
        <div className="min-w-0 flex-1">
          <div className="text-xl sm:text-2xl font-extrabold text-gray-900 dark:text-gray-100 leading-tight group-hover:text-amber-700 dark:group-hover:text-amber-300 transition-colors">
            Lower Columbia
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            Red Devils
          </div>
        </div>
      </div>

      <div className="flex gap-2 mt-1 mb-3">
        <div className="flex-1 bg-white/60 dark:bg-gray-800/60 rounded-md p-2 text-center">
          <div className="text-xl font-extrabold text-amber-700 dark:text-amber-300 tabular-nums">16</div>
          <div className="text-[9px] uppercase tracking-wider text-gray-500 dark:text-gray-400 font-semibold">titles</div>
        </div>
        <div className="flex-1 bg-white/60 dark:bg-gray-800/60 rounded-md p-2 text-center">
          <div className="text-xl font-extrabold text-amber-700 dark:text-amber-300 tabular-nums">MVP</div>
          <div className="text-[9px] uppercase tracking-wider text-gray-500 dark:text-gray-400 font-semibold">Kennedy</div>
        </div>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mt-auto">
        16th NWAC title in school history. Catcher Jaylen Kennedy named tournament MVP.
      </p>
    </Link>
  )
}

function PlayerHighlightCard({ eyebrow, player, stats = [] }) {
  if (!player) {
    return (
      <div className="rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-5 animate-pulse">
        <div className="h-3 w-20 bg-gray-200 dark:bg-gray-700 rounded mb-3" />
        <div className="h-6 w-3/4 bg-gray-200 dark:bg-gray-700 rounded mb-3" />
        <div className="grid grid-cols-3 gap-2">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-10 bg-gray-100 dark:bg-gray-700/60 rounded" />
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-5 flex flex-col h-full">
      <div className="text-[10px] font-semibold uppercase tracking-[2px] text-nw-teal mb-3">
        {eyebrow}
      </div>
      <div className="flex items-center gap-3 mb-4">
        {player.headshot_url ? (
          <img
            src={player.headshot_url}
            alt=""
            className="w-14 h-14 rounded-full object-cover ring-1 ring-gray-200 dark:ring-gray-700"
            onError={(e) => { e.target.style.display = 'none' }}
          />
        ) : (
          <div className="w-14 h-14 rounded-full bg-nw-teal/15 dark:bg-nw-teal/25 flex items-center justify-center text-nw-teal font-bold text-lg">
            {(player.first_name?.[0] || '?')}{(player.last_name?.[0] || '')}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <Link
            to={`/player/${player.id || player.player_id}`}
            className="block text-lg font-extrabold text-gray-900 dark:text-gray-100 leading-tight hover:text-nw-teal truncate"
          >
            {player.first_name} {player.last_name}
          </Link>
          <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 truncate">
            {player.logo_url && (
              <img src={player.logo_url} alt="" className="w-4 h-4 object-contain shrink-0"
                onError={(e) => { e.target.style.display = 'none' }} />
            )}
            <span className="truncate">
              {player.team_short || player.team_name} · {player.division_level}
              {player.year_in_school ? ` · ${player.year_in_school}` : ''}
            </span>
          </div>
        </div>
      </div>

      {/* Full stat line — 3-col grid, WAR highlighted */}
      <div className="grid grid-cols-3 gap-2 mt-auto">
        {stats.map((s) => (
          <div
            key={s.label}
            className={`rounded-lg px-2 py-2 text-center ${
              s.highlight
                ? 'bg-nw-teal/10 dark:bg-nw-teal/20'
                : 'bg-gray-50 dark:bg-gray-900/40'
            }`}
          >
            <div className={`text-base sm:text-lg font-extrabold tabular-nums leading-none ${
              s.highlight ? 'text-nw-teal' : 'text-gray-900 dark:text-gray-100'
            }`}>
              {s.value}
            </div>
            <div className="text-[9px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mt-1">
              {s.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}


// ============================================================
// FREE TOOLS SHOWCASE
// ============================================================
function FreeToolsShowcase() {
  return (
    <section>
      <SectionHeading
        eyebrow="Free, no sign-up required"
        title="Start exploring"
        sub="Every tile below works for anonymous visitors. Sign up later to favorite players and personalize your view."
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ToolTileLeaderboards />
        <ToolTileFielding />
        <ToolTileTeams />
        <ToolTileGlossary />
      </div>
    </section>
  )
}

function ToolTile({ to, title, desc, children }) {
  return (
    <Link
      to={to}
      className="group bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 sm:p-5 hover:border-nw-teal hover:shadow-md transition-all flex flex-col h-full"
    >
      <div className="mb-3 sm:mb-4">{children}</div>
      <div className="mt-auto">
        <div className="text-base sm:text-lg font-bold text-gray-900 dark:text-gray-100 mb-1 group-hover:text-nw-teal transition-colors">
          {title}
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
          {desc}
        </p>
      </div>
    </Link>
  )
}

// Mini WAR leaderboard preview — actual top 3 from the live endpoint.
function ToolTileLeaderboards() {
  const { data: lb } = useBattingLeaderboard({
    season: SEASON, sort_by: 'offensive_war', sort_dir: 'desc',
    limit: 3, qualified: true,
  })
  const rows = lb?.data || []
  return (
    <ToolTile
      to="/hitting"
      title="Leaderboards"
      desc="Hitting, pitching, and fielding leaders across every division."
    >
      <div className="rounded-lg bg-gray-50 dark:bg-gray-900/40 border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="bg-pnw-slate text-white text-[10px] font-semibold uppercase tracking-wider px-3 py-1.5 flex justify-between">
          <span>2026 WAR Leaders</span>
          <span>WAR</span>
        </div>
        <div className="divide-y divide-gray-100 dark:divide-gray-700">
          {rows.length === 0 && [0, 1, 2].map((i) => (
            <div key={i} className="px-3 py-2 animate-pulse">
              <div className="h-3 w-2/3 bg-gray-200 dark:bg-gray-700 rounded" />
            </div>
          ))}
          {rows.map((r, i) => (
            <div key={r.player_id || i} className="px-3 py-2 flex items-center gap-2">
              <span className="text-[10px] font-bold text-gray-400 w-3">{i + 1}</span>
              {r.logo_url && (
                <img src={r.logo_url} alt="" className="w-4 h-4 object-contain shrink-0"
                  onError={(e) => { e.target.style.display = 'none' }} />
              )}
              <span className="text-xs font-semibold text-gray-800 dark:text-gray-100 truncate flex-1">
                {r.first_name} {r.last_name}
              </span>
              <span className="text-xs font-mono font-bold text-nw-teal tabular-nums">
                {(r.offensive_war ?? 0).toFixed(1)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </ToolTile>
  )
}

// Mini fielding leaderboard preview — Best NAIA shortstops by FLD%.
// Showcases the brand-new fielding leaderboard with a real-world slice.
function ToolTileFielding() {
  const [rows, setRows] = useState([])
  useEffect(() => {
    fetch(`/api/v1/leaderboards/fielding?season=${SEASON}&position=SS&division_id=4&min_games=10&limit=3`)
      .then((r) => r.json())
      .then((d) => setRows(d?.data || []))
      .catch(() => {})
  }, [])
  return (
    <ToolTile
      to="/fielding"
      title="Fielding Leaderboards"
      desc="Per-position defense for every level. Filter by position or division."
    >
      <div className="rounded-lg bg-gray-50 dark:bg-gray-900/40 border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="bg-pnw-slate text-white text-[10px] font-semibold uppercase tracking-wider px-3 py-1.5 flex justify-between">
          <span>NAIA SS by FLD%</span>
          <span>FLD%</span>
        </div>
        <div className="divide-y divide-gray-100 dark:divide-gray-700">
          {rows.length === 0 && [0, 1, 2].map((i) => (
            <div key={i} className="px-3 py-2 animate-pulse">
              <div className="h-3 w-2/3 bg-gray-200 dark:bg-gray-700 rounded" />
            </div>
          ))}
          {rows.map((r, i) => (
            <div key={r.player_id || i} className="px-3 py-2 flex items-center gap-2">
              <span className="text-[10px] font-bold text-gray-400 w-3">{i + 1}</span>
              {r.logo_url && (
                <img src={r.logo_url} alt="" className="w-4 h-4 object-contain shrink-0"
                  onError={(e) => { e.target.style.display = 'none' }} />
              )}
              <span className="text-xs font-semibold text-gray-800 dark:text-gray-100 truncate flex-1">
                {r.first_name} {r.last_name}
              </span>
              <span className="text-xs font-mono font-bold text-nw-teal tabular-nums">
                {r.fielding_pct != null
                  ? (r.fielding_pct >= 1 ? r.fielding_pct.toFixed(3) : r.fielding_pct.toFixed(3).replace('0.', '.'))
                  : '-'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </ToolTile>
  )
}

// Team-pages tile shows a small grid of REAL logos so the user
// immediately understands what "57 teams" looks like visually.
function ToolTileTeams() {
  const { data: teams } = useTeams({ season: SEASON })
  // Cap at 12 logos for the tile preview, prefer ones with logo_url.
  const sample = (teams || [])
    .filter((t) => t.logo_url)
    .slice(0, 12)
  return (
    <ToolTile
      to="/teams"
      title="Team Pages"
      desc="Rosters, schedules, splits, and advanced stats for every PNW program."
    >
      <div className="rounded-lg bg-gray-50 dark:bg-gray-900/40 border border-gray-100 dark:border-gray-700 p-3">
        <div className="grid grid-cols-6 gap-1.5">
          {sample.length === 0 && [...Array(12)].map((_, i) => (
            <div key={i} className="aspect-square bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
          ))}
          {sample.map((t) => (
            <div key={t.id} className="aspect-square bg-white dark:bg-gray-800 rounded border border-gray-100 dark:border-gray-700 flex items-center justify-center p-1">
              <img
                src={t.logo_url}
                alt={t.short_name || t.name}
                className="w-full h-full object-contain"
                onError={(e) => { e.target.style.display = 'none' }}
                loading="lazy"
              />
            </div>
          ))}
        </div>
      </div>
    </ToolTile>
  )
}

// Glossary tile shows a real stat-definition snippet so the
// "every metric defined" claim is immediately concrete.
function ToolTileGlossary() {
  return (
    <ToolTile
      to="/about#glossary"
      title="Stat Glossary"
      desc="Every metric on the site defined, with formulas."
    >
      <div className="rounded-lg bg-gray-50 dark:bg-gray-900/40 border border-gray-100 dark:border-gray-700 p-3 space-y-2.5">
        <GlossaryRow term="wRC+"
          formula="100 = league avg · 150 = elite"
          desc="Weighted Runs Created plus." />
        <GlossaryRow term="FIP"
          formula="13·HR + 3·(BB+HBP) − 2·K / IP + cFIP"
          desc="Fielding Independent Pitching." />
        <GlossaryRow term="WAR"
          formula="Replacement-level wins added"
          desc="Wins Above Replacement." />
      </div>
    </ToolTile>
  )
}

function GlossaryRow({ term, formula, desc }) {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-mono font-bold text-nw-teal">{term}</span>
        <span className="text-[10px] text-gray-500 dark:text-gray-400">{desc}</span>
      </div>
      <div className="text-[10px] font-mono text-gray-400 dark:text-gray-500 truncate">
        {formula}
      </div>
    </div>
  )
}


// ============================================================
// TEAM COVERAGE WALL
// ============================================================
// One striking visual that demonstrates breadth at a glance. Pulls
// every PNW team with a logo and lays them out as a dense grid.
function TeamCoverageWall() {
  const { data: teams } = useTeams({ season: SEASON })
  const pnwTeams = (teams || [])
    .filter((t) => t.logo_url && (t.is_pnw || ['WA', 'OR', 'ID', 'MT', 'BC'].includes(t.state)))

  if (pnwTeams.length === 0) return null

  return (
    <section>
      <SectionHeading
        eyebrow="Coverage"
        title="Every PNW program in one place"
        sub={`${pnwTeams.length} active teams across D1, D2, D3, NAIA, and the NWAC. Click any logo to drop into that team's page.`}
      />
      <div className="grid grid-cols-6 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-12 gap-2">
        {pnwTeams.map((t) => (
          <Link
            key={t.id}
            to={`/team/${t.id}`}
            title={t.short_name || t.name}
            className="aspect-square bg-white dark:bg-gray-800 rounded-md border border-gray-200 dark:border-gray-700 p-1.5 flex items-center justify-center hover:border-nw-teal hover:shadow transition-all"
          >
            <img
              src={t.logo_url}
              alt={t.short_name || t.name}
              className="w-full h-full object-contain"
              loading="lazy"
              onError={(e) => { e.target.style.display = 'none' }}
            />
          </Link>
        ))}
      </div>
    </section>
  )
}


// ============================================================
// WHAT'S NEXT
// ============================================================
function WhatsNextCard() {
  return (
    <section className="rounded-xl bg-gradient-to-br from-nw-teal/10 to-pnw-sky/10 dark:from-nw-teal/20 dark:to-pnw-sky/20 border border-nw-teal/20 dark:border-nw-teal/30 p-5 sm:p-7">
      <div className="text-[10px] font-semibold uppercase tracking-[2px] text-nw-teal mb-3">
        Coming up
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-2">
          <h3 className="text-xl sm:text-2xl font-extrabold text-gray-900 dark:text-gray-100 mb-2 leading-tight">
            West Coast League opens June 3
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mb-3">
            Summer ball returns next week with full WCL coverage: box scores, league
            leaderboards, and player tracking for every PNW team. Sign up now to follow
            your favorite players through the summer.
          </p>
          <Link
            to="/summerball"
            className="inline-block text-sm font-semibold text-nw-teal hover:underline"
          >
            Browse summer ball data →
          </Link>
        </div>
        <div className="bg-white/60 dark:bg-gray-800/60 rounded-lg p-4 border border-white dark:border-gray-700">
          <div className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
            What we track
          </div>
          <ul className="text-xs text-gray-700 dark:text-gray-300 space-y-1.5">
            <li>· WCL daily box scores</li>
            <li>· League leaderboards</li>
            <li>· Year-over-year splits</li>
            <li>· PIL + CCL coverage too</li>
          </ul>
        </div>
      </div>
    </section>
  )
}


// ============================================================
// LOCK-TEASE CTA
// ============================================================
function LockTeaseCta() {
  // SVGs instead of emoji icons — match the rest of the site's
  // visual language. All paths are heroicons-style 24x24 outline.
  const perks = [
    {
      label: 'Favorite players + bookmark teams',
      svg: (
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M11.48 3.5l2.46 4.99 5.51.8-3.99 3.88.94 5.49-4.92-2.59-4.92 2.59.94-5.49-3.99-3.88 5.51-.8L11.48 3.5z" />
      ),
    },
    {
      label: 'Personalized dashboards',
      svg: (
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M3 21V8m4 13V3m4 18v-9m4 9V6m4 15v-4" />
      ),
    },
    {
      label: 'Read every article',
      svg: (
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M4 6h16M4 10h16M4 14h10M4 18h7M19 14v5h-3" />
      ),
    },
    {
      label: 'Email digests when your team plays',
      svg: (
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M3 8l9 6 9-6M3 8v10a2 2 0 002 2h14a2 2 0 002-2V8M3 8l9-5 9 5" />
      ),
    },
  ]
  return (
    <section className="rounded-xl bg-gradient-to-br from-gray-900 to-pnw-slate dark:from-gray-950 dark:to-pnw-slate text-white p-6 sm:p-8">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[2px] text-amber-300 mb-3">
            What you'll unlock
          </div>
          <h3 className="text-2xl sm:text-3xl font-extrabold mb-3 leading-tight">
            A free account, more depth.
          </h3>
          <p className="text-sm text-white/75 leading-relaxed mb-5">
            Personalize the site to the teams and players you care about, and skip
            the paywall on every article we publish.
          </p>
          <Link
            to="/auth?mode=signup"
            className="inline-block px-5 py-2.5 bg-amber-400 text-[#003845] rounded-lg font-bold text-sm hover:bg-amber-300 transition-colors"
          >
            Create free account
          </Link>
        </div>
        <ul className="space-y-3">
          {perks.map((p) => (
            <li key={p.label} className="flex items-start gap-3">
              <span className="shrink-0 w-7 h-7 rounded-full bg-amber-400/15 text-amber-300 flex items-center justify-center">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="w-4 h-4">
                  {p.svg}
                </svg>
              </span>
              <span className="text-sm text-white/90">{p.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}


// ============================================================
// FEATURED ARTICLES
// ============================================================
function FeaturedArticles() {
  const { data: articles } = usePublishedArticles(4)
  const items = Array.isArray(articles) ? articles : (articles?.data || [])
  if (!items.length) return null

  return (
    <section>
      <SectionHeading
        eyebrow="From the site"
        title="Latest articles"
        sub="Recaps, scouting takes, and analysis from the NW Baseball Stats desk."
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {items.slice(0, 3).map((a) => (
          <Link
            key={a.id || a.slug}
            to={`/articles/${a.slug || a.id}`}
            className="group bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden hover:border-nw-teal hover:shadow-md transition-all"
          >
            {a.cover_image_url || a.image_url ? (
              <div
                className="aspect-[16/9] bg-gray-100 dark:bg-gray-700 bg-cover bg-center"
                style={{ backgroundImage: `url(${a.cover_image_url || a.image_url})` }}
              />
            ) : (
              // No cover image — render a gradient header with the
              // site mark instead of a baseball emoji.
              <div className="aspect-[16/9] bg-gradient-to-br from-nw-teal/30 to-pnw-sky/30 dark:from-nw-teal/50 dark:to-pnw-sky/50 flex items-center justify-center">
                <div className="text-white/90 font-black text-2xl tracking-tight">
                  NW<span className="text-amber-300">·</span>BB
                </div>
              </div>
            )}
            <div className="p-4">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1.5">
                {a.published_at
                  ? new Date(a.published_at).toLocaleDateString('en-US', {
                      month: 'short', day: 'numeric',
                    })
                  : 'Article'}
              </div>
              <h4 className="text-sm sm:text-base font-bold text-gray-900 dark:text-gray-100 leading-tight line-clamp-3 group-hover:text-nw-teal transition-colors">
                {a.title}
              </h4>
            </div>
          </Link>
        ))}
      </div>
    </section>
  )
}


// ============================================================
// FOUNDER + FINAL CTA
// ============================================================
function ClosingCtaWithFounder() {
  return (
    <section className="rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-6 sm:p-8 text-center">
      <h3 className="text-2xl sm:text-3xl font-extrabold text-gray-900 dark:text-gray-100 mb-3">
        Ready to dig in?
      </h3>
      <p className="text-sm sm:text-base text-gray-600 dark:text-gray-300 max-w-xl mx-auto mb-6">
        Built by a coach, scout, and former pitcher. Free forever for the basics,
        with paid tiers for coaches who need recruiting and game-planning depth.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          to="/auth?mode=signup"
          className="px-6 py-3 bg-nw-teal text-white rounded-lg font-bold hover:bg-pnw-sky transition-colors"
        >
          Create free account
        </Link>
        <Link
          to="/pricing"
          className="px-6 py-3 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-lg font-semibold hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
        >
          See paid tiers
        </Link>
      </div>
      <div className="mt-6 pt-6 border-t border-gray-100 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
        Questions? <Link to="/about" className="text-nw-teal hover:underline">About the site</Link>
        {' · '}
        <a href="https://x.com/RasmussenBase" target="_blank" rel="noopener noreferrer" className="text-nw-teal hover:underline">@RasmussenBase</a>
      </div>
    </section>
  )
}


// ============================================================
// Helpers
// ============================================================
function SectionHeading({ eyebrow, title, sub }) {
  return (
    <div className="mb-5">
      {eyebrow && (
        <div className="text-[10px] font-semibold uppercase tracking-[2px] text-nw-teal mb-1.5">
          {eyebrow}
        </div>
      )}
      <h2 className="text-2xl sm:text-3xl font-extrabold text-gray-900 dark:text-gray-100 leading-tight mb-1">
        {title}
      </h2>
      {sub && (
        <p className="text-sm text-gray-500 dark:text-gray-400">{sub}</p>
      )}
    </div>
  )
}
