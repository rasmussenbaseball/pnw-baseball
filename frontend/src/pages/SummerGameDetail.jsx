// SummerGameDetail — box score view for a single WCL game.
//   /summer/games/:id
//
// Renders line score + per-team batting + per-team pitching from
// /summer/games/{id}. Layout mirrors the existing spring GameDetail
// but simpler since summer rows lack advanced stats.

import { Link, useParams } from 'react-router-dom'
import { useApi } from '../hooks/useApi'

const fmtAvg = v => v == null ? '—' : Number(v).toFixed(3).replace(/^0/, '')
const fmtDate = d => {
  if (!d) return ''
  const dt = new Date(d)
  return dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

export default function SummerGameDetail() {
  const { id } = useParams()
  const { data, loading, error } = useApi(`/summer/games/${id}`)

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <div className="animate-spin h-8 w-8 border-4 border-nw-teal border-t-transparent rounded-full" />
      </div>
    )
  }
  if (error || !data?.game) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-12 text-center text-gray-500 dark:text-gray-400">
        {error || 'Game not found.'}{' '}
        <Link to="/summer" className="text-nw-teal dark:text-teal-300 underline">Back to Summer Hub</Link>
      </div>
    )
  }

  const { game, batting, pitching } = data
  const awayBat = batting.filter(b => !b.is_home)
  const homeBat = batting.filter(b => b.is_home)
  const awayPit = pitching.filter(p => !p.is_home)
  const homePit = pitching.filter(p => p.is_home)
  const isFinal = game.status === 'final'

  const awayLine = game.away_line_score || []
  const homeLine = game.home_line_score || []
  const innings = Math.max(awayLine.length, homeLine.length, game.innings || 9)

  return (
    <div className="max-w-6xl mx-auto px-3 sm:px-4 py-4">
      <div className="flex items-center justify-between mb-3 gap-2">
        <Link to="/summer" className="inline-block text-xs text-nw-teal dark:text-teal-300 hover:underline">
          ← Summer Hub
        </Link>
        {isFinal && (
          <Link
            to={`/summer/game-recap?game=${game.id}`}
            className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded
                       border border-nw-teal text-nw-teal dark:text-teal-300 dark:border-teal-400
                       hover:bg-nw-teal hover:text-white dark:hover:bg-teal-600 transition-colors"
          >
            Recap graphic
          </Link>
        )}
      </div>

      {/* Header */}
      <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 sm:p-5 mb-4">
        <div className="flex items-baseline gap-3 flex-wrap mb-3">
          <span className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {isFinal ? 'Final' : game.status === 'in_progress' ? 'Live' : 'Scheduled'}
            {isFinal && innings !== 9 && <span> ({innings} inn)</span>}
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400">{fmtDate(game.game_date)}</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] sm:gap-6 items-center">
          <TeamHero
            id={game.away_team_id}
            name={game.away_team_name}
            short={game.away_short}
            logo={game.away_logo}
            score={game.away_score}
            won={isFinal && game.away_score > game.home_score}
            align="right"
          />
          <div className="text-xs uppercase tracking-wider font-bold text-gray-400 dark:text-gray-500 text-center my-2 sm:my-0">@</div>
          <TeamHero
            id={game.home_team_id}
            name={game.home_team_name}
            short={game.home_short}
            logo={game.home_logo}
            score={game.home_score}
            won={isFinal && game.home_score > game.away_score}
            align="left"
          />
        </div>

        {(awayLine.length > 0 || homeLine.length > 0) && (
          <div className="mt-4 overflow-x-auto -mx-3 sm:mx-0">
            <table className="min-w-full text-xs sm:text-sm font-mono tabular-nums">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left px-2 py-1 font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Team</th>
                  {Array.from({ length: innings }).map((_, i) => (
                    <th key={i} className="px-1.5 py-1 text-right font-bold text-gray-500 dark:text-gray-400">{i + 1}</th>
                  ))}
                  <th className="px-2 py-1 text-right font-bold text-gray-700 dark:text-gray-300">R</th>
                  <th className="px-2 py-1 text-right font-bold text-gray-500 dark:text-gray-400">H</th>
                  <th className="px-2 py-1 text-right font-bold text-gray-500 dark:text-gray-400">E</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { lab: game.away_short || game.away_team_name, line: awayLine, r: game.away_score, h: game.away_hits, e: game.away_errors },
                  { lab: game.home_short || game.home_team_name, line: homeLine, r: game.home_score, h: game.home_hits, e: game.home_errors },
                ].map((row, idx) => (
                  <tr key={idx} className="border-b border-gray-100 dark:border-gray-700/50">
                    <td className="px-2 py-1 font-semibold text-gray-900 dark:text-gray-100">{row.lab}</td>
                    {Array.from({ length: innings }).map((_, i) => (
                      <td key={i} className="px-1.5 py-1 text-right text-gray-700 dark:text-gray-300">{row.line[i] ?? ''}</td>
                    ))}
                    <td className="px-2 py-1 text-right font-bold">{row.r ?? '—'}</td>
                    <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400">{row.h ?? '—'}</td>
                    <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400">{row.e ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Batting */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <BattingTable label={game.away_short || game.away_team_name} rows={awayBat} />
        <BattingTable label={game.home_short || game.home_team_name} rows={homeBat} />
      </div>

      {/* Pitching */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PitchingTable label={game.away_short || game.away_team_name} rows={awayPit} />
        <PitchingTable label={game.home_short || game.home_team_name} rows={homePit} />
      </div>
    </div>
  )
}

function TeamHero({ id, name, short, logo, score, won, align }) {
  const justify = align === 'right' ? 'sm:justify-end' : 'sm:justify-start'
  return (
    <div className={`flex items-center gap-3 ${justify}`}>
      {align === 'right' && score != null && (
        <span className={`text-3xl sm:text-4xl tabular-nums ${won ? 'font-bold text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400'}`}>{score}</span>
      )}
      {logo
        ? <img src={logo} alt="" className="w-10 h-10 sm:w-12 sm:h-12 object-contain shrink-0" loading="lazy" />
        : <div className="w-10 h-10 sm:w-12 sm:h-12 rounded bg-gray-100 dark:bg-gray-700 shrink-0" />}
      <div className="flex flex-col min-w-0">
        <Link to={id ? `/summer/teams/${id}` : '#'} className={`font-bold text-sm sm:text-base truncate ${won ? 'text-gray-900 dark:text-gray-100' : 'text-gray-700 dark:text-gray-300'} ${id ? 'hover:underline' : ''}`}>
          {short || name}
        </Link>
        {short && name && short !== name && (
          <span className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{name}</span>
        )}
      </div>
      {align === 'left' && score != null && (
        <span className={`text-3xl sm:text-4xl tabular-nums ml-auto ${won ? 'font-bold text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400'}`}>{score}</span>
      )}
    </div>
  )
}

function BattingTable({ label, rows }) {
  if (!rows?.length) return null
  // Totals row
  const tot = rows.reduce((s, r) => ({
    ab: s.ab + (r.ab || 0), r: s.r + (r.r || 0), h: s.h + (r.h || 0),
    rbi: s.rbi + (r.rbi || 0), bb: s.bb + (r.bb || 0), so: s.so + (r.so || 0),
  }), { ab: 0, r: 0, h: 0, rbi: 0, bb: 0, so: 0 })
  return (
    <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 sm:p-4">
      <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100 mb-2">{label} · Batting</h3>
      <div className="overflow-x-auto -mx-1">
        <table className="w-full text-[12px] font-mono tabular-nums">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-700">
              {['Player','Pos','AB','R','H','RBI','BB','K'].map((h, i) => (
                <th key={h} className={`px-1.5 py-1 font-bold text-gray-500 dark:text-gray-400 uppercase text-[10px] ${i < 2 ? 'text-left' : 'text-right'}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((b, i) => (
              <tr key={b.id || i} className="border-b border-gray-100 dark:border-gray-700/50">
                <td className="px-1.5 py-1 text-left text-gray-900 dark:text-gray-100 font-semibold whitespace-nowrap">
                  {b.player_id
                    ? <Link to={`/summer/players/${b.player_id}`} className="hover:underline">{b.player_name}</Link>
                    : b.player_name}
                </td>
                <td className="px-1.5 py-1 text-left text-gray-500 dark:text-gray-400 uppercase">{b.position || ''}</td>
                <td className="px-1.5 py-1 text-right">{b.ab}</td>
                <td className="px-1.5 py-1 text-right">{b.r}</td>
                <td className="px-1.5 py-1 text-right">{b.h}</td>
                <td className="px-1.5 py-1 text-right">{b.rbi}</td>
                <td className="px-1.5 py-1 text-right">{b.bb}</td>
                <td className="px-1.5 py-1 text-right">{b.so}</td>
              </tr>
            ))}
            <tr className="font-bold text-gray-900 dark:text-gray-100 border-t border-gray-300 dark:border-gray-600">
              <td className="px-1.5 py-1 text-left" colSpan={2}>Totals</td>
              <td className="px-1.5 py-1 text-right">{tot.ab}</td>
              <td className="px-1.5 py-1 text-right">{tot.r}</td>
              <td className="px-1.5 py-1 text-right">{tot.h}</td>
              <td className="px-1.5 py-1 text-right">{tot.rbi}</td>
              <td className="px-1.5 py-1 text-right">{tot.bb}</td>
              <td className="px-1.5 py-1 text-right">{tot.so}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

function PitchingTable({ label, rows }) {
  if (!rows?.length) return null
  return (
    <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 sm:p-4">
      <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100 mb-2">{label} · Pitching</h3>
      <div className="overflow-x-auto -mx-1">
        <table className="w-full text-[12px] font-mono tabular-nums">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-700">
              {['Pitcher','IP','H','R','ER','BB','K','HR','Dec'].map((h, i) => (
                <th key={h} className={`px-1.5 py-1 font-bold text-gray-500 dark:text-gray-400 uppercase text-[10px] ${i === 0 || i === 8 ? 'text-left' : 'text-right'}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((p, i) => (
              <tr key={p.id || i} className="border-b border-gray-100 dark:border-gray-700/50">
                <td className="px-1.5 py-1 text-left text-gray-900 dark:text-gray-100 font-semibold whitespace-nowrap">
                  {p.player_id
                    ? <Link to={`/summer/players/${p.player_id}`} className="hover:underline">{p.player_name}</Link>
                    : p.player_name}
                  {p.is_starter && <span className="ml-1 text-[9px] font-normal text-gray-500 dark:text-gray-400 uppercase">(s)</span>}
                </td>
                <td className="px-1.5 py-1 text-right">{p.ip != null ? Number(p.ip).toFixed(1) : '—'}</td>
                <td className="px-1.5 py-1 text-right">{p.h}</td>
                <td className="px-1.5 py-1 text-right">{p.r}</td>
                <td className="px-1.5 py-1 text-right">{p.er}</td>
                <td className="px-1.5 py-1 text-right">{p.bb}</td>
                <td className="px-1.5 py-1 text-right">{p.so}</td>
                <td className="px-1.5 py-1 text-right">{p.hr}</td>
                <td className="px-1.5 py-1 text-left">{p.decision || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
