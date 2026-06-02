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
import { useApi } from '../hooks/useApi'
import SummerPlayerProfile from '../pages/SummerPlayerProfile'

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
// Fetches the full summer payload for the selected (summer player, season)
// and renders the same rich SummerPlayerProfile as the standalone
// /summer/players/:id page (hero, percentile bars, radar, charts, PBP
// approach), so toggling to a summer stint looks identical to the spring
// side. The stint button row is passed through as the season selector.
export function SummerStintView({ stint, data: _data, stintRow }) {
  const { data: summer, loading, error } = useApi(
    `/summer/players/${stint.summerId}`,
    { season: stint.season },
  )

  if (loading) {
    return (
      <>
        {stintRow && <div className="mb-4">{stintRow}</div>}
        <div className="flex justify-center py-20">
          <div className="animate-spin h-8 w-8 border-4 border-nw-teal border-t-transparent rounded-full" />
        </div>
      </>
    )
  }
  if (error || !summer?.player) {
    return (
      <>
        {stintRow && <div className="mb-4">{stintRow}</div>}
        <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 text-center text-sm text-gray-500 dark:text-gray-400">
          Could not load this summer profile.{' '}
          <Link to={`/summer/players/${stint.summerId}`} className="text-nw-teal dark:text-teal-300 underline">
            Open the full summer page →
          </Link>
        </div>
      </>
    )
  }

  return <SummerPlayerProfile data={summer} seasonSelector={stintRow} />
}
