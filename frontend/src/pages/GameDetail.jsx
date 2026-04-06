import { Link, useParams } from 'react-router-dom'
import { useGameDetail } from '../hooks/useApi'

function formatIP(ip) {
  if (ip == null) return '-'
  const whole = Math.floor(ip)
  const frac = Math.round((ip - whole) * 3)
  return frac === 0 ? `${whole}.0` : `${whole}.${frac}`
}

function formatDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

function LineScore({ game }) {
  const homeLine = game.home_line_score || []
  const awayLine = game.away_line_score || []
  const maxInnings = Math.max(homeLine.length, awayLine.length, 9)

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-500 uppercase tracking-wider">
            <th className="text-left pl-3 pr-2 py-1.5 font-semibold w-32">Team</th>
            {Array.from({ length: maxInnings }, (_, i) => (
              <th key={i} className="text-center px-1.5 py-1.5 font-semibold w-7">{i + 1}</th>
            ))}
            <th className="text-center px-2 py-1.5 font-bold w-8 border-l border-gray-200">R</th>
            <th className="text-center px-2 py-1.5 font-semibold w-8">H</th>
            <th className="text-center px-2 py-1.5 font-semibold w-8">E</th>
          </tr>
        </thead>
        <tbody>
          {/* Away team */}
          <tr className={`border-t ${game.away_score > game.home_score ? 'bg-amber-50/40 font-semibold' : ''}`}>
            <td className="pl-3 pr-2 py-2">
              <div className="flex items-center gap-1.5">
                {game.away_logo && (
                  <img src={game.away_logo} alt="" className="w-4 h-4 object-contain"
                    onError={(e) => { e.target.style.display = 'none' }} />
                )}
                <span className="text-gray-800 truncate">
                  {game.away_short || game.away_team_name || 'Away'}
                </span>
              </div>
            </td>
            {Array.from({ length: maxInnings }, (_, i) => (
              <td key={i} className="text-center px-1.5 py-2 font-mono text-gray-600">
                {awayLine[i] != null ? awayLine[i] : (i < awayLine.length ? 'x' : '-')}
              </td>
            ))}
            <td className="text-center px-2 py-2 font-bold font-mono border-l border-gray-200">
              {game.away_score}
            </td>
            <td className="text-center px-2 py-2 font-mono text-gray-600">{game.away_hits ?? '-'}</td>
            <td className="text-center px-2 py-2 font-mono text-gray-600">{game.away_errors ?? '-'}</td>
          </tr>
          {/* Home team */}
          <tr className={`border-t ${game.home_score > game.away_score ? 'bg-amber-50/40 font-semibold' : ''}`}>
            <td className="pl-3 pr-2 py-2">
              <div className="flex items-center gap-1.5">
                {game.home_logo && (
                  <img src={game.home_logo} alt="" className="w-4 h-4 object-contain"
                    onError={(e) => { e.target.style.display = 'none' }} />
                )}
                <span className="text-gray-800 truncate">
                  {game.home_short || game.home_team_name || 'Home'}
                </span>
              </div>
            </td>
            {Array.from({ length: maxInnings }, (_, i) => (
              <td key={i} className="text-center px-1.5 py-2 font-mono text-gray-600">
                {homeLine[i] != null ? homeLine[i] : (i < homeLine.length ? 'x' : '-')}
              </td>
            ))}
            <td className="text-center px-2 py-2 font-bold font-mono border-l border-gray-200">
              {game.home_score}
            </td>
            <td className="text-center px-2 py-2 font-mono text-gray-600">{game.home_hits ?? '-'}</td>
            <td className="text-center px-2 py-2 font-mono text-gray-600">{game.home_errors ?? '-'}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function BattingTable({ players, teamName, teamLogo }) {
  if (!players || players.length === 0) return null

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2">
        {teamLogo && (
          <img src={teamLogo} alt="" className="w-4 h-4 object-contain"
            onError={(e) => { e.target.style.display = 'none' }} />
        )}
        <h3 className="text-sm font-bold text-gray-800">{teamName} - Batting</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] text-gray-500 uppercase tracking-wider bg-gray-50">
              <th className="text-left pl-3 pr-1 py-1.5 font-semibold">Player</th>
              <th className="text-center px-1 py-1.5 font-semibold w-8">Pos</th>
              <th className="text-center px-1 py-1.5 font-semibold w-7">AB</th>
              <th className="text-center px-1 py-1.5 font-semibold w-7">R</th>
              <th className="text-center px-1 py-1.5 font-semibold w-7">H</th>
              <th className="text-center px-1 py-1.5 font-semibold w-7">RBI</th>
              <th className="text-center px-1 py-1.5 font-semibold w-7">BB</th>
              <th className="text-center px-1 py-1.5 font-semibold w-7">SO</th>
              <th className="text-center px-1 py-1.5 font-semibold w-7">HR</th>
              <th className="text-center px-1 py-1.5 font-semibold w-7">SB</th>
            </tr>
          </thead>
          <tbody>
            {players.map((p, i) => (
              <tr key={i} className="border-t border-gray-50 hover:bg-gray-50/50">
                <td className="pl-3 pr-1 py-1.5">
                  {p.player_id ? (
                    <Link to={`/player/${p.player_id}`} className="text-nw-teal hover:underline font-medium">
                      {p.first_name && p.last_name ? `${p.first_name} ${p.last_name}` : p.player_name}
                    </Link>
                  ) : (
                    <span className="text-gray-700">{p.player_name}</span>
                  )}
                </td>
                <td className="text-center px-1 py-1.5 text-gray-400 text-[10px]">{p.position || '-'}</td>
                <td className="text-center px-1 py-1.5 font-mono">{p.at_bats}</td>
                <td className="text-center px-1 py-1.5 font-mono">{p.runs}</td>
                <td className="text-center px-1 py-1.5 font-mono font-medium">{p.hits}</td>
                <td className="text-center px-1 py-1.5 font-mono">{p.rbi}</td>
                <td className="text-center px-1 py-1.5 font-mono">{p.walks}</td>
                <td className="text-center px-1 py-1.5 font-mono">{p.strikeouts}</td>
                <td className="text-center px-1 py-1.5 font-mono">{p.home_runs || '-'}</td>
                <td className="text-center px-1 py-1.5 font-mono">{p.stolen_bases || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function PitchingTable({ players, teamName, teamLogo }) {
  if (!players || players.length === 0) return null

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2">
        {teamLogo && (
          <img src={teamLogo} alt="" className="w-4 h-4 object-contain"
            onError={(e) => { e.target.style.display = 'none' }} />
        )}
        <h3 className="text-sm font-bold text-gray-800">{teamName} - Pitching</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] text-gray-500 uppercase tracking-wider bg-gray-50">
              <th className="text-left pl-3 pr-1 py-1.5 font-semibold">Pitcher</th>
              <th className="text-center px-1 py-1.5 font-semibold w-8">Dec</th>
              <th className="text-center px-1 py-1.5 font-semibold w-10">IP</th>
              <th className="text-center px-1 py-1.5 font-semibold w-7">H</th>
              <th className="text-center px-1 py-1.5 font-semibold w-7">R</th>
              <th className="text-center px-1 py-1.5 font-semibold w-7">ER</th>
              <th className="text-center px-1 py-1.5 font-semibold w-7">BB</th>
              <th className="text-center px-1 py-1.5 font-semibold w-7">SO</th>
              <th className="text-center px-1 py-1.5 font-semibold w-10">GS</th>
              {players.some(p => p.game_score) && (
                <th className="text-center px-1 py-1.5 font-semibold w-10">GSc</th>
              )}
            </tr>
          </thead>
          <tbody>
            {players.map((p, i) => (
              <tr key={i} className={`border-t border-gray-50 hover:bg-gray-50/50 ${
                p.is_quality_start ? 'bg-green-50/30' : ''
              }`}>
                <td className="pl-3 pr-1 py-1.5">
                  {p.player_id ? (
                    <Link to={`/player/${p.player_id}`} className="text-nw-teal hover:underline font-medium">
                      {p.first_name && p.last_name ? `${p.first_name} ${p.last_name}` : p.player_name}
                    </Link>
                  ) : (
                    <span className="text-gray-700">{p.player_name}</span>
                  )}
                </td>
                <td className="text-center px-1 py-1.5">
                  {p.decision ? (
                    <span className={`text-[10px] font-bold px-1 py-0.5 rounded ${
                      p.decision === 'W' ? 'bg-green-100 text-green-700' :
                      p.decision === 'L' ? 'bg-red-100 text-red-700' :
                      p.decision === 'S' ? 'bg-blue-100 text-blue-700' :
                      'bg-gray-100 text-gray-600'
                    }`}>
                      {p.decision}
                    </span>
                  ) : '-'}
                </td>
                <td className="text-center px-1 py-1.5 font-mono">{formatIP(p.innings_pitched)}</td>
                <td className="text-center px-1 py-1.5 font-mono">{p.hits_allowed}</td>
                <td className="text-center px-1 py-1.5 font-mono">{p.runs_allowed}</td>
                <td className="text-center px-1 py-1.5 font-mono">{p.earned_runs}</td>
                <td className="text-center px-1 py-1.5 font-mono">{p.walks}</td>
                <td className="text-center px-1 py-1.5 font-mono font-medium">{p.strikeouts}</td>
                <td className="text-center px-1 py-1.5">
                  {p.is_quality_start ? (
                    <span className="text-[10px] font-bold text-green-600">QS</span>
                  ) : '-'}
                </td>
                {players.some(pp => pp.game_score) && (
                  <td className="text-center px-1 py-1.5 font-mono font-medium">
                    {p.game_score != null ? Math.round(p.game_score) : '-'}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function GameDetail() {
  const { gameId } = useParams()
  const { data, loading, error } = useGameDetail(gameId)

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-nw-teal border-t-transparent" />
      </div>
    )
  }

  if (error || !data) {
    return <div className="text-center text-red-600 py-10">Error loading game: {error || 'Not found'}</div>
  }

  const { game, home_batting, away_batting, home_pitching, away_pitching } = data

  const homeWon = game.home_score > game.away_score
  const awayWon = game.away_score > game.home_score
  const homeName = game.home_short || game.home_team_name || 'Home'
  const awayName = game.away_short || game.away_team_name || 'Away'

  return (
    <div>
      {/* Back link */}
      <Link to="/results" className="text-sm text-nw-teal hover:underline mb-3 inline-block">
        ← Back to Results
      </Link>

      {/* Game header */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-4">
        <div className="text-xs text-gray-400 uppercase tracking-wider mb-3">
          {formatDate(game.game_date)}
          {game.is_conference_game && (
            <span className="ml-2 bg-nw-teal/10 text-nw-teal px-1.5 py-0.5 rounded font-semibold">
              Conference
            </span>
          )}
          {game.innings && game.innings !== 9 && (
            <span className="ml-2 bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-semibold">
              {game.innings} Innings
            </span>
          )}
        </div>

        {/* Score display */}
        <div className="flex items-center justify-center gap-6">
          <div className={`text-center ${awayWon ? '' : 'opacity-60'}`}>
            {game.away_logo && (
              <img src={game.away_logo} alt="" className="w-12 h-12 object-contain mx-auto mb-1"
                onError={(e) => { e.target.style.display = 'none' }} />
            )}
            <div className="text-sm font-bold text-gray-800">{awayName}</div>
            {game.away_division && (
              <div className="text-[10px] text-gray-400">{game.away_division}</div>
            )}
          </div>

          <div className="flex items-baseline gap-3">
            <span className={`text-4xl font-bold font-mono ${awayWon ? 'text-gray-900' : 'text-gray-400'}`}>
              {game.away_score}
            </span>
            <span className="text-lg text-gray-300">-</span>
            <span className={`text-4xl font-bold font-mono ${homeWon ? 'text-gray-900' : 'text-gray-400'}`}>
              {game.home_score}
            </span>
          </div>

          <div className={`text-center ${homeWon ? '' : 'opacity-60'}`}>
            {game.home_logo && (
              <img src={game.home_logo} alt="" className="w-12 h-12 object-contain mx-auto mb-1"
                onError={(e) => { e.target.style.display = 'none' }} />
            )}
            <div className="text-sm font-bold text-gray-800">{homeName}</div>
            {game.home_division && (
              <div className="text-[10px] text-gray-400">{game.home_division}</div>
            )}
          </div>
        </div>
      </div>

      {/* Line score */}
      {(game.home_line_score || game.away_line_score) && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden mb-4">
          <LineScore game={game} />
        </div>
      )}

      {/* Box scores */}
      <div className="space-y-4">
        <BattingTable players={away_batting} teamName={awayName} teamLogo={game.away_logo} />
        <PitchingTable players={away_pitching} teamName={awayName} teamLogo={game.away_logo} />
        <BattingTable players={home_batting} teamName={homeName} teamLogo={game.home_logo} />
        <PitchingTable players={home_pitching} teamName={homeName} teamLogo={game.home_logo} />
      </div>
    </div>
  )
}
