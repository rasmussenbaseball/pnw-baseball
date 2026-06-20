// SummerTeamDetail — /summer/teams/:id
//
// Header with logo + record + division, recent games list, and
// roster table. Reuses the /summer/teams/{id} backend endpoint.

import { Link, useParams } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { titleName, fmtYr } from '../utils/summerDisplay'

const fmtAvg = v => v == null ? '—' : Number(v).toFixed(3).replace(/^0/, '')
const fmtInt = v => v == null ? '—' : Math.round(v)
const fmtDate = d => {
  if (!d) return ''
  const dt = new Date(d)
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

export default function SummerTeamDetail() {
  const { id } = useParams()
  const { data, loading, error } = useApi(`/summer/teams/${id}`)

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <div className="animate-spin h-8 w-8 border-4 border-nw-teal border-t-transparent rounded-full" />
      </div>
    )
  }
  if (error || !data?.team) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-12 text-center text-gray-500 dark:text-gray-400">
        {error || 'Team not found.'}{' '}
        <Link to="/summer" className="text-nw-teal dark:text-teal-300 underline">Back to Summer Hub</Link>
      </div>
    )
  }

  const { team, record, team_batting, recent_games, roster, top_batters, top_pitchers } = data
  const teamId = Number(id)

  return (
    <div className="max-w-6xl mx-auto px-3 sm:px-4 py-4">
      <Link to="/summer" className="inline-block text-xs text-nw-teal dark:text-teal-300 hover:underline mb-3">
        ← Summer Hub
      </Link>

      {/* Hero */}
      <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 sm:p-5 mb-4">
        <div className="flex items-center gap-4 flex-wrap">
          {team.logo_url
            ? <img src={team.logo_url} alt="" className="w-16 h-16 sm:w-20 sm:h-20 object-contain" />
            : <div className="w-16 h-16 sm:w-20 sm:h-20 rounded bg-gray-100 dark:bg-gray-700" />}
          <div className="flex-1 min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-gray-100 truncate">
              {team.name}
            </h1>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mt-1 text-sm text-gray-600 dark:text-gray-400">
              {(team.city || team.state) && <span>{[team.city, team.state].filter(Boolean).join(', ')}</span>}
              {team.league_abbr && (
                <span className="px-2 py-0.5 rounded text-xs font-bold bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
                  {team.league_abbr}
                </span>
              )}
              {team.division && (
                <span className="text-xs font-semibold text-gray-500 dark:text-gray-400">
                  {team.division} Division
                </span>
              )}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider font-bold text-gray-400 dark:text-gray-500">Record</div>
            <div className="text-2xl font-bold tabular-nums text-gray-900 dark:text-gray-100">
              {record?.wins ?? 0}–{record?.losses ?? 0}
            </div>
          </div>
        </div>
      </div>

      {/* Team batting summary */}
      {team_batting?.bat_games > 0 && (
        <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 sm:p-4 mb-4">
          <h3 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">Team Offense</h3>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 text-center">
            <Stat label="AVG" value={fmtAvg(team_batting.team_avg)} />
            <Stat label="H"   value={fmtInt(team_batting.hits)} />
            <Stat label="HR"  value={fmtInt(team_batting.home_runs)} />
            <Stat label="RBI" value={fmtInt(team_batting.rbi)} />
            <Stat label="BB"  value={fmtInt(team_batting.bb)} />
            <Stat label="K"   value={fmtInt(team_batting.so)} />
          </div>
        </div>
      )}

      {/* Team leaders strip */}
      {(top_batters?.length > 0 || top_pitchers?.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
          {top_batters?.length > 0 && (
            <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 sm:p-4">
              <div className="flex items-baseline justify-between mb-2">
                <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">Team Batting Leaders</h3>
                <Link to={`/summer?team=${teamId}`} className="text-[11px] text-nw-teal dark:text-teal-300 hover:underline">All →</Link>
              </div>
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-700">
                    {['Player','Pos','PA','AVG','OPS','wRC+','HR','RBI'].map((h, i) => (
                      <th key={h} className={`px-1.5 py-1 font-bold text-gray-500 dark:text-gray-400 uppercase text-[9px] ${i < 2 ? 'text-left' : 'text-right'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {top_batters.map(p => (
                    <tr key={p.player_id} className="border-b border-gray-100 dark:border-gray-700/50">
                      <td className="px-1.5 py-1 font-semibold text-gray-900 dark:text-gray-100 whitespace-nowrap">
                        <Link to={`/summer/players/${p.player_id}`} className="hover:underline">{p.first_name} {p.last_name}</Link>
                      </td>
                      <td className="px-1.5 py-1 text-left text-gray-500 dark:text-gray-400 uppercase">{p.position || ''}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums">{fmtInt(p.plate_appearances)}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums">{fmtAvg(p.batting_avg)}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums font-bold">{fmtAvg(p.ops)}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums">{p.wrc_plus != null ? Math.round(p.wrc_plus) : '—'}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums">{fmtInt(p.home_runs)}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums">{fmtInt(p.rbi)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {top_pitchers?.length > 0 && (
            <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 sm:p-4">
              <div className="flex items-baseline justify-between mb-2">
                <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">Team Pitching Leaders</h3>
                <Link to={`/summer?team=${teamId}`} className="text-[11px] text-nw-teal dark:text-teal-300 hover:underline">All →</Link>
              </div>
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-700">
                    {['Pitcher','IP','W-L','SV','K','ERA','WHIP','FIP'].map((h, i) => (
                      <th key={h} className={`px-1.5 py-1 font-bold text-gray-500 dark:text-gray-400 uppercase text-[9px] ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {top_pitchers.map(p => (
                    <tr key={p.player_id} className="border-b border-gray-100 dark:border-gray-700/50">
                      <td className="px-1.5 py-1 font-semibold text-gray-900 dark:text-gray-100 whitespace-nowrap">
                        <Link to={`/summer/players/${p.player_id}`} className="hover:underline">{p.first_name} {p.last_name}</Link>
                      </td>
                      <td className="px-1.5 py-1 text-right tabular-nums">{p.innings_pitched != null ? Number(p.innings_pitched).toFixed(1) : '—'}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums">{fmtInt(p.wins)}-{fmtInt(p.losses)}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums">{fmtInt(p.saves)}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums">{fmtInt(p.strikeouts)}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums font-bold">{p.era != null ? Number(p.era).toFixed(2) : '—'}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums">{p.whip != null ? Number(p.whip).toFixed(2) : '—'}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums">{p.fip != null ? Number(p.fip).toFixed(2) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.4fr] gap-4">
        {/* Recent games */}
        <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 sm:p-4">
          <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100 mb-3">Recent Games</h3>
          {recent_games?.length
            ? <div className="flex flex-col gap-2">
                {recent_games.map(g => <MiniGameRow key={g.id} g={g} myTeamId={teamId} />)}
              </div>
            : <div className="text-xs text-gray-500 dark:text-gray-400">No games yet.</div>}
        </div>

        {/* Roster — full 2026 squad, split by role so pitchers show pitching
            stats (not 0-for batting) and bench players still appear. */}
        {(() => {
          const all = roster || []
          const num = v => (v == null ? -Infinity : Number(v))
          const hitters = all.filter(p => p.role === 'hitter' || p.role === 'two-way')
            .sort((a, b) => (Number(b.has_stats) - Number(a.has_stats)) || (num(b.ops) - num(a.ops)) || (a.last_name || '').localeCompare(b.last_name || ''))
          const pitchers = all.filter(p => p.role === 'pitcher' || p.role === 'two-way')
            .sort((a, b) => (Number(b.has_stats) - Number(a.has_stats)) || ((a.era ?? 999) - (b.era ?? 999)) || (a.last_name || '').localeCompare(b.last_name || ''))
          const nameCell = p => {
            // PNW players (linked to a spring record) go to their full profile
            // with the spring/summer toggle; non-PNW players go to the summer page.
            const target = p.spring_player_id ? `/player/${p.spring_player_id}` : `/summer/players/${p.id}`
            return (
              <td className="px-1.5 py-1 font-semibold whitespace-nowrap">
                <Link to={target}
                  className={`hover:underline ${p.has_stats ? 'text-nw-teal dark:text-teal-300' : 'text-gray-400 dark:text-gray-500'}`}>
                  {titleName(p.first_name, p.last_name)}
                </Link>
                {p.pnw_spring && (
                  <span title="Plays 2026 PNW college ball — click for full profile"
                    className="ml-1 inline-flex items-center justify-center text-[7px] font-black text-white bg-nw-teal rounded-[3px] px-[3px] leading-none align-middle"
                    style={{ height: '12px' }}>NW</span>
                )}
                {p.jersey_number && <span className="ml-1 text-[10px] text-gray-400 dark:text-gray-500">#{p.jersey_number}</span>}
                {!p.has_stats && <span className="ml-1.5 text-[9px] uppercase tracking-wide text-gray-400 dark:text-gray-500 italic">roster</span>}
              </td>
            )
          }
          const home = p => <td className="px-1.5 py-1 text-left text-gray-600 dark:text-gray-400 truncate max-w-[150px]" title={p.hometown || ''}>{p.hometown || ''}</td>
          const school = p => (
            <td className="px-1.5 py-1 text-left text-gray-600 dark:text-gray-400 max-w-[140px]" title={p.school || ''}>
              {p.in_wcl_portal && (
                <Link to="/coaching/wcl-portal"
                  className="mr-1 inline-flex items-center text-[8px] font-black uppercase tracking-wide text-white bg-amber-500 hover:bg-amber-600 rounded-[3px] px-1 py-[1px] align-middle">Portal</Link>
              )}
              <span className="align-middle">{p.school || (p.in_wcl_portal ? '' : '—')}</span>
            </td>
          )
          const era2 = v => (v != null ? Number(v).toFixed(2) : '—')
          return (
            <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 sm:p-4">
              <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100 mb-3">
                Roster <span className="font-normal text-gray-400 dark:text-gray-500">({all.length})</span>
              </h3>
              {!all.length
                ? <div className="text-xs text-gray-500 dark:text-gray-400">No roster on file yet.</div>
                : <div className="space-y-5">
                    {hitters.length > 0 && (
                      <div>
                        <div className="text-[11px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1">Position Players ({hitters.length})</div>
                        <div className="overflow-x-auto -mx-1">
                          <table className="w-full text-[12px]">
                            <thead><tr className="border-b border-gray-200 dark:border-gray-700">
                              {['Player','Pos','Yr','Hometown','School','G','AVG','OBP','OPS','HR','RBI'].map((h, i) => (
                                <th key={h} className={`px-1.5 py-1.5 font-bold text-gray-500 dark:text-gray-400 uppercase text-[10px] ${i < 5 ? 'text-left' : 'text-right'}`}>{h}</th>))}
                            </tr></thead>
                            <tbody>
                              {hitters.map(p => (
                                <tr key={p.id} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                                  {nameCell(p)}
                                  <td className="px-1.5 py-1 text-left text-gray-500 dark:text-gray-400 uppercase">{p.position || ''}</td>
                                  <td className="px-1.5 py-1 text-left text-gray-500 dark:text-gray-400">{fmtYr(p.year_in_school)}</td>
                                  {home(p)}
                                  {school(p)}
                                  <td className="px-1.5 py-1 text-right tabular-nums">{p.bat_games ?? '—'}</td>
                                  <td className="px-1.5 py-1 text-right tabular-nums">{p.batting_avg != null ? fmtAvg(p.batting_avg) : '—'}</td>
                                  <td className="px-1.5 py-1 text-right tabular-nums">{p.on_base_pct != null ? fmtAvg(p.on_base_pct) : '—'}</td>
                                  <td className="px-1.5 py-1 text-right tabular-nums font-bold">{p.ops != null ? fmtAvg(p.ops) : '—'}</td>
                                  <td className="px-1.5 py-1 text-right tabular-nums">{p.home_runs ?? '—'}</td>
                                  <td className="px-1.5 py-1 text-right tabular-nums">{p.rbi ?? '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                    {pitchers.length > 0 && (
                      <div>
                        <div className="text-[11px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1">Pitchers ({pitchers.length})</div>
                        <div className="overflow-x-auto -mx-1">
                          <table className="w-full text-[12px]">
                            <thead><tr className="border-b border-gray-200 dark:border-gray-700">
                              {['Pitcher','T','Yr','Hometown','School','IP','W-L','SV','K','ERA','WHIP'].map((h, i) => (
                                <th key={h} className={`px-1.5 py-1.5 font-bold text-gray-500 dark:text-gray-400 uppercase text-[10px] ${i < 5 ? 'text-left' : 'text-right'}`}>{h}</th>))}
                            </tr></thead>
                            <tbody>
                              {pitchers.map(p => (
                                <tr key={p.id} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                                  {nameCell(p)}
                                  <td className="px-1.5 py-1 text-left text-gray-500 dark:text-gray-400">{p.throws || ''}</td>
                                  <td className="px-1.5 py-1 text-left text-gray-500 dark:text-gray-400">{fmtYr(p.year_in_school)}</td>
                                  {home(p)}
                                  {school(p)}
                                  <td className="px-1.5 py-1 text-right tabular-nums">{p.innings_pitched ?? '—'}</td>
                                  <td className="px-1.5 py-1 text-right tabular-nums">{(p.p_wins != null || p.p_losses != null) ? `${p.p_wins ?? 0}-${p.p_losses ?? 0}` : '—'}</td>
                                  <td className="px-1.5 py-1 text-right tabular-nums">{p.p_saves ?? '—'}</td>
                                  <td className="px-1.5 py-1 text-right tabular-nums">{p.p_strikeouts ?? '—'}</td>
                                  <td className="px-1.5 py-1 text-right tabular-nums font-bold">{era2(p.era)}</td>
                                  <td className="px-1.5 py-1 text-right tabular-nums">{era2(p.whip)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>}
            </div>
          )
        })()}
      </div>
    </div>
  )
}

function Stat({ label, value }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-bold text-gray-400 dark:text-gray-500">{label}</div>
      <div className="text-base sm:text-lg font-bold text-gray-900 dark:text-gray-100 tabular-nums">{value}</div>
    </div>
  )
}

function MiniGameRow({ g, myTeamId }) {
  const isHome = g.home_team_id === myTeamId
  const myScore = isHome ? g.home_score : g.away_score
  const oppScore = isHome ? g.away_score : g.home_score
  const oppName = isHome ? g.away_team_name : g.home_team_name
  const isFinal = g.status === 'final'
  const result = isFinal && myScore != null && oppScore != null
    ? myScore > oppScore ? 'W' : myScore < oppScore ? 'L' : 'T'
    : ''
  const resultColor = result === 'W' ? 'text-emerald-600 dark:text-emerald-400'
    : result === 'L' ? 'text-rose-600 dark:text-rose-400'
    : 'text-gray-500 dark:text-gray-400'
  return (
    <Link to={`/summer/games/${g.id}`}
      className="grid grid-cols-[34px_1fr_auto] items-center gap-2 px-2 py-1.5 rounded bg-gray-50 dark:bg-gray-700/40 hover:bg-gray-100 dark:hover:bg-gray-700 transition">
      <span className="text-xs text-gray-500 dark:text-gray-400">{fmtDate(g.game_date)}</span>
      <span className="text-sm text-gray-900 dark:text-gray-100 truncate">{isHome ? 'vs ' : '@ '}{oppName}</span>
      <span className={`text-sm font-bold tabular-nums ${resultColor}`}>
        {result && <span className="mr-1">{result}</span>}
        {myScore != null && oppScore != null ? `${myScore}-${oppScore}` : ''}
      </span>
    </Link>
  )
}
