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
  { key: 'fip_plus',      label: 'FIP+',  format: 'int' },
  { key: 'era_plus',      label: 'ERA+',  format: 'int' },
  { key: 'xfip',          label: 'xFIP',  format: 'era' },
  { key: 'siera',         label: 'SIERA', format: 'era' },
  { key: 'pitching_war',  label: 'WAR',   format: 'war' },
  { key: 'k_bb_pct',      label: 'K-BB%', format: 'pct' },
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

// ─── Percentile Bar Row ──────────────────────────────────────
function PercentileBar({ label, value, percentile, format }) {
  const color = percentileColor(percentile)
  const barWidth = Math.max(4, percentile)
  return (
    <div className="flex items-center h-5">
      <div className="w-11 text-right pr-1.5 text-[10px] font-semibold text-gray-200 shrink-0">{label}</div>
      <div className="flex-1 relative h-4 mx-1">
        <div className="absolute top-1/2 left-0 right-0 h-1 rounded-full" style={{ transform: 'translateY(-50%)', backgroundColor: 'rgba(255,255,255,0.1)' }} />
        <div className="absolute top-1/2 left-0 h-1 rounded-full" style={{ transform: 'translateY(-50%)', width: `${barWidth}%`, backgroundColor: color, transition: 'width 0.5s ease' }} />
      </div>
      <div className="w-7 flex items-center justify-center shrink-0">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[9px] font-bold text-white" style={{ backgroundColor: color }}>
          {percentile}
        </span>
      </div>
      <div className="w-11 text-right text-[10px] text-gray-300 shrink-0">{formatStat(value, format)}</div>
    </div>
  )
}

// ─── Stat Grid Cell ───────────────────────────────────────────
function StatCell({ label, value, format }) {
  return (
    <div className="text-center">
      <div className="text-[8px] uppercase tracking-wider text-gray-400">{label}</div>
      <div className="text-[13px] font-bold text-white leading-tight">{formatStat(value, format)}</div>
    </div>
  )
}


// ═══════════════════════════════════════════════════════════════
// MAIN PAGE COMPONENT
// ═══════════════════════════════════════════════════════════════
export default function PlayerGraphic() {
  const [playerId, setPlayerId] = useState(null)
  const [selectedSeason, setSelectedSeason] = useState('latest')

  // Determine percentile_season param
  const percentileSeason = selectedSeason === 'career' ? 'career' : selectedSeason === 'latest' ? null : selectedSeason
  const { data: rawData, loading, error } = usePlayer(playerId, percentileSeason)

  // API returns { player: {...}, batting_stats: [...], pitching_stats: [...], ... }
  const info = rawData?.player || {}
  const battingStats = rawData?.batting_stats || []
  const pitchingStats = rawData?.pitching_stats || []

  // Available seasons
  const battingSeasons = battingStats.map(s => s.season)
  const pitchingSeasons = pitchingStats.map(s => s.season)
  const allSeasons = [...new Set([...battingSeasons, ...pitchingSeasons])].sort((a, b) => b - a)
  const latestSeason = allSeasons[0] || 2026

  // Active season data
  const activeSeason = selectedSeason === 'latest' ? latestSeason : selectedSeason === 'career' ? 'career' : Number(selectedSeason)

  const hasBatting = battingStats.length > 0
  const hasPitching = pitchingStats.length > 0

  // Get the stats row for the selected season
  const battingRow = activeSeason === 'career'
    ? computeCareerTotals(battingStats, 'batting')
    : battingStats.find(s => s.season === activeSeason)
  const pitchingRow = activeSeason === 'career'
    ? computeCareerTotals(pitchingStats, 'pitching')
    : pitchingStats.find(s => s.season === activeSeason)

  // Percentiles
  const battingPercentiles = rawData?.batting_percentiles || {}
  const pitchingPercentiles = rawData?.pitching_percentiles || {}
  const percentiles = { ...battingPercentiles, ...pitchingPercentiles }

  // Rankings / awards
  const pnwRankings = rawData?.pnw_rankings || []
  const awards = rawData?.awards || []

  // Build leaderboard badges with context
  const seasonLabel = activeSeason === 'career' ? 'Career' : `${activeSeason}`
  const badges = []
  for (const r of pnwRankings) {
    if (r.rank <= 3) {
      badges.push({ scope: `#${r.rank} in PNW · ${seasonLabel}`, rank: r.rank, category: r.category })
    }
  }
  for (const a of awards) {
    if (a.season === activeSeason || activeSeason === 'career') {
      badges.push({ scope: `Team Leader · ${a.team_short || 'Team'}`, rank: 1, category: a.category })
    }
  }

  // Determine stat type
  const isPitcher = hasPitching && (!hasBatting || (pitchingRow && !battingRow))
  const statsRow = isPitcher ? pitchingRow : battingRow
  const coreStats = isPitcher ? PITCHING_CORE : BATTING_CORE
  const advStats = isPitcher ? PITCHING_ADVANCED : BATTING_ADVANCED
  const percMetrics = isPitcher ? PITCHING_PERCENTILE_METRICS : BATTING_PERCENTILE_METRICS
  const availablePerc = percMetrics.filter(m => percentiles[m.key]).slice(0, 5)
  const topBadges = badges.slice(0, 3)

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

      {/* Loading / error */}
      {playerId && loading && (
        <div className="text-center py-12 text-gray-500">Loading player data...</div>
      )}
      {playerId && error && (
        <div className="text-center py-12 text-red-500">Failed to load player. Try another search.</div>
      )}

      {/* Season selector */}
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
        </div>
      )}

      {/* ═══ THE CARD (perfect square, screenshot-friendly) ═══ */}
      {rawData && (
        <div className="flex justify-center">
          <div
            className="rounded-xl overflow-hidden shadow-2xl flex flex-col"
            style={{
              width: '540px',
              height: '540px',
              background: 'linear-gradient(160deg, #0a1628 0%, #0f2744 35%, #00687a 100%)',
            }}
          >
            {/* ── Header ── */}
            <div className="px-4 pt-4 pb-2 flex items-start gap-3 shrink-0">
              <div className="shrink-0">
                {info.headshot_url ? (
                  <img src={info.headshot_url} alt="" className="w-[60px] h-[60px] rounded-full object-cover border-2 border-white/20" />
                ) : (
                  <div className="w-[60px] h-[60px] rounded-full bg-white/10 flex items-center justify-center text-lg font-bold text-white/40">
                    {info.first_name?.[0]}{info.last_name?.[0]}
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xl font-extrabold text-white leading-tight">{info.first_name} {info.last_name}</div>
                <div className="text-[10px] text-white/50 mt-0.5">
                  {[info.position, info.jersey_number ? `#${info.jersey_number}` : null, info.bats && info.throws ? `${info.bats}/${info.throws}` : null, info.year_in_school].filter(Boolean).join('  ·  ')}
                </div>
                <div className="text-[12px] font-semibold mt-0.5" style={{ color: '#7dd3fc' }}>{info.team_name}</div>
              </div>
              <div className="shrink-0 text-right">
                {info.logo_url && (
                  <img src={info.logo_url} alt="" className="w-9 h-9 object-contain opacity-40 mb-0.5" />
                )}
                <div className="text-[8px] font-bold text-white/25 uppercase tracking-wider">
                  {activeSeason === 'career' ? 'Career' : `${activeSeason}`}
                </div>
                {info.division_level && (
                  <div className="text-[8px] font-semibold mt-0.5" style={{ color: 'rgba(125,211,252,0.6)' }}>{info.division_level}</div>
                )}
              </div>
            </div>

            <div className="border-t border-white/10 mx-4" />

            {/* ── Stats body — evenly distributed ── */}
            <div className="flex-1 flex flex-col justify-evenly px-4">
              {statsRow ? (
                <>
                  {/* Core stats — single row of 8 */}
                  <div>
                    <div className="text-[8px] font-bold text-white/25 uppercase tracking-wider mb-1">
                      {isPitcher ? 'Pitching' : 'Batting'}
                    </div>
                    <div className="grid grid-cols-8 gap-x-0">
                      {coreStats.map(s => <StatCell key={s.key} label={s.label} value={statsRow[s.key]} format={s.format} />)}
                    </div>
                  </div>

                  {/* Advanced stats — single row of 8 */}
                  <div>
                    <div className="text-[8px] font-bold text-white/25 uppercase tracking-wider mb-1">Advanced</div>
                    <div className="grid grid-cols-8 gap-x-0">
                      {advStats.map(s => <StatCell key={s.key} label={s.label} value={statsRow[s.key]} format={s.format} />)}
                    </div>
                  </div>

                  <div className="border-t border-white/[0.06]" />

                  {/* Percentile bars (max 5) */}
                  {availablePerc.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-0.5">
                        <div className="text-[8px] font-bold text-white/25 uppercase tracking-wider">Percentile Rankings</div>
                        <div className="text-[7px] text-white/20">vs. {info.division_level || 'Division'}</div>
                      </div>
                      <div>
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
                    </div>
                  )}

                  {/* Leaderboard badges */}
                  {topBadges.length > 0 && (
                    <>
                      <div className="border-t border-white/[0.06]" />
                      <div>
                        <div className="text-[8px] font-bold text-white/25 uppercase tracking-wider mb-1">Leaderboard</div>
                        <div className={`grid gap-1.5 ${topBadges.length === 1 ? 'grid-cols-1' : topBadges.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
                          {topBadges.map((b, i) => (
                            <div key={i} className="rounded px-2 py-1" style={{ backgroundColor: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}>
                              <div className="text-[10px] font-bold text-white truncate">{b.category}</div>
                              <div className="text-[7px] text-white/35 truncate">{b.scope}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center text-white/40 text-sm">No stats for this season.</div>
              )}
            </div>

            {/* ── Footer ── */}
            <div className="border-t border-white/[0.06] mx-4 shrink-0" />
            <div className="px-4 py-1.5 flex items-center justify-between shrink-0">
              <span className="text-[8px] text-white/20 font-medium">nwbaseballstats.com</span>
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
