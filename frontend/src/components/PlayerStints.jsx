// PlayerStints — unifies a player's spring (school) and summer (WCL/PIL)
// seasons onto one profile page.
//
// StintRow renders one button per (season, team) the player has — spring
// schools AND summer clubs — each with the team logo. The most recent spring
// season is pre-selected; clicking a summer button shows that summer stat
// line inline (SummerStintView) instead of navigating away to a team page.
//
// All data comes from the /players/:id payload (batting_stats / pitching_stats
// for spring, summer_batting / summer_pitching for summer), so no extra fetch.

import { Link } from 'react-router-dom'

const fmtAvg = v => v == null ? '—' : Number(v).toFixed(3).replace(/^0/, '')
const fmtEra = v => v == null ? '—' : Number(v).toFixed(2)
const fmtIp  = v => v == null ? '—' : Number(v).toFixed(1)
const fmtInt = v => v == null ? '—' : Math.round(Number(v))
const fmtWar = v => v == null ? '—' : Number(v).toFixed(1)
const fmtPct = v => v == null ? '—' : `${(Number(v) * 100).toFixed(1)}%`

// Build the ordered stint list from a /players/:id payload.
// Spring seasons first (newest → oldest), then summer stints (newest → oldest).
export function buildStints(data) {
  if (!data) return []
  const p = data.player || {}
  const springLogo = p.logo_url || p.team_logo || null
  const springTeam = p.team_short || p.short_name || ''
  const bs = data.batting_stats || []
  const ps = data.pitching_stats || []

  const springSeasons = new Set()
  bs.forEach(r => r.season && springSeasons.add(Number(r.season)))
  ps.forEach(r => r.season && springSeasons.add(Number(r.season)))

  const spring = [...springSeasons].sort((a, b) => b - a).map(yr => {
    const row = bs.find(r => Number(r.season) === yr) || ps.find(r => Number(r.season) === yr) || {}
    return {
      key: `spring-${yr}`,
      kind: 'spring',
      season: yr,
      team: row.team_short || springTeam,
      logo: row.logo_url || springLogo,
      level: row.division_level || null,
    }
  })

  // Summer stints: distinct (summer player_id, season) across batting + pitching.
  const seen = new Set()
  const summer = []
  ;[...(data.summer_batting || []), ...(data.summer_pitching || [])].forEach(r => {
    if (r.season == null) return
    const k = `${r.player_id}-${r.season}`
    if (seen.has(k)) return
    seen.add(k)
    summer.push({
      key: `summer-${k}`,
      kind: 'summer',
      season: Number(r.season),
      team: r.team_short || r.team_name || 'Summer',
      logo: r.team_logo || null,
      level: r.league_abbrev || 'WCL',
      summerId: r.player_id,
    })
  })
  summer.sort((a, b) => b.season - a.season)

  return [...spring, ...summer]
}

export function defaultStint(stints) {
  return stints.find(s => s.kind === 'spring') || stints[0] || null
}

// ─── The button row ───
export function StintRow({ stints, active, onSelect }) {
  if (!stints || stints.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {stints.map(s => {
        const isActive = active && active.key === s.key
        return (
          <button
            key={s.key}
            onClick={() => onSelect(s)}
            title={`${s.season} ${s.team}${s.kind === 'summer' ? ` · ${s.level}` : ''}`}
            className={`flex items-center gap-1.5 pl-1.5 pr-2.5 py-1 rounded-full border text-xs font-semibold transition-all
              ${isActive
                ? 'bg-nw-teal text-white border-nw-teal shadow'
                : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border-gray-300 dark:border-gray-600 hover:border-nw-teal/60'}`}
          >
            {s.logo
              ? <img src={s.logo} alt="" className="w-5 h-5 object-contain rounded-sm bg-white" onError={e => { e.target.style.display = 'none' }} />
              : <span className="w-5 h-5" />}
            <span className="tabular-nums">{s.season}</span>
            <span className="opacity-90">{s.team}</span>
            {s.kind === 'summer' && (
              <span className={`text-[9px] font-bold px-1 py-0.5 rounded ${isActive ? 'bg-white/20' : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'}`}>
                {s.level}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ─── Inline summer stat view (shown when a summer button is active) ───
// Uses the summer_batting / summer_pitching rows already in the /players/:id
// payload for the selected (summer player, season). Links out to the full
// summer profile for per-game logs + plate-approach PBP.
export function SummerStintView({ stint, data, stintRow }) {
  const bat = (data.summer_batting || []).filter(r => r.player_id === stint.summerId && Number(r.season) === stint.season)
  const pit = (data.summer_pitching || []).filter(r => r.player_id === stint.summerId && Number(r.season) === stint.season)
  const meta = bat[0] || pit[0] || {}

  return (
    <div className="max-w-6xl mx-auto px-3 sm:px-4 py-4">
      {stintRow && <div className="mb-4">{stintRow}</div>}

      {/* Summer hero */}
      <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 mb-4">
        <div className="flex items-center gap-3 flex-wrap">
          {meta.team_logo && <img src={meta.team_logo} alt="" className="w-12 h-12 object-contain" loading="lazy" />}
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-lg font-bold text-gray-900 dark:text-gray-100">{stint.season} {meta.team_name || stint.team}</span>
              <span className="px-2 py-0.5 rounded text-xs font-bold bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">{stint.level}</span>
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Summer-league season</div>
          </div>
          <Link
            to={`/summer/players/${stint.summerId}`}
            className="text-xs font-semibold text-nw-teal dark:text-teal-300 hover:underline whitespace-nowrap"
          >
            Full summer profile (game logs) →
          </Link>
        </div>
      </div>

      {bat.length > 0 && (
        <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 sm:p-4 mb-4">
          <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100 mb-2">Batting</h3>
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-[12px] tabular-nums">
              <thead><tr className="border-b border-gray-200 dark:border-gray-700">
                {['Year','G','PA','AB','H','HR','R','RBI','BB','K','SB','AVG','OBP','SLG','OPS','wOBA','wRC+','ISO','BB%','K%','oWAR'].map((h, i) => (
                  <th key={h} className={`px-1.5 py-1.5 font-bold text-gray-500 dark:text-gray-400 uppercase text-[10px] ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {bat.map(r => (
                  <tr key={r.id} className="border-b border-gray-100 dark:border-gray-700/50">
                    <td className="px-1.5 py-1 text-left font-semibold">{r.season}</td>
                    <td className="px-1.5 py-1 text-right">{r.games ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.plate_appearances ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.at_bats ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.hits ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.home_runs ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.runs ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.rbi ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.walks ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.strikeouts ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.stolen_bases ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{fmtAvg(r.batting_avg)}</td>
                    <td className="px-1.5 py-1 text-right">{fmtAvg(r.on_base_pct)}</td>
                    <td className="px-1.5 py-1 text-right">{fmtAvg(r.slugging_pct)}</td>
                    <td className="px-1.5 py-1 text-right font-bold">{fmtAvg(r.ops)}</td>
                    <td className="px-1.5 py-1 text-right">{fmtAvg(r.woba)}</td>
                    <td className="px-1.5 py-1 text-right">{fmtInt(r.wrc_plus)}</td>
                    <td className="px-1.5 py-1 text-right">{fmtAvg(r.iso)}</td>
                    <td className="px-1.5 py-1 text-right">{fmtPct(r.bb_pct)}</td>
                    <td className="px-1.5 py-1 text-right">{fmtPct(r.k_pct)}</td>
                    <td className="px-1.5 py-1 text-right">{fmtWar(r.offensive_war)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {pit.length > 0 && (
        <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 sm:p-4 mb-4">
          <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100 mb-2">Pitching</h3>
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-[12px] tabular-nums">
              <thead><tr className="border-b border-gray-200 dark:border-gray-700">
                {['Year','G','GS','W','L','SV','IP','H','ER','BB','K','HR','ERA','WHIP','K/9','FIP','FIP+','ERA+','xFIP','SIERA','LOB%','K%','BB%','WAR'].map((h, i) => (
                  <th key={h} className={`px-1.5 py-1.5 font-bold text-gray-500 dark:text-gray-400 uppercase text-[10px] ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {pit.map(r => (
                  <tr key={r.id} className="border-b border-gray-100 dark:border-gray-700/50">
                    <td className="px-1.5 py-1 text-left font-semibold">{r.season}</td>
                    <td className="px-1.5 py-1 text-right">{r.games ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.games_started ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.wins ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.losses ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.saves ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{fmtIp(r.innings_pitched)}</td>
                    <td className="px-1.5 py-1 text-right">{r.hits_allowed ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.earned_runs ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.walks ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.strikeouts ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.home_runs_allowed ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right font-bold">{fmtEra(r.era)}</td>
                    <td className="px-1.5 py-1 text-right">{fmtEra(r.whip)}</td>
                    <td className="px-1.5 py-1 text-right">{fmtEra(r.k_per_9)}</td>
                    <td className="px-1.5 py-1 text-right">{fmtEra(r.fip)}</td>
                    <td className="px-1.5 py-1 text-right">{fmtInt(r.fip_plus)}</td>
                    <td className="px-1.5 py-1 text-right">{fmtInt(r.era_plus)}</td>
                    <td className="px-1.5 py-1 text-right">{fmtEra(r.xfip)}</td>
                    <td className="px-1.5 py-1 text-right">{fmtEra(r.siera)}</td>
                    <td className="px-1.5 py-1 text-right">{fmtPct(r.lob_pct)}</td>
                    <td className="px-1.5 py-1 text-right">{fmtPct(r.k_pct)}</td>
                    <td className="px-1.5 py-1 text-right">{fmtPct(r.bb_pct)}</td>
                    <td className="px-1.5 py-1 text-right">{fmtWar(r.pitching_war)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
