import { useState, useEffect, useRef } from 'react'
import { usePlayer } from '../hooks/useApi'
import { formatStat } from '../utils/stats'

// ─── Percentile color (Savant-style blue→gray→red) ────────────
function percentileColor(pct) {
  const stops = [
    [1,   23,  57, 122],
    [10,  36,  90, 163],
    [20,  62, 130, 202],
    [30, 108, 172, 221],
    [40, 162, 200, 226],
    [50, 186, 186, 186],
    [60, 219, 183, 163],
    [70, 217, 147, 130],
    [80, 209, 107,  97],
    [90, 193,  58,  55],
    [99, 174,  10,  32],
  ]
  const p = Math.max(1, Math.min(99, pct))
  let lo = stops[0], hi = stops[stops.length - 1]
  for (let i = 0; i < stops.length - 1; i++) {
    if (p >= stops[i][0] && p <= stops[i + 1][0]) {
      lo = stops[i]; hi = stops[i + 1]; break
    }
  }
  const t = hi[0] === lo[0] ? 0 : (p - lo[0]) / (hi[0] - lo[0])
  const r = Math.round(lo[1] + t * (hi[1] - lo[1]))
  const g = Math.round(lo[2] + t * (hi[2] - lo[2]))
  const b = Math.round(lo[3] + t * (hi[3] - lo[3]))
  return `rgb(${r},${g},${b})`
}

// ─── Career total computation ─────────────────────────────────
function computeCareerTotals(seasons, type) {
  if (!seasons.length) return null
  const sumKeys = type === 'batting'
    ? ['games', 'plate_appearances', 'at_bats', 'runs', 'hits', 'doubles', 'triples',
       'home_runs', 'rbi', 'walks', 'strikeouts', 'hit_by_pitch', 'sacrifice_flies',
       'stolen_bases', 'caught_stealing']
    : ['games', 'games_started', 'wins', 'losses', 'saves', 'innings_pitched',
       'hits_allowed', 'earned_runs', 'walks', 'strikeouts', 'home_runs_allowed',
       'hit_batters', 'wild_pitches', 'batters_faced']
  const totals = { season: 'Career' }
  for (const k of sumKeys) totals[k] = seasons.reduce((s, row) => s + (row[k] || 0), 0)

  if (type === 'batting') {
    const { at_bats: ab, hits: h, walks: bb, hit_by_pitch: hbp,
            sacrifice_flies: sf, doubles: d2, triples: d3, home_runs: hr } = totals
    const pa = totals.plate_appearances
    totals.batting_avg = ab > 0 ? h / ab : null
    totals.on_base_pct = pa > 0 ? (h + bb + (hbp || 0)) / (ab + bb + (hbp || 0) + (sf || 0)) : null
    const tb = h + d2 + 2 * d3 + 3 * hr
    totals.slugging_pct = ab > 0 ? tb / ab : null
    totals.ops = (totals.on_base_pct || 0) + (totals.slugging_pct || 0)
    totals.iso = ab > 0 ? (totals.slugging_pct - totals.batting_avg) : null
    totals.woba = null
    totals.wrc_plus = null
    totals.bb_pct = pa > 0 ? bb / pa : null
    totals.k_pct = pa > 0 ? totals.strikeouts / pa : null
    totals.offensive_war = seasons.reduce((s, r) => s + (r.offensive_war || 0), 0)
  } else {
    const { earned_runs: er, innings_pitched: ip, walks: bb, hits_allowed: h,
            strikeouts: k, batters_faced: bf } = totals
    totals.era = ip > 0 ? (er / ip) * 9 : null
    totals.whip = ip > 0 ? (bb + h) / ip : null
    totals.fip = null
    totals.k_pct = bf > 0 ? k / bf : null
    totals.bb_pct = bf > 0 ? bb / bf : null
    totals.pitching_war = seasons.reduce((s, r) => s + (r.pitching_war || 0), 0)
  }
  return totals
}

// ─── Stat display configs ─────────────────────────────────────
const BATTING_PERCENTILE_METRICS = [
  { key: 'woba',          label: 'wOBA',  format: 'avg' },
  { key: 'wrc_plus',      label: 'wRC+',  format: 'int' },
  { key: 'iso',           label: 'ISO',   format: 'avg' },
  { key: 'bb_pct',        label: 'BB%',   format: 'pct' },
  { key: 'k_pct',         label: 'K%',    format: 'pct' },
  { key: 'offensive_war', label: 'WAR',   format: 'war' },
  { key: 'stolen_bases',  label: 'SB',    format: 'int' },
]

const PITCHING_PERCENTILE_METRICS = [
  { key: 'k_pct',         label: 'K%',    format: 'pct' },
  { key: 'bb_pct',        label: 'BB%',   format: 'pct' },
  { key: 'fip',           label: 'FIP',   format: 'era' },
  { key: 'xfip',          label: 'xFIP',  format: 'era' },
  { key: 'siera',         label: 'SIERA', format: 'era' },
  { key: 'lob_pct',       label: 'LOB%',  format: 'pct' },
  { key: 'pitching_war',  label: 'WAR',   format: 'war' },
  { key: 'h_per_9',       label: 'H/9',   format: 'era' },
  { key: 'hr_per_9',      label: 'HR/9',  format: 'era' },
]

const BATTING_CORE = [
  { key: 'games', label: 'G', format: 'int' },
  { key: 'plate_appearances', label: 'PA', format: 'int' },
  { key: 'hits', label: 'H', format: 'int' },
  { key: 'home_runs', label: 'HR', format: 'int' },
  { key: 'rbi', label: 'RBI', format: 'int' },
  { key: 'stolen_bases', label: 'SB', format: 'int' },
  { key: 'runs', label: 'R', format: 'int' },
  { key: 'walks', label: 'BB', format: 'int' },
]

const BATTING_ADVANCED = [
  { key: 'batting_avg', label: 'AVG', format: 'avg' },
  { key: 'on_base_pct', label: 'OBP', format: 'avg' },
  { key: 'slugging_pct', label: 'SLG', format: 'avg' },
  { key: 'ops', label: 'OPS', format: 'avg' },
  { key: 'woba', label: 'wOBA', format: 'avg' },
  { key: 'wrc_plus', label: 'wRC+', format: 'int' },
  { key: 'iso', label: 'ISO', format: 'avg' },
  { key: 'offensive_war', label: 'oWAR', format: 'war' },
]

const PITCHING_CORE = [
  { key: 'wins', label: 'W', format: 'int' },
  { key: 'losses', label: 'L', format: 'int' },
  { key: 'saves', label: 'SV', format: 'int' },
  { key: 'games', label: 'G', format: 'int' },
  { key: 'games_started', label: 'GS', format: 'int' },
  { key: 'innings_pitched', label: 'IP', format: 'ip' },
  { key: 'strikeouts', label: 'K', format: 'int' },
  { key: 'walks', label: 'BB', format: 'int' },
]

const PITCHING_ADVANCED = [
  { key: 'era', label: 'ERA', format: 'era' },
  { key: 'whip', label: 'WHIP', format: 'era' },
  { key: 'fip', label: 'FIP', format: 'era' },
  { key: 'fip_plus', label: 'FIP+', format: 'int' },
  { key: 'era_plus', label: 'ERA+', format: 'int' },
  { key: 'xfip', label: 'xFIP', format: 'era' },
  { key: 'siera', label: 'SIERA', format: 'era' },
  { key: 'pitching_war', label: 'WAR', format: 'war' },
]

// Pie chart colors
const PIE_COLORS = {
  '1B': '#10b981', '2B': '#f59e0b', '3B': '#f97316', 'HR': '#ef4444',
  'BB': '#3b82f6', 'HBP': '#a855f7', 'H': '#f59e0b', 'K': '#10b981',
}


// ─── Player Search Component ──────────────────────────────────
function PlayerSearchBox({ onSelect }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const debounceRef = useRef(null)

  useEffect(() => {
    if (query.length < 2) { setResults([]); setOpen(false); return }
    setLoading(true)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/v1/players/search?q=${encodeURIComponent(query)}`)
        const data = await res.json()
        setResults(Array.isArray(data) ? data : data.players || [])
        setOpen(true)
      } catch { setResults([]) }
      setLoading(false)
    }, 300)
    return () => clearTimeout(debounceRef.current)
  }, [query])

  return (
    <div className="relative w-full max-w-md">
      <input
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Search for a player..."
        className="w-full px-4 py-2.5 rounded-lg border border-gray-300 focus:border-nw-teal focus:ring-1 focus:ring-nw-teal text-sm"
      />
      {loading && (
        <div className="absolute right-3 top-3 w-4 h-4 border-2 border-nw-teal border-t-transparent rounded-full animate-spin" />
      )}
      {open && results.length > 0 && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-y-auto">
          {results.map(p => (
            <button
              key={p.id}
              onClick={() => { onSelect(p.id); setQuery(p.first_name + ' ' + p.last_name); setOpen(false) }}
              className="w-full text-left px-4 py-2.5 hover:bg-gray-50 flex items-center gap-3 border-b border-gray-100 last:border-b-0"
            >
              {p.headshot_url ? (
                <img src={p.headshot_url} alt="" className="w-8 h-8 rounded-full object-cover" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-xs text-gray-500">
                  {p.first_name?.[0]}{p.last_name?.[0]}
                </div>
              )}
              <div>
                <div className="text-sm font-medium text-gray-900">{p.first_name} {p.last_name}</div>
                <div className="text-xs text-gray-500">{p.team_name} · {p.position}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}


// ─── SVG Pie Chart ────────────────────────────────────────────
function OnBasePieChart({ statsRow, isPitcher, size = 82 }) {
  if (!statsRow) return null

  let slices = []
  if (isPitcher) {
    const nonHrHits = Math.max(0, (statsRow.hits_allowed || 0) - (statsRow.home_runs_allowed || 0))
    slices = [
      { label: 'H', value: nonHrHits, color: PIE_COLORS['H'] },
      { label: 'HR', value: statsRow.home_runs_allowed || 0, color: PIE_COLORS['HR'] },
      { label: 'BB', value: statsRow.walks || 0, color: PIE_COLORS['BB'] },
      { label: 'HBP', value: statsRow.hit_batters || 0, color: PIE_COLORS['HBP'] },
    ]
  } else {
    const singles = Math.max(0, (statsRow.hits || 0) - (statsRow.doubles || 0) - (statsRow.triples || 0) - (statsRow.home_runs || 0))
    slices = [
      { label: '1B', value: singles, color: PIE_COLORS['1B'] },
      { label: '2B', value: statsRow.doubles || 0, color: PIE_COLORS['2B'] },
      { label: '3B', value: statsRow.triples || 0, color: PIE_COLORS['3B'] },
      { label: 'HR', value: statsRow.home_runs || 0, color: PIE_COLORS['HR'] },
      { label: 'BB', value: statsRow.walks || 0, color: PIE_COLORS['BB'] },
      { label: 'HBP', value: statsRow.hit_by_pitch || 0, color: PIE_COLORS['HBP'] },
    ]
  }

  slices = slices.filter(s => s.value > 0)
  const total = slices.reduce((s, sl) => s + sl.value, 0)
  if (total === 0) return null

  const cx = size / 2, cy = size / 2, r = size / 2 - 1
  let angle = -Math.PI / 2

  const paths = slices.map(sl => {
    const pct = sl.value / total
    const startAngle = angle
    const endAngle = angle + pct * 2 * Math.PI
    angle = endAngle

    // Handle full circle (single slice)
    if (pct >= 0.999) {
      return { ...sl, pct, d: `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} Z` }
    }

    const x1 = cx + r * Math.cos(startAngle)
    const y1 = cy + r * Math.sin(startAngle)
    const x2 = cx + r * Math.cos(endAngle)
    const y2 = cy + r * Math.sin(endAngle)
    const largeArc = pct > 0.5 ? 1 : 0

    return { ...sl, pct, d: `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z` }
  })

  return (
    <div className="flex items-center gap-3">
      <svg width={size} height={size} className="shrink-0">
        {paths.map((p, i) => (
          <path key={i} d={p.d} fill={p.color} stroke="rgba(10,22,40,0.9)" strokeWidth={1.5} />
        ))}
        {/* Center hole for donut effect */}
        <circle cx={cx} cy={cy} r={r * 0.45} fill="rgba(10,22,40,0.95)" />
      </svg>
      <div className="flex flex-col gap-0.5">
        {paths.map((p, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: p.color }} />
            <span className="text-[9px] text-white/70 font-medium">{p.label}</span>
            <span className="text-[9px] text-white/40">{Math.round(p.pct * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}


// ─── Percentile Bar (compact) ─────────────────────────────────
function PercentileBar({ label, value, percentile, format }) {
  const color = percentileColor(percentile)
  const barWidth = Math.max(4, percentile)
  return (
    <div className="flex items-center" style={{ height: '22px' }}>
      <div className="text-right pr-1.5 text-[9px] font-bold text-white/50 shrink-0" style={{ width: '38px' }}>{label}</div>
      <div className="flex-1 relative mx-1" style={{ height: '5px' }}>
        <div className="absolute inset-0 rounded-full" style={{ backgroundColor: 'rgba(255,255,255,0.07)' }} />
        <div className="absolute top-0 left-0 h-full rounded-full transition-all duration-500" style={{ width: `${barWidth}%`, backgroundColor: color }} />
      </div>
      <div className="flex items-center justify-center shrink-0" style={{ width: '24px' }}>
        <span className="inline-flex items-center justify-center rounded-full text-white font-bold" style={{ width: '18px', height: '18px', fontSize: '8px', backgroundColor: color }}>
          {percentile}
        </span>
      </div>
      <div className="text-right text-[9px] text-white/40 shrink-0" style={{ width: '38px' }}>{formatStat(value, format)}</div>
    </div>
  )
}


// ─── Stat Cell (with borders) ─────────────────────────────────
function StatCell({ label, value, format, borderRight = true }) {
  return (
    <div className={`text-center py-1 ${borderRight ? 'border-r border-white/[0.06]' : ''}`}>
      <div className="text-[7px] uppercase tracking-wider text-white/30 leading-none mb-0.5">{label}</div>
      <div className="text-[13px] font-bold text-white leading-none">{formatStat(value, format)}</div>
    </div>
  )
}


// ═══════════════════════════════════════════════════════════════
// MAIN PAGE COMPONENT
// ═══════════════════════════════════════════════════════════════
export default function PlayerGraphic() {
  const [playerId, setPlayerId] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    const id = params.get('id')
    return id ? Number(id) : null
  })
  const [selectedSeason, setSelectedSeason] = useState('latest')
  const [statMode, setStatMode] = useState(null)
  const [teamInfo, setTeamInfo] = useState(null)

  const percentileSeason = selectedSeason === 'career' ? 'career' : selectedSeason === 'latest' ? null : selectedSeason
  const { data: rawData, loading, error } = usePlayer(playerId, percentileSeason)

  const info = rawData?.player || {}
  const battingStats = rawData?.batting_stats || []
  const pitchingStats = rawData?.pitching_stats || []
  const teamHistory = rawData?.team_history || []
  const awards = rawData?.awards || []
  const pnwRankings = rawData?.pnw_rankings || []
  const careerRankings = rawData?.career_rankings || []

  const battingSeasons = battingStats.map(s => s.season)
  const pitchingSeasons = pitchingStats.map(s => s.season)
  const allSeasons = [...new Set([...battingSeasons, ...pitchingSeasons])].sort((a, b) => b - a)
  const latestSeason = allSeasons[0] || 2026

  const activeSeason = selectedSeason === 'latest' ? latestSeason : selectedSeason === 'career' ? 'career' : Number(selectedSeason)

  const hasBatting = battingStats.length > 0
  const hasPitching = pitchingStats.length > 0

  const battingRow = activeSeason === 'career'
    ? computeCareerTotals(battingStats, 'batting')
    : battingStats.find(s => s.season === activeSeason)
  const pitchingRow = activeSeason === 'career'
    ? computeCareerTotals(pitchingStats, 'pitching')
    : pitchingStats.find(s => s.season === activeSeason)

  const battingPercentiles = rawData?.batting_percentiles || {}
  const pitchingPercentiles = rawData?.pitching_percentiles || {}
  const percentiles = { ...battingPercentiles, ...pitchingPercentiles }

  const isTwoWay = hasBatting && hasPitching
  const autoIsPitcher = hasPitching && (!hasBatting || (pitchingRow && !battingRow))
  const isPitcher = statMode ? statMode === 'pitching' : autoIsPitcher
  const statsRow = isPitcher ? pitchingRow : battingRow
  const coreStats = isPitcher ? PITCHING_CORE : BATTING_CORE
  const advStats = isPitcher ? PITCHING_ADVANCED : BATTING_ADVANCED
  const percMetrics = isPitcher ? PITCHING_PERCENTILE_METRICS : BATTING_PERCENTILE_METRICS
  const availablePerc = percMetrics.filter(m => percentiles[m.key]).slice(0, 7)

  // Fetch team record + national ranking
  useEffect(() => {
    if (!info.team_id) return
    const season = activeSeason === 'career' ? 2026 : activeSeason
    Promise.all([
      fetch(`/api/v1/team-ratings?season=${season}`).then(r => r.json()).catch(() => []),
      fetch(`/api/v1/national-rankings?season=${season}`).then(r => r.json()).catch(() => []),
    ]).then(([ratingsData, rankingsData]) => {
      // Find team in ratings (grouped by division)
      let record = null
      const divisions = Array.isArray(ratingsData) ? ratingsData : []
      for (const div of divisions) {
        const team = (div.teams || []).find(t => t.id === info.team_id)
        if (team) { record = team; break }
      }
      // Find team in national rankings
      let ranking = null
      const rankDivisions = Array.isArray(rankingsData) ? rankingsData : []
      for (const div of rankDivisions) {
        const team = (div.teams || []).find(t => t.team_id === info.team_id)
        if (team) { ranking = team; break }
      }
      setTeamInfo({ record, ranking })
    })
  }, [info.team_id, activeSeason])

  // Deduplicate career history (one entry per team, showing year range)
  const careerEntries = (() => {
    if (!teamHistory.length) return []
    const grouped = {}
    for (const th of teamHistory) {
      const key = th.team_id || th.team_short
      if (!grouped[key]) {
        grouped[key] = { ...th, seasons: [th.season] }
      } else {
        grouped[key].seasons.push(th.season)
      }
    }
    return Object.values(grouped).map(g => ({
      ...g,
      seasonRange: g.seasons.length === 1
        ? String(g.seasons[0])
        : `${Math.min(...g.seasons)}-${String(Math.max(...g.seasons)).slice(-2)}`,
    })).sort((a, b) => Math.min(...a.seasons) - Math.min(...b.seasons))
  })()

  // Build awards/rankings display items (max 3 for space)
  const displayItems = (() => {
    const items = []
    // Season awards first
    for (const a of awards) {
      items.push({ icon: '\u2B50', text: `${a.award_name || a.category}`, sub: String(a.season) })
    }
    // PNW rankings (top 5 only)
    for (const r of pnwRankings.filter(r => r.rank <= 5).slice(0, 4)) {
      const ordinal = r.rank === 1 ? '1st' : r.rank === 2 ? '2nd' : r.rank === 3 ? '3rd' : `${r.rank}th`
      items.push({ icon: '\uD83C\uDFC6', text: `${ordinal} in ${r.stat_display || r.stat_name}`, sub: info.division_level || '' })
    }
    // Career rankings as fallback
    if (items.length === 0) {
      for (const r of careerRankings.slice(0, 4)) {
        const ordinal = r.rank === 1 ? '1st' : r.rank === 2 ? '2nd' : r.rank === 3 ? '3rd' : `${r.rank}th`
        items.push({ icon: '\uD83D\uDCCA', text: `${ordinal} on team in ${r.stat_display || r.stat_name}`, sub: '' })
      }
    }
    return items.slice(0, 3)
  })()

  // ═══════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════
  return (
    <div className="space-y-6">
      {/* Page title + search */}
      <div>
        <h1 className="text-2xl font-bold text-gray-800 mb-1">Player Pages</h1>
        <p className="text-sm text-gray-500 mb-4">Generate a shareable player graphic. Screenshot to save.</p>
        <PlayerSearchBox onSelect={setPlayerId} />
      </div>

      {playerId && loading && (
        <div className="text-center py-12 text-gray-500">Loading player data...</div>
      )}
      {playerId && error && (
        <div className="text-center py-12 text-red-500">Failed to load player. Try another search.</div>
      )}

      {/* Season selector + two-way toggle */}
      {rawData && (
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={selectedSeason}
            onChange={e => setSelectedSeason(e.target.value)}
            className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm"
          >
            <option value="latest">Latest Season ({latestSeason})</option>
            {allSeasons.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
            <option value="career">Career</option>
          </select>
          {isTwoWay && (
            <div className="inline-flex bg-gray-200 rounded-lg p-0.5">
              <button
                onClick={() => setStatMode('batting')}
                className={`px-3 py-1 rounded-md text-xs font-bold transition-all ${
                  isPitcher === false ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                Hitting
              </button>
              <button
                onClick={() => setStatMode('pitching')}
                className={`px-3 py-1 rounded-md text-xs font-bold transition-all ${
                  isPitcher === true ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                Pitching
              </button>
            </div>
          )}
        </div>
      )}

      {/* ═══ THE CARD ═══ */}
      {rawData && (
        <div className="flex justify-center">
          <div
            className="overflow-hidden flex flex-col"
            style={{
              width: '540px',
              height: '640px',
              background: 'linear-gradient(160deg, #0a1628 0%, #0f2744 35%, #00687a 100%)',
              borderRadius: '12px',
            }}
          >
            {/* ── HEADER ── */}
            <div className="flex items-center px-4 pt-3 pb-2 shrink-0" style={{ minHeight: '76px' }}>
              {/* Headshot */}
              <div className="shrink-0">
                {info.headshot_url ? (
                  <img src={info.headshot_url} alt="" className="rounded-full object-cover border-2 border-white/20" style={{ width: '56px', height: '56px' }} />
                ) : (
                  <div className="rounded-full bg-white/10 flex items-center justify-center text-lg font-bold text-white/40" style={{ width: '56px', height: '56px' }}>
                    {info.first_name?.[0]}{info.last_name?.[0]}
                  </div>
                )}
              </div>

              {/* Center: Name + Info */}
              <div className="flex-1 text-center px-3 min-w-0">
                <div className="text-[22px] font-extrabold text-white leading-tight truncate">
                  {info.first_name} {info.last_name}
                </div>
                <div className="text-[10px] text-white/45 mt-0.5">
                  {[info.position, info.jersey_number ? `#${info.jersey_number}` : null, info.bats && info.throws ? `${info.bats}/${info.throws}` : null, info.year_in_school].filter(Boolean).join('  \u00B7  ')}
                </div>
                <div className="text-[12px] font-semibold mt-0.5" style={{ color: '#7dd3fc' }}>
                  {info.team_name}
                </div>
              </div>

              {/* Team logo (mirrored on right) */}
              <div className="shrink-0 flex flex-col items-center">
                {info.logo_url ? (
                  <img src={info.logo_url} alt="" className="object-contain" style={{ width: '52px', height: '52px', opacity: 0.7 }} />
                ) : (
                  <div style={{ width: '52px', height: '52px' }} />
                )}
                <div className="text-[8px] font-bold text-white/25 uppercase tracking-wider mt-0.5">
                  {info.division_level}
                </div>
              </div>
            </div>

            {/* ── STAT TABLES ── */}
            <div className="mx-3 shrink-0 rounded-lg overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
              {statsRow ? (
                <>
                  {/* Core stats row */}
                  <div className="flex items-center px-2 py-0.5" style={{ backgroundColor: 'rgba(255,255,255,0.03)' }}>
                    <span className="text-[7px] font-bold text-white/25 uppercase tracking-wider">
                      {isPitcher ? 'Pitching' : 'Batting'}
                    </span>
                    <span className="text-[7px] text-white/15 ml-auto">
                      {activeSeason === 'career' ? 'Career' : activeSeason}
                    </span>
                  </div>
                  <div className="grid grid-cols-8" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                    {coreStats.map((s, i) => (
                      <StatCell key={s.key} label={s.label} value={statsRow[s.key]} format={s.format} borderRight={i < coreStats.length - 1} />
                    ))}
                  </div>
                  {/* Advanced stats row */}
                  <div className="flex items-center px-2 py-0.5" style={{ backgroundColor: 'rgba(255,255,255,0.03)', borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                    <span className="text-[7px] font-bold text-white/25 uppercase tracking-wider">Advanced</span>
                  </div>
                  <div className="grid grid-cols-8" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                    {advStats.map((s, i) => (
                      <StatCell key={s.key} label={s.label} value={statsRow[s.key]} format={s.format} borderRight={i < advStats.length - 1} />
                    ))}
                  </div>
                </>
              ) : (
                <div className="py-4 text-center text-white/30 text-xs">No stats for this season.</div>
              )}
            </div>

            {/* ── BOTTOM SPLIT ── */}
            <div className="flex-1 flex mx-3 mt-2 min-h-0">
              {/* LEFT: Percentile Bars */}
              <div className="flex-1 flex flex-col pr-2" style={{ borderRight: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[8px] font-bold text-white/25 uppercase tracking-wider">Percentile Rankings</span>
                </div>
                {availablePerc.length > 0 ? (
                  <div className="flex flex-col justify-evenly flex-1">
                    {availablePerc.map(m => (
                      <PercentileBar
                        key={m.key}
                        label={m.label}
                        value={percentiles[m.key].value}
                        percentile={percentiles[m.key].percentile}
                        format={m.format}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-white/20 text-[10px]">
                    Not enough PA to qualify
                  </div>
                )}
                <div className="text-[7px] text-white/20 mt-1">vs. {info.division_level || 'Division'}</div>
              </div>

              {/* RIGHT: Pie + Career + Awards + Team */}
              <div className="flex-1 flex flex-col pl-2 min-w-0">
                {/* Pie Chart */}
                {statsRow && (
                  <div className="mb-2">
                    <div className="text-[8px] font-bold text-white/25 uppercase tracking-wider mb-1.5">
                      {isPitcher ? 'Baserunners Allowed' : 'Reaching Base'}
                    </div>
                    <OnBasePieChart statsRow={statsRow} isPitcher={isPitcher} size={76} />
                  </div>
                )}

                {/* Career History */}
                {careerEntries.length > 0 && (
                  <div className="mb-2">
                    <div className="text-[8px] font-bold text-white/25 uppercase tracking-wider mb-1">Career</div>
                    <div className="space-y-0.5">
                      {careerEntries.map((entry, i) => (
                        <div key={i} className="flex items-center gap-1.5">
                          {entry.logo_url && (
                            <img src={entry.logo_url} alt="" className="w-3.5 h-3.5 object-contain shrink-0 opacity-70" />
                          )}
                          <span className="text-[9px] text-white/50 shrink-0">{entry.seasonRange}</span>
                          <span className="text-[9px] text-white/70 font-medium truncate">{entry.team_short || entry.team_name}</span>
                          <span className="text-[8px] text-white/25 shrink-0">({entry.division_level})</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Team Info */}
                {teamInfo?.record && (
                  <div className="mb-2">
                    <div className="text-[8px] font-bold text-white/25 uppercase tracking-wider mb-1">Team</div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-[10px] text-white/70 font-semibold">
                        {teamInfo.record.wins}-{teamInfo.record.losses}
                      </span>
                      {teamInfo.record.conf_wins != null && (
                        <span className="text-[9px] text-white/40">
                          ({teamInfo.record.conf_wins}-{teamInfo.record.conf_losses} conf)
                        </span>
                      )}
                      {teamInfo.ranking?.composite_rank && (
                        <span className="text-[9px] font-semibold" style={{ color: '#7dd3fc' }}>
                          #{teamInfo.ranking.composite_rank} {info.division_level}
                        </span>
                      )}
                    </div>
                    {teamInfo.record.conference_abbrev && (
                      <div className="text-[8px] text-white/30 mt-0.5">{teamInfo.record.conference_name || teamInfo.record.conference_abbrev}</div>
                    )}
                  </div>
                )}

                {/* Awards / Rankings */}
                {displayItems.length > 0 && (
                  <div className="mt-auto">
                    <div className="text-[8px] font-bold text-white/25 uppercase tracking-wider mb-1">
                      {awards.length > 0 ? 'Awards' : 'Rankings'}
                    </div>
                    <div className="space-y-0.5">
                      {displayItems.map((item, i) => (
                        <div key={i} className="flex items-start gap-1.5">
                          <span className="text-[9px] shrink-0">{item.icon}</span>
                          <div className="min-w-0">
                            <span className="text-[9px] text-white/60 leading-tight">{item.text}</span>
                            {item.sub && <span className="text-[8px] text-white/25 ml-1">{item.sub}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* ── FOOTER ── */}
            <div className="mx-3 mt-1 shrink-0" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }} />
            <div className="px-4 py-1 flex items-center justify-between shrink-0">
              <span className="text-[8px] text-white/20 font-medium">pnwbaseballstats.com</span>
              <span className="text-[8px] text-white/20 font-medium">{activeSeason === 'career' ? 'Career' : `${activeSeason} Season`}</span>
            </div>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!playerId && (
        <div className="text-center py-16 text-gray-400">
          <svg className="w-16 h-16 mx-auto mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0" />
          </svg>
          <p className="text-lg font-medium text-gray-500 mb-1">Search for a player above</p>
          <p className="text-sm">Generate a shareable graphic with their stats, percentiles, and rankings.</p>
        </div>
      )}
    </div>
  )
}
