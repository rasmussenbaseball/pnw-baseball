// SummerPlayerDetail — /summer/players/:id
//
// Bio + season slash line + per-game log + cross-link to spring
// player profile when available (summer_player_links).

import { Link, useParams } from 'react-router-dom'
import { useApi } from '../hooks/useApi'

const fmtAvg = v => v == null ? '—' : Number(v).toFixed(3).replace(/^0/, '')
const fmtIp  = v => v == null ? '—' : Number(v).toFixed(1)
const fmtEra = v => v == null ? '—' : Number(v).toFixed(2)
const fmtInt = v => v == null ? '—' : Math.round(v)
const fmtPct = v => v == null ? '—' : `${(Number(v) * 100).toFixed(1)}%`
const fmtDate = d => {
  if (!d) return ''
  const dt = new Date(d)
  return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`
}

export default function SummerPlayerDetail() {
  const { id } = useParams()
  const { data, loading, error } = useApi(`/summer/players/${id}`)

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <div className="animate-spin h-8 w-8 border-4 border-nw-teal border-t-transparent rounded-full" />
      </div>
    )
  }
  if (error || !data?.player) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-12 text-center text-gray-500 dark:text-gray-400">
        {error || 'Player not found.'}{' '}
        <Link to="/summer" className="text-nw-teal dark:text-teal-300 underline">Back to Summer Hub</Link>
      </div>
    )
  }

  const { player, batting, pitching, fielding, game_batting, game_pitching, spring_link, approach } = data
  const hasBatting = batting?.length > 0
  const hasPitching = pitching?.length > 0
  const hasFielding = fielding?.length > 0

  return (
    <div className="max-w-6xl mx-auto px-3 sm:px-4 py-4">
      <Link to="/summer" className="inline-block text-xs text-nw-teal dark:text-teal-300 hover:underline mb-3">
        ← Summer Hub
      </Link>

      {/* Hero */}
      <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 sm:p-5 mb-4">
        <div className="flex items-center gap-3 sm:gap-4 flex-wrap">
          <div className="w-14 h-14 sm:w-16 sm:h-16 rounded bg-gray-200 dark:bg-gray-700 flex items-center justify-center font-bold text-gray-500 dark:text-gray-400">
            {(player.first_name?.[0] || '')}{(player.last_name?.[0] || '')}
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-gray-100">
              {player.first_name} {player.last_name}
              {player.jersey_number && <span className="ml-2 text-gray-400 dark:text-gray-500 font-normal">#{player.jersey_number}</span>}
            </h1>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mt-1 text-sm">
              <Link to={`/summer/teams/${player.team_id}`}
                className="text-nw-teal dark:text-teal-300 hover:underline font-semibold flex items-center gap-1.5">
                {player.team_logo && <img src={player.team_logo} alt="" className="w-5 h-5 object-contain" loading="lazy" />}
                {player.team_short || player.team_name}
              </Link>
              <span className="px-2 py-0.5 rounded text-xs font-bold bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
                {player.league_abbr}
              </span>
              {player.position && (
                <span className="text-gray-600 dark:text-gray-400 uppercase text-xs font-semibold">{player.position}</span>
              )}
              {player.year_in_school && (
                <span className="text-gray-500 dark:text-gray-400 text-xs">{player.year_in_school}</span>
              )}
            </div>
            {(player.college || player.hometown) && (
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {player.college && <>College: <span className="font-semibold text-gray-700 dark:text-gray-300">{player.college}</span>{player.hometown && ' · '}</>}
                {player.hometown && <>From: <span className="font-semibold text-gray-700 dark:text-gray-300">{player.hometown}</span></>}
              </div>
            )}
            {spring_link && (
              <Link
                to={`/player/${spring_link.spring_player_id}`}
                className="mt-2 inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-semibold bg-teal-50 dark:bg-teal-900/30 text-teal-800 dark:text-teal-200 hover:bg-teal-100 dark:hover:bg-teal-900/50"
              >
                {spring_link.spring_team_logo && <img src={spring_link.spring_team_logo} alt="" className="w-4 h-4 object-contain" loading="lazy" />}
                View college profile: {spring_link.spring_first} {spring_link.spring_last}
                {spring_link.spring_team_short && <span className="text-teal-600 dark:text-teal-400"> · {spring_link.spring_team_short}</span>}
              </Link>
            )}
          </div>
        </div>
      </div>

      {/* Season tables */}
      {hasBatting && (
        <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 sm:p-4 mb-4">
          <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100 mb-2">Batting · by Season</h3>
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-[12px] tabular-nums">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  {['Year','G','PA','AB','H','2B','3B','HR','R','RBI','BB','K','SB','AVG','OBP','SLG','OPS'].map((h, i) => (
                    <th key={h} className={`px-1.5 py-1.5 font-bold text-gray-500 dark:text-gray-400 uppercase text-[10px] ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {batting.map(r => (
                  <tr key={r.id} className="border-b border-gray-100 dark:border-gray-700/50">
                    <td className="px-1.5 py-1 text-left font-semibold">{r.season}</td>
                    <td className="px-1.5 py-1 text-right">{r.games ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.plate_appearances ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.at_bats ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.hits ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.doubles ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.triples ?? '—'}</td>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {approach && (
        <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 sm:p-4 mb-4">
          <div className="flex items-baseline justify-between mb-2 flex-wrap gap-1">
            <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">Plate Approach · {approach.season}</h3>
            <span className="text-[11px] text-gray-500 dark:text-gray-400">
              From play-by-play · {approach.pa} PA, {approach.pitches_seen} pitches
            </span>
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {[
              ['Swing%', approach.swing_pct],
              ['Contact%', approach.contact_pct],
              ['Whiff%', approach.whiff_pct],
              ['1st-Pitch Sw%', approach.first_pitch_swing_pct],
              ['K%', approach.k_pct],
              ['BB%', approach.bb_pct],
            ].map(([label, val]) => (
              <div key={label} className="rounded bg-gray-50 dark:bg-gray-900/40 border border-gray-100 dark:border-gray-700 p-2 text-center">
                <div className="text-base sm:text-lg font-bold text-gray-900 dark:text-gray-100 tabular-nums">{fmtPct(val)}</div>
                <div className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wide mt-0.5 leading-tight">{label}</div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[10px] text-gray-400 dark:text-gray-500">
            Pitch-level rates from tracked WCL play-by-play. Swing = whiff + foul + ball in play; contact excludes whiffs. Samples are small early in the season.
          </p>
        </div>
      )}

      {hasPitching && (
        <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 sm:p-4 mb-4">
          <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100 mb-2">Pitching · by Season</h3>
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-[12px] tabular-nums">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  {['Year','G','GS','W','L','SV','IP','H','R','ER','BB','K','HR','ERA','WHIP','K/9'].map((h, i) => (
                    <th key={h} className={`px-1.5 py-1.5 font-bold text-gray-500 dark:text-gray-400 uppercase text-[10px] ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pitching.map(r => (
                  <tr key={r.id} className="border-b border-gray-100 dark:border-gray-700/50">
                    <td className="px-1.5 py-1 text-left font-semibold">{r.season}</td>
                    <td className="px-1.5 py-1 text-right">{r.games ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.games_started ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.wins ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.losses ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.saves ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{fmtIp(r.innings_pitched)}</td>
                    <td className="px-1.5 py-1 text-right">{r.hits_allowed ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.runs_allowed ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.earned_runs ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.walks ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.strikeouts ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.home_runs_allowed ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right font-bold">{fmtEra(r.era)}</td>
                    <td className="px-1.5 py-1 text-right">{fmtEra(r.whip)}</td>
                    <td className="px-1.5 py-1 text-right">{fmtEra(r.k_per_9)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {hasFielding && (
        <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 sm:p-4 mb-4">
          <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100 mb-2">Fielding · by Season</h3>
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-[12px] tabular-nums">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  {['Year','G','TC','PO','A','E','DP','PB','SBA','CS','FldPct','CS%'].map((h, i) => (
                    <th key={h} className={`px-1.5 py-1.5 font-bold text-gray-500 dark:text-gray-400 uppercase text-[10px] ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {fielding.map((r, i) => (
                  <tr key={i} className="border-b border-gray-100 dark:border-gray-700/50">
                    <td className="px-1.5 py-1 text-left font-semibold">{r.season}</td>
                    <td className="px-1.5 py-1 text-right">{r.games ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.total_chances ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.putouts ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.assists ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.errors ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.double_plays ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.passed_balls ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.stolen_bases_against ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.caught_stealing_by ?? '—'}</td>
                    <td className="px-1.5 py-1 text-right font-bold">{r.fielding_pct != null ? Number(r.fielding_pct).toFixed(3).replace(/^0/, '') : '—'}</td>
                    <td className="px-1.5 py-1 text-right">{r.cs_pct != null ? `${(r.cs_pct * 100).toFixed(1)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Game logs */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {game_batting?.length > 0 && (
          <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 sm:p-4">
            <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100 mb-2">Game Log · Batting</h3>
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-[11px] tabular-nums">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-700">
                    {['Date','Opp','AB','R','H','RBI','BB','K'].map((h, i) => (
                      <th key={h} className={`px-1.5 py-1 font-bold text-gray-500 dark:text-gray-400 uppercase text-[10px] ${i < 2 ? 'text-left' : 'text-right'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {game_batting.map(g => {
                    const isHome = g.home_team_id === player.team_id
                    const opp = isHome ? g.away_team_name : g.home_team_name
                    return (
                      <tr key={g.id} className="border-b border-gray-100 dark:border-gray-700/50">
                        <td className="px-1.5 py-1 text-left">
                          <Link to={`/summer/games/${g.game_id}`} className="text-nw-teal dark:text-teal-300 hover:underline">{fmtDate(g.game_date)}</Link>
                        </td>
                        <td className="px-1.5 py-1 text-left text-gray-700 dark:text-gray-300 truncate max-w-[140px]">{isHome ? 'vs ' : '@ '}{(opp || '').split(' ').slice(-1)[0]}</td>
                        <td className="px-1.5 py-1 text-right">{g.ab}</td>
                        <td className="px-1.5 py-1 text-right">{g.r}</td>
                        <td className="px-1.5 py-1 text-right">{g.h}</td>
                        <td className="px-1.5 py-1 text-right">{g.rbi}</td>
                        <td className="px-1.5 py-1 text-right">{g.bb}</td>
                        <td className="px-1.5 py-1 text-right">{g.so}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {game_pitching?.length > 0 && (
          <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 sm:p-4">
            <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100 mb-2">Game Log · Pitching</h3>
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-[11px] tabular-nums">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-700">
                    {['Date','Opp','IP','H','R','ER','BB','K','Dec'].map((h, i) => (
                      <th key={h} className={`px-1.5 py-1 font-bold text-gray-500 dark:text-gray-400 uppercase text-[10px] ${i < 2 || i === 8 ? 'text-left' : 'text-right'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {game_pitching.map(g => {
                    const isHome = g.home_team_id === player.team_id
                    const opp = isHome ? g.away_team_name : g.home_team_name
                    return (
                      <tr key={g.id} className="border-b border-gray-100 dark:border-gray-700/50">
                        <td className="px-1.5 py-1 text-left">
                          <Link to={`/summer/games/${g.game_id}`} className="text-nw-teal dark:text-teal-300 hover:underline">{fmtDate(g.game_date)}</Link>
                        </td>
                        <td className="px-1.5 py-1 text-left text-gray-700 dark:text-gray-300 truncate max-w-[140px]">{isHome ? 'vs ' : '@ '}{(opp || '').split(' ').slice(-1)[0]}</td>
                        <td className="px-1.5 py-1 text-right">{fmtIp(g.ip)}</td>
                        <td className="px-1.5 py-1 text-right">{g.h}</td>
                        <td className="px-1.5 py-1 text-right">{g.r}</td>
                        <td className="px-1.5 py-1 text-right">{g.er}</td>
                        <td className="px-1.5 py-1 text-right">{g.bb}</td>
                        <td className="px-1.5 py-1 text-right">{g.so}</td>
                        <td className="px-1.5 py-1 text-left">{g.decision || ''}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
