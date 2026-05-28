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

import { useEffect, useMemo, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import {
  ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis,
  CartesianGrid, Tooltip as RTooltip, ZAxis,
  BarChart, Bar, Cell, LabelList,
} from 'recharts'
import { useTeams, useStatLeaders } from '../hooks/useApi'
import { useAuth } from '../context/AuthContext'
import { useAffiliatedTeam } from '../context/AffiliationContext'

const SEASON = 2026

const DIV_COLORS = {
  D1: '#2563eb', D2: '#059669', D3: '#d97706', NAIA: '#9333ea', JUCO: '#dc2626',
}

export default function FreeHomepage() {
  return (
    <div className="space-y-5 sm:space-y-6">
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
          <PremiumSimPromo />
        </div>
      </div>

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
// A compact multi-category board of the season's top performers.
// Pulls the existing /stat-leaders payload and renders a few
// hand-picked categories with team logos. Links into the
// hitting / pitching leaderboards.
const LEADER_CATEGORIES = [
  { key: 'home_runs', label: 'Home Runs', side: 'batting', to: '/hitting' },
  { key: 'batting_avg', label: 'Batting Avg', side: 'batting', to: '/hitting' },
  { key: 'offensive_war', label: 'Position WAR', side: 'batting', to: '/war' },
  { key: 'era', label: 'ERA', side: 'pitching', to: '/pitching' },
  { key: 'strikeouts', label: 'Strikeouts', side: 'pitching', to: '/pitching' },
  { key: 'pitching_war', label: 'Pitching WAR', side: 'pitching', to: '/war' },
]

function fmtLeaderValue(key, v) {
  if (v == null) return '-'
  if (key === 'batting_avg') return Number(v).toFixed(3).replace(/^0/, '')
  if (key === 'era') return Number(v).toFixed(2)
  if (key === 'offensive_war' || key === 'pitching_war') return Number(v).toFixed(1)
  return Math.round(Number(v)).toString()
}

function StatLeadersBoard() {
  const { data } = useStatLeaders(SEASON, 3, true)

  const catMap = useMemo(() => {
    const m = {}
    for (const c of (data?.batting || [])) m[c.key] = c
    for (const c of (data?.pitching || [])) m[c.key] = c
    return m
  }, [data])

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

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {LEADER_CATEGORIES.map((cat) => {
          const c = catMap[cat.key]
          const leaders = (c?.leaders || []).slice(0, 3)
          return (
            <Link
              key={cat.key}
              to={cat.to}
              className="group rounded-lg border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3 hover:border-nw-teal transition-colors"
            >
              <div className="text-[11px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2 group-hover:text-nw-teal">
                {cat.label}
              </div>
              <div className="space-y-1.5">
                {leaders.length === 0 && [0, 1, 2].map((i) => (
                  <div key={i} className="h-4 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
                ))}
                {leaders.map((ld, i) => (
                  <div key={ld.player_id || i} className="flex items-center gap-1.5">
                    <span className={`text-[10px] font-bold w-3 ${i === 0 ? 'text-amber-500' : 'text-gray-400'}`}>{i + 1}</span>
                    {ld.logo_url && (
                      <img src={ld.logo_url} alt="" className="w-4 h-4 object-contain shrink-0"
                        onError={(e) => { e.target.style.display = 'none' }} />
                    )}
                    <span className="text-xs font-semibold text-gray-800 dark:text-gray-100 truncate flex-1">
                      {ld.first_name} {ld.last_name}
                    </span>
                    <span className="text-xs font-mono font-bold text-nw-teal tabular-nums">
                      {fmtLeaderValue(cat.key, ld.value)}
                    </span>
                  </div>
                ))}
              </div>
            </Link>
          )
        })}
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
                <div className="text-xl font-extrabold text-nw-teal tabular-nums">{list.length}</div>
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
        manage a budget, hire coaches, and chase a conference title across a full
        dynasty. Included with Premium.
      </p>
      <ul className="space-y-1.5 mb-5 text-sm text-white/90">
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
