// SummerTeamDetail — /summer/teams/:id
//
// Header with logo + record + division, recent games list, and
// roster table. Reuses the /summer/teams/{id} backend endpoint.

import { Link, useParams } from 'react-router-dom'
import { useApi } from '../hooks/useApi'

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

  const { team, record, team_batting, recent_games, roster } = data
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

        {/* Roster */}
        <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 sm:p-4">
          <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100 mb-3">Roster</h3>
          {roster?.length
            ? <div className="overflow-x-auto -mx-1">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-gray-700">
                      {['Player','Pos','Yr','College','G','AVG','OPS','HR','RBI'].map((h, i) => (
                        <th key={h} className={`px-1.5 py-1.5 font-bold text-gray-500 dark:text-gray-400 uppercase text-[10px] ${i < 4 ? 'text-left' : 'text-right'}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {roster.map(p => (
                      <tr key={p.id} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                        <td className="px-1.5 py-1 font-semibold text-gray-900 dark:text-gray-100 whitespace-nowrap">
                          <Link to={`/summer/players/${p.id}`} className="hover:underline text-nw-teal dark:text-teal-300">
                            {p.first_name} {p.last_name}
                          </Link>
                          {p.jersey_number && <span className="ml-1 text-[10px] text-gray-400 dark:text-gray-500">#{p.jersey_number}</span>}
                        </td>
                        <td className="px-1.5 py-1 text-left text-gray-500 dark:text-gray-400 uppercase">{p.position || ''}</td>
                        <td className="px-1.5 py-1 text-left text-gray-500 dark:text-gray-400">{p.year_in_school || ''}</td>
                        <td className="px-1.5 py-1 text-left text-gray-600 dark:text-gray-400 truncate max-w-[140px]" title={p.college || ''}>{p.college || ''}</td>
                        <td className="px-1.5 py-1 text-right tabular-nums">{p.bat_games ?? '—'}</td>
                        <td className="px-1.5 py-1 text-right tabular-nums">{fmtAvg(p.batting_avg)}</td>
                        <td className="px-1.5 py-1 text-right tabular-nums font-bold">{p.ops != null ? fmtAvg(p.ops) : '—'}</td>
                        <td className="px-1.5 py-1 text-right tabular-nums">{p.home_runs ?? '—'}</td>
                        <td className="px-1.5 py-1 text-right tabular-nums">{p.rbi ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            : <div className="text-xs text-gray-500 dark:text-gray-400">No roster on file. Will populate after Pointstreak roster sync.</div>}
        </div>
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
