// FreeHomepage — the homepage for signed-in FREE-tier users.
//
// Goal: a data-and-graphics-rich dashboard that (a) shows off the
// breadth of the site and (b) nudges toward Premium (the coaching
// sim). Distinct from the anonymous homepage: more interactive,
// more numbers, rotating visuals.
//
// Sections:
//   1. Welcome strip (compact, logged-in)
//   2. Rotating scatter plot (recharts) → /scatter
//   3. Mini player percentiles (random qualified player) → /percentiles
//   4. League trivia quiz (/quiz/league-question) → /team-quiz
//   5. PNW coverage broken down state-by-state
//   6. Premium promo for the coaching sim
//
// Wired in App.jsx HomepageRouter on tier === 'free'.

import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import {
  ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis,
  CartesianGrid, Tooltip as RTooltip, ZAxis,
  BarChart, Bar, Cell, LabelList,
} from 'recharts'
import { useTeams, useStatLeaders, useTopMoments } from '../hooks/useApi'
import { useAuth } from '../context/AuthContext'
import { useAffiliatedTeam } from '../context/AffiliationContext'
import { TEAM_COORDS } from '../lib/teamCoords'
import PixelHeadshot from '../gm/components/PixelHeadshot'
import PreviewTierWidget from '../components/PreviewTierWidget'
import EugeneRegionalBracket from '../components/EugeneRegionalBracket'

const SEASON = 2026

const DIV_COLORS = {
  D1: '#2563eb', D2: '#059669', D3: '#d97706', NAIA: '#9333ea', JUCO: '#dc2626',
}

export default function FreeHomepage() {
  return (
    <div className="space-y-5 sm:space-y-6">
      {/* Author-only "view as tier" toggle (renders nothing for
          normal users). Pinned to the top so the dev can hop between
          tiers while building per-tier homepages. */}
      <PreviewTierWidget />
      <EugeneRegionalBracket />
      <WelcomeStrip />

      <StatLeadersBoard />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 flex flex-col gap-5">
          <ScatterWidget />
          <DivisionRunEnvChart />
          <LeagueQuizWidget />
        </div>
        <div className="flex flex-col gap-5">
          <PercentilesWidget />
          <WpaSwingsBoard />
          <PremiumSimPromo />
        </div>
      </div>

      <PnwMapWidget />
      <StateBreakdown />
    </div>
  )
}


// ============================================================
// 1. WELCOME STRIP
// ============================================================
function WelcomeStrip() {
  const { user } = useAuth()
  const { team } = useAffiliatedTeam()
  const name = user?.email ? user.email.split('@')[0] : 'there'

  return (
    <div className="rounded-xl bg-gradient-to-r from-nw-teal to-pnw-sky text-white px-5 py-4 sm:px-6 sm:py-5 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-[11px] uppercase tracking-[2px] font-semibold text-white/70">
          Welcome back
        </div>
        <div className="text-xl sm:text-2xl font-extrabold truncate">
          {team ? `Following ${team.short_name || team.name}` : `Hey, ${name}`}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link to="/hitting" className="px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-sm font-semibold transition-colors">Leaderboards</Link>
        <Link to="/percentiles" className="px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-sm font-semibold transition-colors">Percentiles</Link>
        <Link to="/team-quiz" className="px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-sm font-semibold transition-colors">Team Quiz</Link>
      </div>
    </div>
  )
}


// ============================================================
// 2. ROTATING SCATTER PLOT
// ============================================================
const SCATTER_COMBOS = [
  { x: 'team_avg', y: 'team_era', xl: 'Team AVG', yl: 'Team ERA', title: 'Offense vs Run Prevention' },
  { x: 'team_obp', y: 'team_slg', xl: 'Team OBP', yl: 'Team SLG', title: 'Getting On vs Slugging' },
  { x: 'run_diff', y: 'win_pct', xl: 'Run Differential', yl: 'Win %', title: 'Run Diff vs Winning' },
  { x: 'team_slg', y: 'team_era', xl: 'Team SLG', yl: 'Team ERA', title: 'Power vs Pitching' },
  { x: 'team_obp', y: 'win_pct', xl: 'Team OBP', yl: 'Win %', title: 'On-Base vs Winning' },
]

function ScatterWidget() {
  const [comboIdx, setComboIdx] = useState(() => Math.floor(Math.random() * SCATTER_COMBOS.length))
  const [points, setPoints] = useState([])
  const [loading, setLoading] = useState(true)
  const combo = SCATTER_COMBOS[comboIdx]

  useEffect(() => {
    let alive = true
    setLoading(true)
    fetch(`/api/v1/teams/scatter?season=${SEASON}&x_stat=${combo.x}&y_stat=${combo.y}`)
      .then((r) => r.json())
      .then((d) => { if (alive) { setPoints(Array.isArray(d) ? d : []); setLoading(false) } })
      .catch(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [combo.x, combo.y])

  // Split points by division for colored series.
  const byDivision = useMemo(() => {
    const groups = {}
    for (const p of points) {
      const lvl = p.division_level || 'OTHER'
      if (!groups[lvl]) groups[lvl] = []
      groups[lvl].push(p)
    }
    return groups
  }, [points])

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-2 mb-1">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[2px] text-nw-teal">
            Team Scatter · {SEASON}
          </div>
          <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">{combo.title}</h3>
        </div>
        <div className="flex gap-1.5 shrink-0">
          <button
            onClick={() => setComboIdx((i) => (i + 1) % SCATTER_COMBOS.length)}
            className="px-2.5 py-1 rounded-md bg-gray-100 dark:bg-gray-700 text-xs font-semibold text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
            title="Show another pairing"
          >
            Shuffle
          </button>
          <Link
            to="/scatter"
            className="px-2.5 py-1 rounded-md bg-nw-teal text-white text-xs font-semibold hover:bg-pnw-sky transition-colors"
          >
            Build your own
          </Link>
        </div>
      </div>

      <div className="h-64 sm:h-72 w-full">
        {loading ? (
          <div className="h-full flex items-center justify-center text-gray-400 animate-pulse text-sm">
            Plotting {combo.title.toLowerCase()}...
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 10, right: 10, bottom: 20, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" className="dark:opacity-20" />
              <XAxis
                type="number" dataKey="x" name={combo.xl}
                tick={{ fontSize: 11 }} stroke="#9ca3af"
                label={{ value: combo.xl, position: 'insideBottom', offset: -10, fontSize: 11, fill: '#6b7280' }}
                domain={['dataMin', 'dataMax']}
              />
              <YAxis
                type="number" dataKey="y" name={combo.yl}
                tick={{ fontSize: 11 }} stroke="#9ca3af"
                label={{ value: combo.yl, angle: -90, position: 'insideLeft', fontSize: 11, fill: '#6b7280' }}
                domain={['dataMin', 'dataMax']}
              />
              <ZAxis range={[40, 40]} />
              <RTooltip
                cursor={{ strokeDasharray: '3 3' }}
                content={<ScatterTip combo={combo} />}
              />
              {Object.entries(byDivision).map(([lvl, pts]) => (
                <Scatter
                  key={lvl}
                  name={lvl}
                  data={pts}
                  fill={DIV_COLORS[lvl] || '#6b7280'}
                  fillOpacity={0.8}
                />
              ))}
            </ScatterChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Division legend */}
      <div className="flex flex-wrap gap-3 mt-2 justify-center">
        {Object.keys(DIV_COLORS).map((lvl) => (
          <span key={lvl} className="flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: DIV_COLORS[lvl] }} />
            {lvl}
          </span>
        ))}
      </div>
    </div>
  )
}

function ScatterTip({ active, payload, combo }) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg px-3 py-2 text-xs">
      <div className="flex items-center gap-1.5 font-semibold text-gray-900 dark:text-gray-100">
        {p.logo_url && <img src={p.logo_url} alt="" className="w-4 h-4 object-contain" />}
        {p.short_name || p.name}
      </div>
      <div className="text-gray-500 dark:text-gray-400 mt-1">
        {combo.xl}: <span className="font-mono">{p.x}</span><br />
        {combo.yl}: <span className="font-mono">{p.y}</span>
      </div>
    </div>
  )
}


// ============================================================
// 2b. DIVISION RUN-ENVIRONMENT BAR CHART
// ============================================================
// Averages the per-team scatter values by division to show how the
// five leagues stack up on a selectable stat. On-brand for a site
// built around cross-division comparison. No new endpoint — reuses
// /teams/scatter and aggregates client-side.
const ENV_STATS = [
  { key: 'team_avg', label: 'Team AVG', fmt: (v) => v.toFixed(3).replace(/^0/, ''), better: 'high' },
  { key: 'team_obp', label: 'Team OBP', fmt: (v) => v.toFixed(3).replace(/^0/, ''), better: 'high' },
  { key: 'team_slg', label: 'Team SLG', fmt: (v) => v.toFixed(3).replace(/^0/, ''), better: 'high' },
  { key: 'team_era', label: 'Team ERA', fmt: (v) => v.toFixed(2), better: 'low' },
]
const DIV_ORDER = ['D1', 'D2', 'D3', 'NAIA', 'JUCO']

function DivisionRunEnvChart() {
  const [statIdx, setStatIdx] = useState(0)
  const [bars, setBars] = useState([])
  const [loading, setLoading] = useState(true)
  const stat = ENV_STATS[statIdx]

  useEffect(() => {
    let alive = true
    setLoading(true)
    fetch(`/api/v1/teams/scatter?season=${SEASON}&x_stat=${stat.key}&y_stat=win_pct`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return
        const pts = Array.isArray(d) ? d : []
        const sums = {}
        for (const p of pts) {
          const lvl = p.division_level
          if (!DIV_ORDER.includes(lvl)) continue
          if (!sums[lvl]) sums[lvl] = { total: 0, n: 0 }
          sums[lvl].total += p.x
          sums[lvl].n += 1
        }
        const rows = DIV_ORDER
          .filter((lvl) => sums[lvl]?.n)
          .map((lvl) => ({ division: lvl, value: sums[lvl].total / sums[lvl].n }))
        setBars(rows)
        setLoading(false)
      })
      .catch(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [stat.key])

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[2px] text-nw-teal">
            League comparison · {SEASON}
          </div>
          <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">Division run environments</h3>
        </div>
        <div className="flex flex-wrap gap-1 shrink-0">
          {ENV_STATS.map((s, i) => (
            <button
              key={s.key}
              onClick={() => setStatIdx(i)}
              className={`px-2 py-1 rounded-md text-[11px] font-semibold transition-colors ${
                i === statIdx
                  ? 'bg-nw-teal text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="h-56 w-full">
        {loading ? (
          <div className="h-full flex items-center justify-center text-gray-400 animate-pulse text-sm">
            Crunching {stat.label.toLowerCase()} by league...
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={bars} margin={{ top: 16, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" className="dark:opacity-20" />
              <XAxis dataKey="division" tick={{ fontSize: 12, fontWeight: 600 }} stroke="#9ca3af" />
              <YAxis
                tick={{ fontSize: 11 }} stroke="#9ca3af"
                domain={['auto', 'auto']}
                tickFormatter={(v) => stat.fmt(v)}
                width={44}
              />
              <RTooltip
                cursor={{ fill: 'rgba(0,0,0,0.04)' }}
                formatter={(v) => [stat.fmt(v), stat.label]}
                labelClassName="font-bold"
                contentStyle={{ fontSize: 12, borderRadius: 8 }}
              />
              <Bar dataKey="value" radius={[5, 5, 0, 0]}>
                {bars.map((b) => (
                  <Cell key={b.division} fill={DIV_COLORS[b.division] || '#6b7280'} />
                ))}
                <LabelList dataKey="value" position="top" formatter={(v) => stat.fmt(v)}
                  style={{ fontSize: 11, fontWeight: 700, fill: '#6b7280' }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
      <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1 text-center">
        Average across every PNW team in each league. {stat.better === 'low' ? 'Lower is tougher to hit.' : 'Higher means more offense.'}
      </p>
    </div>
  )
}


// ============================================================
// 1b. STAT LEADERS BOARD
// ============================================================
// A dense multi-category board of the season's top performers. Pulls
// the standard categories from /stat-leaders and two advanced
// PBP-derived categories (hitter Air Pull%, pitcher Whiff%) from the
// PBP leaderboards. Top 2 per category, packed into a tight grid.

// Standard categories sourced from /stat-leaders. `fmt` controls value
// formatting.
const LEADER_CATEGORIES = [
  { key: 'home_runs',      label: 'Home Runs',    to: '/hitting',  fmt: 'int' },
  { key: 'batting_avg',    label: 'Batting Avg',  to: '/hitting',  fmt: 'avg' },
  { key: 'wrc_plus',       label: 'wRC+',         to: '/hitting',  fmt: 'int' },
  { key: 'iso',            label: 'ISO',          to: '/hitting',  fmt: 'avg' },
  { key: 'offensive_war',  label: 'Position WAR', to: '/war',      fmt: 'war' },
  { key: 'era',            label: 'ERA',          to: '/pitching', fmt: 'era' },
  { key: 'strikeouts',     label: 'Strikeouts',   to: '/pitching', fmt: 'int' },
  { key: 'fip_plus',       label: 'FIP+',         to: '/pitching', fmt: 'int' },
  { key: 'k_minus_bb_pct', label: 'K-BB%',        to: '/pitching', fmt: 'pct' },
  { key: 'pitching_war',   label: 'Pitching WAR', to: '/war',      fmt: 'war' },
]

// Advanced PBP-derived categories. Fetched from the PBP leaderboards
// sorted by the metric. `valueKey` is the field in the row payload.
const PBP_LEADER_CATEGORIES = [
  { id: 'air_pull', endpoint: 'batting-pbp', sort: 'air_pull_pct',
    valueKey: 'air_pull_pct', label: 'Air Pull%', to: '/hitting' },
  { id: 'whiff_p',  endpoint: 'pitching-pbp', sort: 'whiff_pct',
    valueKey: 'whiff_pct', label: 'Whiff% (P)', to: '/pitching' },
]

function fmtLeaderValue(fmt, v) {
  if (v == null) return '-'
  const n = Number(v)
  switch (fmt) {
    case 'avg': return n.toFixed(3).replace(/^0/, '')
    case 'era': return n.toFixed(2)
    case 'war': return n.toFixed(1)
    case 'pct': return (n * 100).toFixed(1) + '%'   // decimals → %
    default:    return Math.round(n).toString()
  }
}

function LeaderCard({ label, to, leaders }) {
  return (
    <Link
      to={to}
      className="group rounded-lg border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 px-2.5 py-2 hover:border-nw-teal transition-colors"
    >
      <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1.5 group-hover:text-nw-teal truncate">
        {label}
      </div>
      <div className="space-y-1">
        {leaders.length === 0 && [0, 1].map((i) => (
          <div key={i} className="h-3.5 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
        ))}
        {leaders.map((ld, i) => (
          <div key={ld.player_id || i} className="flex items-center gap-1">
            <span className={`text-[9px] font-bold w-2.5 ${i === 0 ? 'text-amber-500' : 'text-gray-400'}`}>{i + 1}</span>
            {ld.logo_url && (
              <img src={ld.logo_url} alt="" className="w-3.5 h-3.5 object-contain shrink-0"
                onError={(e) => { e.target.style.display = 'none' }} />
            )}
            <span className="text-[11px] font-semibold text-gray-800 dark:text-gray-100 truncate flex-1">
              {ld.first_name} {ld.last_name}
            </span>
            <span className="text-[11px] font-mono font-bold text-nw-teal dark:text-teal-300 tabular-nums">
              {ld.display}
            </span>
          </div>
        ))}
      </div>
    </Link>
  )
}

function StatLeadersBoard() {
  const { data } = useStatLeaders(SEASON, 2, true)
  const [pbp, setPbp] = useState({})

  // Fetch the PBP-derived leader categories (top 2 each).
  useEffect(() => {
    let alive = true
    PBP_LEADER_CATEGORIES.forEach((cat) => {
      fetch(`/api/v1/leaderboards/${cat.endpoint}?season=${SEASON}&min_bf=80&sort_by=${cat.sort}&sort_dir=desc&limit=2`)
        .then((r) => r.json())
        .then((d) => {
          if (!alive) return
          const leaders = (d?.data || []).slice(0, 2).map((r) => ({
            player_id: r.player_id, first_name: r.first_name, last_name: r.last_name,
            logo_url: r.logo_url,
            display: fmtLeaderValue('pct', r[cat.valueKey]),
          }))
          setPbp((prev) => ({ ...prev, [cat.id]: leaders }))
        })
        .catch(() => {})
    })
    return () => { alive = false }
  }, [])

  const catMap = useMemo(() => {
    const m = {}
    for (const c of (data?.batting || [])) m[c.key] = c
    for (const c of (data?.pitching || [])) m[c.key] = c
    return m
  }, [data])

  // Build the full ordered card list: interleave standard + PBP so the
  // advanced metrics sit next to their family (Air Pull% after the
  // batting block, Whiff% after the pitching block).
  const cards = []
  for (const cat of LEADER_CATEGORIES) {
    const c = catMap[cat.key]
    const leaders = (c?.leaders || []).slice(0, 2).map((ld) => ({
      ...ld, display: fmtLeaderValue(cat.fmt, ld.value),
    }))
    cards.push({ key: cat.key, label: cat.label, to: cat.to, leaders })
    // Slot Air Pull% right after ISO (batting advanced cluster).
    if (cat.key === 'iso' && pbp.air_pull) {
      cards.push({ key: 'air_pull', label: 'Air Pull%', to: '/hitting', leaders: pbp.air_pull })
    }
    // Slot Whiff% (P) right after FIP+ (pitching advanced cluster).
    if (cat.key === 'fip_plus' && pbp.whiff_p) {
      cards.push({ key: 'whiff_p', label: 'Whiff% (P)', to: '/pitching', leaders: pbp.whiff_p })
    }
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4 sm:p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[2px] text-nw-teal">
            2026 Leaders
          </div>
          <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">Who's on top</h3>
        </div>
        <Link to="/stat-leaders" className="text-xs font-semibold text-nw-teal hover:underline shrink-0">
          All categories →
        </Link>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        {cards.map((c) => (
          <LeaderCard key={c.key} label={c.label} to={c.to} leaders={c.leaders} />
        ))}
      </div>
    </div>
  )
}


// ============================================================
// 3. MINI PERCENTILES WIDGET
// ============================================================
const PCT_METRICS = [
  { key: 'wrc_plus', label: 'wRC+' },
  { key: 'woba', label: 'wOBA' },
  { key: 'iso', label: 'ISO' },
  { key: 'bb_pct', label: 'BB%' },
  { key: 'k_pct', label: 'K%' },
  { key: 'sb_per_pa', label: 'Speed' },
]

function pctColor(p) {
  // Baseball Savant style: blue (cold/low) → grey → red (hot/high)
  if (p == null) return '#9ca3af'
  if (p >= 90) return '#d22d49'
  if (p >= 75) return '#e0623f'
  if (p >= 60) return '#ec9c63'
  if (p >= 45) return '#b8b8b8'
  if (p >= 30) return '#7aa2cf'
  if (p >= 15) return '#5377b0'
  return '#325aa6'
}

function PercentilesWidget() {
  const [player, setPlayer] = useState(null)
  const [pool, setPool] = useState([])

  // Fetch a pool of qualified hitters once, then rotate through them.
  useEffect(() => {
    fetch(`/api/v1/leaderboards/percentiles?season=${SEASON}&limit=60`)
      .then((r) => r.json())
      .then((d) => {
        const rows = (d?.data || []).filter((r) => r.percentiles && r.percentiles.wrc_plus != null)
        setPool(rows)
        if (rows.length) setPlayer(rows[Math.floor(Math.random() * rows.length)])
      })
      .catch(() => {})
  }, [])

  const shuffle = useCallback(() => {
    if (pool.length) setPlayer(pool[Math.floor(Math.random() * pool.length)])
  }, [pool])

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[2px] text-nw-teal">
            Savant-style percentiles
          </div>
          <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">Player percentiles</h3>
        </div>
        <button
          onClick={shuffle}
          className="px-2.5 py-1 rounded-md bg-gray-100 dark:bg-gray-700 text-xs font-semibold text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors shrink-0"
        >
          Shuffle
        </button>
      </div>

      {!player ? (
        <div className="space-y-2 animate-pulse">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-5 bg-gray-100 dark:bg-gray-700 rounded" />
          ))}
        </div>
      ) : (
        <>
          <Link to={`/player/${player.player_id}`} className="flex items-center gap-2.5 mb-3 group">
            {player.logo_url && (
              <img src={player.logo_url} alt="" className="w-8 h-8 object-contain shrink-0"
                onError={(e) => { e.target.style.display = 'none' }} />
            )}
            <div className="min-w-0">
              <div className="text-sm font-bold text-gray-900 dark:text-gray-100 truncate group-hover:text-nw-teal">
                {player.first_name} {player.last_name}
              </div>
              <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">
                {player.team_short} · {player.division_level}
              </div>
            </div>
          </Link>

          <div className="space-y-1.5">
            {PCT_METRICS.map((m) => {
              const p = player.percentiles?.[m.key]
              if (p == null) return null
              return (
                <div key={m.key} className="flex items-center gap-2">
                  <div className="w-12 text-[11px] font-semibold text-gray-500 dark:text-gray-400 text-right shrink-0">
                    {m.label}
                  </div>
                  <div className="flex-1 h-5 bg-gray-100 dark:bg-gray-700/60 rounded-full relative">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full transition-all"
                      style={{ width: `${p}%`, background: pctColor(p) }}
                    />
                    <div
                      className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-5 h-5 rounded-full border-2 border-white dark:border-gray-800 text-[9px] font-bold flex items-center justify-center text-white shadow"
                      style={{ left: `${p}%`, background: pctColor(p) }}
                    >
                      {p}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          <Link
            to="/percentiles"
            className="block text-center mt-4 text-xs font-semibold text-nw-teal hover:underline"
          >
            Explore the full percentile leaderboard →
          </Link>
        </>
      )}
    </div>
  )
}


// ============================================================
// 4. LEAGUE QUIZ WIDGET
// ============================================================
function LeagueQuizWidget() {
  const [q, setQ] = useState(null)
  const [picked, setPicked] = useState(null)
  const [loading, setLoading] = useState(true)
  const [streak, setStreak] = useState(0)

  const load = useCallback(() => {
    setLoading(true)
    setPicked(null)
    fetch(`/api/v1/quiz/league-question?season=${SEASON}`)
      .then((r) => r.json())
      .then((d) => { setQ(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const pick = (idx) => {
    if (picked != null) return
    setPicked(idx)
    if (idx === q.correct_index) setStreak((s) => s + 1)
    else setStreak(0)
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[2px] text-nw-teal">
            League Trivia{q?.category ? ` · ${q.category}` : ''}
          </div>
          <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">Test your PNW knowledge</h3>
        </div>
        {streak > 1 && (
          <span className="shrink-0 text-xs font-bold text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 rounded-full">
            {streak} streak
          </span>
        )}
      </div>

      {loading || !q ? (
        <div className="space-y-2 animate-pulse">
          <div className="h-5 w-3/4 bg-gray-100 dark:bg-gray-700 rounded" />
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-10 bg-gray-100 dark:bg-gray-700 rounded-lg" />
          ))}
        </div>
      ) : (
        <>
          <p className="text-sm sm:text-base font-semibold text-gray-800 dark:text-gray-100 mb-3 leading-snug">
            {q.question}
          </p>
          <div className="space-y-2">
            {q.options.map((opt, idx) => {
              let cls = 'border-gray-200 dark:border-gray-700 hover:border-nw-teal hover:bg-nw-teal/5'
              if (picked != null) {
                if (idx === q.correct_index) cls = 'border-green-500 bg-green-50 dark:bg-green-900/30'
                else if (idx === picked) cls = 'border-red-400 bg-red-50 dark:bg-red-900/30'
                else cls = 'border-gray-200 dark:border-gray-700 opacity-60'
              }
              return (
                <button
                  key={idx}
                  onClick={() => pick(idx)}
                  disabled={picked != null}
                  className={`w-full text-left px-3 py-2 rounded-lg border text-sm font-medium text-gray-800 dark:text-gray-100 transition-colors ${cls}`}
                >
                  <span className="inline-block w-5 font-bold text-gray-400">{String.fromCharCode(65 + idx)}</span>
                  {opt}
                </button>
              )
            })}
          </div>

          {picked != null && (
            <div className="mt-3 text-xs text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-gray-900/40 rounded-lg px-3 py-2">
              {picked === q.correct_index ? '✓ Correct! ' : '✗ Not quite. '}
              {q.explanation}
            </div>
          )}

          <div className="flex items-center justify-between mt-4">
            <button
              onClick={load}
              className="px-3 py-1.5 rounded-lg bg-nw-teal text-white text-xs font-semibold hover:bg-pnw-sky transition-colors"
            >
              {picked != null ? 'Next question' : 'Skip'}
            </button>
            <Link to="/team-quiz" className="text-xs font-semibold text-nw-teal hover:underline">
              Quiz yourself on a team →
            </Link>
          </div>
        </>
      )}
    </div>
  )
}


// ============================================================
// 4b. BIGGEST WIN-PROBABILITY SWINGS (rotating board)
// ============================================================
function WpaSwingsBoard() {
  const { data } = useTopMoments(SEASON, { limit: 12 })
  const moments = useMemo(() => {
    const hm = data?.hitter_moments || []
    return hm
      .map((m) => ({ ...m, swing: Math.abs((m.wp_after ?? 0) - (m.wp_before ?? 0)) }))
      .sort((a, b) => b.swing - a.swing)
      .slice(0, 8)
  }, [data])

  const [idx, setIdx] = useState(0)
  const [paused, setPaused] = useState(false)

  // Auto-rotate the board every 6s unless the user is hovering.
  useEffect(() => {
    if (paused || moments.length < 2) return
    const t = setInterval(() => setIdx((i) => (i + 1) % moments.length), 6000)
    return () => clearInterval(t)
  }, [paused, moments.length])

  // Keep idx in range when data arrives.
  useEffect(() => { setIdx(0) }, [moments.length])

  const m = moments[idx]

  return (
    <div
      className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4 sm:p-5"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[2px] text-nw-teal">
            Win Probability · {SEASON}
          </div>
          <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">Biggest swings</h3>
        </div>
        <Link to="/top-moments" className="text-xs font-semibold text-nw-teal hover:underline shrink-0">
          All moments →
        </Link>
      </div>

      {!m ? (
        <div className="space-y-2 animate-pulse">
          <div className="h-16 bg-gray-100 dark:bg-gray-700 rounded-lg" />
          <div className="h-4 w-2/3 bg-gray-100 dark:bg-gray-700 rounded" />
        </div>
      ) : (
        <Link to={`/game/${m.game_id}`} className="block group">
          {/* Big swing number */}
          <div className="flex items-baseline gap-2 mb-2">
            <span className="text-3xl font-extrabold text-nw-teal dark:text-teal-300 tabular-nums">
              +{Math.round(m.swing * 100)}%
            </span>
            <span className="text-[11px] text-gray-500 dark:text-gray-400 uppercase tracking-wider font-semibold">
              win prob swing
            </span>
          </div>

          {/* Matchup + score */}
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100 mb-1">
            {m.game?.away_logo && <img src={m.game.away_logo} alt="" className="w-5 h-5 object-contain" onError={(e)=>{e.target.style.display='none'}} />}
            <span className="truncate">{m.game?.away_short}</span>
            <span className="text-gray-400 font-mono text-xs">{m.game?.final_away}-{m.game?.final_home}</span>
            <span className="truncate">{m.game?.home_short}</span>
            {m.game?.home_logo && <img src={m.game.home_logo} alt="" className="w-5 h-5 object-contain" onError={(e)=>{e.target.style.display='none'}} />}
          </div>

          {/* Play description */}
          <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed line-clamp-2 group-hover:text-nw-teal transition-colors">
            {m.result_text}
          </p>
          <div className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">
            {m.batter?.name} · {m.half === 'bottom' ? 'Bot' : 'Top'} {m.inning} · {m.game_date}
          </div>
        </Link>
      )}

      {/* Dot pager */}
      {moments.length > 1 && (
        <div className="flex items-center justify-center gap-1.5 mt-3">
          {moments.map((_, i) => (
            <button
              key={i}
              onClick={() => setIdx(i)}
              className={`h-1.5 rounded-full transition-all ${
                i === idx ? 'w-5 bg-nw-teal' : 'w-1.5 bg-gray-300 dark:bg-gray-600 hover:bg-gray-400'
              }`}
              aria-label={`Moment ${i + 1}`}
            />
          ))}
        </div>
      )}
    </div>
  )
}


// ============================================================
// 5b. INTERACTIVE PNW MAP (Leaflet via global window.L)
// ============================================================
function PnwMapWidget() {
  const { data: teams } = useTeams({ season: SEASON })
  const containerRef = useRef(null)
  const mapRef = useRef(null)

  // Build a lookup of short_name → team row (for logo + id + division).
  const teamByShort = useMemo(() => {
    const m = {}
    for (const t of (teams || [])) {
      if (t.short_name) m[t.short_name] = t
    }
    return m
  }, [teams])

  useEffect(() => {
    const L = window.L
    if (!L || !containerRef.current || mapRef.current) return
    if (Object.keys(teamByShort).length === 0) return

    const map = L.map(containerRef.current, {
      center: [46.2, -121.5],
      zoom: 6,
      scrollWheelZoom: false,
      attributionControl: false,
    })
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
    }).addTo(map)

    const DIV_HEX = DIV_COLORS
    const markers = []
    for (const [shortName, coords] of Object.entries(TEAM_COORDS)) {
      const team = teamByShort[shortName]
      const color = team ? (DIV_HEX[team.division_level] || '#6b7280') : '#6b7280'
      const logo = team?.logo_url || ''
      const icon = L.divIcon({
        className: '',
        html: `<div style="width:30px;height:30px;border-radius:9999px;background:white;border:2px solid ${color};box-shadow:0 1px 3px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;overflow:hidden;">
                 ${logo ? `<img src="${logo}" style="width:22px;height:22px;object-fit:contain;" />` : ''}
               </div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      })
      const marker = L.marker(coords, { icon }).addTo(map)
      const teamId = team?.id
      const popupHtml = `<div style="text-align:center;min-width:120px;">
          ${logo ? `<img src="${logo}" style="width:36px;height:36px;object-fit:contain;margin:0 auto 4px;" />` : ''}
          <div style="font-weight:700;font-size:13px;">${shortName}</div>
          <div style="font-size:11px;color:#6b7280;">${team?.division_level || ''}</div>
          ${teamId ? `<a href="/team/${teamId}" style="display:inline-block;margin-top:4px;font-size:11px;color:#00687a;font-weight:600;">View team →</a>` : ''}
        </div>`
      marker.bindPopup(popupHtml)
      markers.push(marker)
    }
    mapRef.current = map

    return () => { map.remove(); mapRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamByShort])

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4 sm:p-6">
      <div className="text-[10px] font-semibold uppercase tracking-[2px] text-nw-teal mb-1">
        Coverage map
      </div>
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <h3 className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
          Every program on the map
        </h3>
        <div className="flex flex-wrap gap-3">
          {Object.keys(DIV_COLORS).map((lvl) => (
            <span key={lvl} className="flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: DIV_COLORS[lvl] }} />
              {lvl}
            </span>
          ))}
        </div>
      </div>
      <div
        ref={containerRef}
        className="w-full h-[420px] rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 z-0"
      />
      <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-2">
        Click a marker for the team. Scroll-zoom is off, pinch or use the +/- controls to zoom.
      </p>
    </div>
  )
}


// ============================================================
// 5. PNW COVERAGE — STATE BY STATE
// ============================================================
const STATES = [
  { code: 'WA', name: 'Washington' },
  { code: 'OR', name: 'Oregon' },
  { code: 'ID', name: 'Idaho' },
  { code: 'MT', name: 'Montana' },
  { code: 'BC', name: 'British Columbia' },
]

function StateBreakdown() {
  const { data: teams } = useTeams({ season: SEASON })
  const pnw = (teams || []).filter(
    (t) => t.logo_url && (t.is_pnw || STATES.some((s) => s.code === t.state))
  )

  const byState = useMemo(() => {
    const m = {}
    for (const s of STATES) m[s.code] = []
    for (const t of pnw) {
      if (m[t.state]) m[t.state].push(t)
    }
    return m
  }, [pnw])

  if (pnw.length === 0) return null

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4 sm:p-6">
      <div className="text-[10px] font-semibold uppercase tracking-[2px] text-nw-teal mb-1">
        Coverage map
      </div>
      <h3 className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100 mb-4">
        PNW baseball, state by state
      </h3>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        {STATES.map((s) => {
          const list = byState[s.code] || []
          return (
            <div key={s.code} className="rounded-lg border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3">
              <div className="flex items-baseline justify-between mb-2">
                <div className="text-sm font-bold text-gray-900 dark:text-gray-100">{s.name}</div>
                <div className="text-xl font-extrabold text-nw-teal dark:text-teal-300 tabular-nums">{list.length}</div>
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {list.map((t) => (
                  <Link
                    key={t.id}
                    to={`/team/${t.id}`}
                    title={t.short_name || t.name}
                    className="aspect-square bg-white dark:bg-gray-800 rounded border border-gray-100 dark:border-gray-700 p-1 flex items-center justify-center hover:border-nw-teal transition-colors"
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
                {list.length === 0 && (
                  <div className="col-span-4 text-[11px] text-gray-400 dark:text-gray-500 italic py-2">
                    No teams tracked yet.
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}


// ============================================================
// 6. PREMIUM SIM PROMO
// ============================================================
// Fake roster for the preview. Distinct ids → distinct pixel faces.
// Cap/jersey use the brand colors so the squad looks like one team.
const SIM_PREVIEW_ROSTER = [
  { id: 'sim-tate-88',   name: 'M. Tate',   pos: 'SS',  ovr: 88, cls: 'Jr', a: ['CON 91', 'POW 84'] },
  { id: 'sim-brandt-85', name: 'E. Brandt', pos: 'RHP', ovr: 85, cls: 'So', a: ['VELO 88', 'CMD 82'] },
  { id: 'sim-vance-82',  name: 'J. Vance',  pos: 'CF',  ovr: 82, cls: 'Sr', a: ['SPD 94', 'DEF 86'] },
  { id: 'sim-reyes-80',  name: 'C. Reyes',  pos: 'C',   ovr: 80, cls: 'Fr', a: ['CON 80', 'ARM 88'] },
]

function ovrColor(ovr) {
  if (ovr >= 85) return '#16a34a'
  if (ovr >= 80) return '#65a30d'
  if (ovr >= 75) return '#ca8a04'
  return '#9ca3af'
}

// SimPreview — a stylized "game window" mock showing what the
// coaching sim looks like: pixel-art player faces + ratings, framed
// like a screenshot so free users can see the product before buying.
function SimPreview() {
  return (
    <div className="rounded-lg overflow-hidden border border-white/10 shadow-lg bg-[#1b1f33]">
      {/* faux window chrome */}
      <div className="flex items-center gap-1.5 px-3 py-2 bg-[#11142a] border-b border-white/10">
        <span className="w-2 h-2 rounded-full bg-red-400/70" />
        <span className="w-2 h-2 rounded-full bg-amber-400/70" />
        <span className="w-2 h-2 rounded-full bg-green-400/70" />
        <span className="ml-2 text-[10px] font-mono text-white/40">roster — 2029 season</span>
        <span className="ml-auto text-[10px] font-bold text-green-400">24-9</span>
      </div>

      {/* roster rows */}
      <div className="divide-y divide-white/5">
        {SIM_PREVIEW_ROSTER.map((p) => (
          <div key={p.id} className="flex items-center gap-2.5 px-3 py-2">
            <PixelHeadshot
              playerId={p.id}
              capColor="#003845"
              jerseyColor="#00687a"
              capAccent="#fbbf24"
              size={34}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[13px] font-bold text-white truncate">{p.name}</span>
                <span className="text-[9px] font-semibold text-white/40">{p.cls}</span>
              </div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-[9px] font-bold uppercase tracking-wider text-amber-300/90 bg-amber-400/10 px-1 py-0.5 rounded">
                  {p.pos}
                </span>
                <span className="text-[10px] font-mono text-white/50">{p.a[0]}</span>
                <span className="text-[10px] font-mono text-white/50">{p.a[1]}</span>
              </div>
            </div>
            <div
              className="shrink-0 w-9 h-9 rounded-md flex items-center justify-center font-extrabold text-white text-sm tabular-nums"
              style={{ background: ovrColor(p.ovr) }}
              title="Overall rating"
            >
              {p.ovr}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function PremiumSimPromo() {
  return (
    <div className="rounded-xl bg-gradient-to-br from-gray-900 to-pnw-slate dark:from-gray-950 dark:to-pnw-slate text-white p-5 sm:p-6">
      <div className="text-[10px] font-semibold uppercase tracking-[2px] text-amber-300 mb-2">
        Premium
      </div>
      <h3 className="text-xl sm:text-2xl font-extrabold mb-2 leading-tight">
        Run your own program.
      </h3>
      <p className="text-sm text-white/75 leading-relaxed mb-4">
        The NW Coaching Simulator puts you in the GM chair: recruit, build a roster,
        and chase a conference title across a full dynasty. Included with Premium.
      </p>

      {/* Live pixel-art preview of the game */}
      <SimPreview />

      <ul className="space-y-1.5 mt-4 mb-5 text-sm text-white/90">
        <li className="flex items-center gap-2"><Dot /> Multi-season dynasty mode</li>
        <li className="flex items-center gap-2"><Dot /> Recruiting + transfer portal</li>
        <li className="flex items-center gap-2"><Dot /> Coach hires + player development</li>
      </ul>
      <Link
        to="/pricing"
        className="inline-block px-5 py-2.5 bg-amber-400 text-[#003845] rounded-lg font-bold text-sm hover:bg-amber-300 transition-colors"
      >
        Upgrade to Premium
      </Link>
    </div>
  )
}

function Dot() {
  return <span className="w-1.5 h-1.5 rounded-full bg-amber-300 shrink-0" />
}


// Re-export the data widgets so other per-tier homepages (Premium,
// Coach) can compose them without duplicating the code. They close
// over this module's constants (SEASON, DIV_COLORS, etc.), so they
// keep working when imported elsewhere.
export {
  StatLeadersBoard,
  ScatterWidget,
  DivisionRunEnvChart,
  PercentilesWidget,
  LeagueQuizWidget,
  WpaSwingsBoard,
  PnwMapWidget,
  StateBreakdown,
}
