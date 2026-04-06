import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import StatsLastUpdated from '../components/StatsLastUpdated'

const API_BASE = '/api/v1'

const BADGE_COLORS = {
  D1: 'bg-red-600 text-white',
  D2: 'bg-blue-600 text-white',
  D3: 'bg-green-600 text-white',
  NAIA: 'bg-purple-600 text-white',
  JUCO: 'bg-amber-700 text-white',
}

function formatPct(pct) {
  if (!pct && pct !== 0) return '.000'
  return pct === 1 ? '1.000' : `.${String(Math.round(pct * 1000)).padStart(3, '0')}`
}

function formatRecord(wins, losses) {
  return `${Math.round(wins)}-${Math.round(losses)}`
}

function formatOdds(pct) {
  if (!pct && pct !== 0) return '-'
  if (pct >= 0.995) return '>99%'
  if (pct <= 0.005 && pct > 0) return '<1%'
  if (pct === 0) return '-'
  return `${Math.round(pct * 100)}%`
}

// Color for odds bars
function oddsColor(pct) {
  if (pct >= 0.8) return 'bg-teal-500'
  if (pct >= 0.5) return 'bg-teal-400'
  if (pct >= 0.2) return 'bg-amber-400'
  return 'bg-gray-300'
}

function oddsTextColor(pct) {
  if (pct >= 0.8) return 'text-teal-700'
  if (pct >= 0.5) return 'text-teal-600'
  if (pct >= 0.2) return 'text-amber-700'
  return 'text-gray-400'
}


// ─── Odds Bar ───
function OddsBar({ pct, label, small }) {
  const width = Math.max(pct * 100, 1)
  return (
    <div className={`flex items-center gap-1.5 ${small ? '' : 'min-w-[80px]'}`}>
      <div className={`flex-1 bg-gray-100 rounded-full overflow-hidden ${small ? 'h-1.5' : 'h-2'}`}>
        <div
          className={`h-full rounded-full transition-all ${oddsColor(pct)}`}
          style={{ width: `${width}%` }}
        />
      </div>
      {label !== false && (
        <span className={`${small ? 'text-[9px]' : 'text-[10px]'} font-bold ${oddsTextColor(pct)} whitespace-nowrap`}>
          {formatOdds(pct)}
        </span>
      )}
    </div>
  )
}


// ─── Projected Conference Standings Table with Odds ───
function ProjectedStandingsTable({ conference, playoffTeamCount }) {
  const badgeClass = BADGE_COLORS[conference.division_level] || 'bg-gray-500 text-white'
  const teams = conference.teams || []

  // Get max seed to show
  const maxSeed = playoffTeamCount || 0

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2">
        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${badgeClass}`}>
          {conference.division_level === 'JUCO' ? 'NWAC' : conference.division_level}
        </span>
        <h3 className="text-sm font-bold text-gray-800 truncate">
          {conference.conference_name}
        </h3>
        {maxSeed > 0 && (
          <span className="text-[9px] text-gray-400 ml-auto">
            Top {maxSeed} make playoffs
          </span>
        )}
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-[9px] text-gray-400 uppercase tracking-wider">
              <th className="text-left pl-3 pr-1 py-1.5 font-semibold">Team</th>
              <th className="text-center px-1 py-1.5 font-semibold" title="Current overall record">Current</th>
              <th className="text-center px-1 py-1.5 font-semibold" title="Projected final conference record">Proj Conf</th>
              <th className="text-center px-1 py-1.5 font-semibold" title="Projected conference win %">Pct</th>
              <th className="text-center px-1 py-1.5 font-semibold" title="Projected final overall record">Proj All</th>
              <th className="text-center px-1 py-1.5 font-semibold" title="Games remaining">Rem</th>
              <th className="text-center px-1 py-1.5 font-semibold" title="Power rating">PWR</th>
              <th className="text-center px-1 py-1.5 font-semibold min-w-[70px]" title="Playoff probability">Playoff %</th>
              {/* Seed probability columns */}
              {Array.from({ length: maxSeed }, (_, i) => (
                <th key={i} className="text-center px-0.5 py-1.5 font-semibold min-w-[36px]" title={`Probability of finishing as #${i + 1} seed`}>
                  #{i + 1}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {teams.map((team, i) => {
              const isPlayoffTeam = playoffTeamCount && i < playoffTeamCount
              const playoffPct = team.playoff_pct || 0
              const seedProbs = team.seed_probabilities || {}

              return (
                <tr
                  key={team.team_id}
                  className={`border-t border-gray-50 hover:bg-teal-50/50 ${
                    isPlayoffTeam ? '' : 'opacity-60'
                  }`}
                >
                  <td className="pl-3 pr-1 py-1.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {isPlayoffTeam && (
                        <span className="text-[9px] font-bold text-teal-600 w-3 text-right shrink-0">
                          {i + 1}
                        </span>
                      )}
                      {!isPlayoffTeam && <span className="w-3 shrink-0" />}
                      {team.logo_url && (
                        <img
                          src={team.logo_url}
                          alt=""
                          className="w-4 h-4 object-contain shrink-0"
                          onError={(e) => { e.target.style.display = 'none' }}
                        />
                      )}
                      <Link
                        to={`/team/${team.team_id}`}
                        className="font-semibold text-gray-800 hover:text-teal-700 truncate"
                      >
                        {team.short_name}
                      </Link>
                    </div>
                  </td>
                  <td className="text-center px-1 py-1.5 text-gray-500">
                    {team.current_wins}-{team.current_losses}
                  </td>
                  <td className="text-center px-1 py-1.5 font-medium">
                    {formatRecord(team.projected_conf_wins, team.projected_conf_losses)}
                  </td>
                  <td className="text-center px-1 py-1.5 font-bold text-pnw-slate">
                    {formatPct(team.projected_conf_win_pct)}
                  </td>
                  <td className="text-center px-1 py-1.5 font-medium">
                    {formatRecord(team.projected_wins, team.projected_losses)}
                  </td>
                  <td className="text-center px-1 py-1.5 text-gray-400">
                    {team.games_remaining}
                  </td>
                  <td className="text-center px-1 py-1.5">
                    {team.power_rating ? (
                      <span className="text-[10px] font-bold text-teal-700">{team.power_rating.toFixed(1)}</span>
                    ) : (
                      <span className="text-gray-300">-</span>
                    )}
                  </td>
                  <td className="px-1 py-1.5">
                    <OddsBar pct={playoffPct} />
                  </td>
                  {/* Seed probability cells */}
                  {Array.from({ length: maxSeed }, (_, seedIdx) => {
                    const seedPct = seedProbs[seedIdx + 1] || 0
                    return (
                      <td key={seedIdx} className="text-center px-0.5 py-1.5">
                        <span className={`text-[9px] font-bold ${
                          seedPct >= 0.3 ? 'text-teal-700' :
                          seedPct >= 0.1 ? 'text-teal-500' :
                          seedPct > 0 ? 'text-gray-400' : 'text-gray-200'
                        }`}>
                          {seedPct > 0 ? formatOdds(seedPct) : '-'}
                        </span>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}


// ─── Bracket Matchup Line ───
function BracketMatchup({ teamA, teamB, label, description }) {
  return (
    <div className="bg-gray-50 rounded-lg p-2.5 border border-gray-100">
      {label && (
        <p className="text-[9px] font-bold text-gray-400 uppercase tracking-wide mb-1.5">{label}</p>
      )}
      <div className="space-y-1">
        <BracketTeamRow team={teamA} isTop />
        <div className="flex items-center gap-2 px-2">
          <div className="flex-1 border-t border-gray-200" />
          <span className="text-[8px] font-bold text-gray-300 uppercase">vs</span>
          <div className="flex-1 border-t border-gray-200" />
        </div>
        <BracketTeamRow team={teamB} />
      </div>
      {description && (
        <p className="text-[9px] text-gray-400 mt-1.5 italic">{description}</p>
      )}
    </div>
  )
}

function BracketTeamRow({ team, isTop }) {
  if (!team) return <div className="px-2 py-1.5 text-[10px] text-gray-300 italic">TBD</div>
  return (
    <div className="flex items-center gap-2 px-2 py-1 rounded hover:bg-white/80 transition-colors">
      <span className="text-[10px] font-bold text-teal-600 w-4 text-right shrink-0">
        #{team.seed}
      </span>
      {team.logo_url && (
        <img
          src={team.logo_url}
          alt=""
          className="w-4 h-4 object-contain shrink-0"
          onError={(e) => { e.target.style.display = 'none' }}
        />
      )}
      <Link
        to={`/team/${team.team_id}`}
        className="text-[11px] font-semibold text-gray-800 hover:text-teal-700 truncate"
      >
        {team.short_name}
      </Link>
      <span className="text-[9px] text-gray-400 ml-auto whitespace-nowrap">
        {team.projected_conf_record}
      </span>
      {team.power_rating && (
        <span className="text-[9px] font-bold text-teal-600">
          {team.power_rating.toFixed(1)}
        </span>
      )}
    </div>
  )
}


// ─── GNAC Bracket (Pod Format) ───
function GNACBracket({ bracket }) {
  const teams = bracket.teams || []
  const getTeam = (seed) => teams.find(t => t.seed === seed)

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      <BracketHeader bracket={bracket} />
      <div className="p-3 space-y-3">
        <p className="text-[10px] text-gray-400 italic">{bracket.description}</p>

        {/* Seeded Teams */}
        <div className="space-y-1">
          {teams.map(team => (
            <BracketTeamCompact key={team.team_id} team={team} />
          ))}
        </div>

        {/* Pod Matchups */}
        <div className="grid grid-cols-2 gap-3 mt-3">
          <div>
            <p className="text-[9px] font-bold text-gray-500 uppercase tracking-wide mb-2 text-center">Pod A</p>
            <div className="space-y-2">
              <BracketMatchup
                teamA={getTeam(1)}
                teamB={getTeam(8)}
                label="1 vs 8"
              />
              <BracketMatchup
                teamA={getTeam(4)}
                teamB={getTeam(5)}
                label="4 vs 5"
              />
            </div>
            <p className="text-[8px] text-gray-400 text-center mt-1.5">Double Elimination</p>
          </div>
          <div>
            <p className="text-[9px] font-bold text-gray-500 uppercase tracking-wide mb-2 text-center">Pod B</p>
            <div className="space-y-2">
              <BracketMatchup
                teamA={getTeam(2)}
                teamB={getTeam(7)}
                label="2 vs 7"
              />
              <BracketMatchup
                teamA={getTeam(3)}
                teamB={getTeam(6)}
                label="3 vs 6"
              />
            </div>
            <p className="text-[8px] text-gray-400 text-center mt-1.5">Double Elimination</p>
          </div>
        </div>

        {/* Championship */}
        <div className="bg-teal-50 rounded-lg p-2.5 border border-teal-100 text-center">
          <p className="text-[9px] font-bold text-teal-700 uppercase tracking-wide">Championship</p>
          <p className="text-[10px] text-teal-600 mt-0.5">Pod A Winner vs Pod B Winner</p>
          <p className="text-[9px] text-teal-500">Best of 3</p>
        </div>
      </div>
    </div>
  )
}


// ─── NWC Bracket (Top 4, Double Elimination) ───
function NWCBracket({ bracket }) {
  const teams = bracket.teams || []
  const getTeam = (seed) => teams.find(t => t.seed === seed)

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      <BracketHeader bracket={bracket} />
      <div className="p-3 space-y-3">
        <p className="text-[10px] text-gray-400 italic">{bracket.description}</p>

        {/* Seeded Teams */}
        <div className="space-y-1">
          {teams.map(team => (
            <BracketTeamCompact key={team.team_id} team={team} />
          ))}
        </div>

        {/* Bracket */}
        <div className="space-y-2 mt-3">
          <p className="text-[9px] font-bold text-gray-500 uppercase tracking-wide">Opening Round</p>
          <div className="grid grid-cols-2 gap-2">
            <BracketMatchup teamA={getTeam(1)} teamB={getTeam(4)} label="Game 1" />
            <BracketMatchup teamA={getTeam(2)} teamB={getTeam(3)} label="Game 2" />
          </div>
          <div className="bg-teal-50 rounded-lg p-2 border border-teal-100 text-center">
            <p className="text-[9px] font-bold text-teal-700 uppercase">Double Elimination</p>
            <p className="text-[9px] text-teal-500">Winners and losers brackets until champion emerges</p>
          </div>
        </div>
      </div>
    </div>
  )
}


// ─── CCC Bracket (Top 5, #1 bye, Double Elimination) ───
function CCCBracket({ bracket }) {
  const teams = bracket.teams || []
  const getTeam = (seed) => teams.find(t => t.seed === seed)

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      <BracketHeader bracket={bracket} />
      <div className="p-3 space-y-3">
        <p className="text-[10px] text-gray-400 italic">{bracket.description}</p>

        {/* Seeded Teams */}
        <div className="space-y-1">
          {teams.map(team => (
            <BracketTeamCompact key={team.team_id} team={team} />
          ))}
        </div>

        {/* Bracket Structure */}
        <div className="space-y-2 mt-3">
          {/* #1 Bye */}
          <div className="bg-teal-50 rounded-lg p-2 border border-teal-100">
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-bold text-teal-700 uppercase">Bye + Host:</span>
              {getTeam(1) && (
                <span className="text-[10px] font-semibold text-teal-700">
                  #{getTeam(1).seed} {getTeam(1).short_name}
                </span>
              )}
            </div>
          </div>

          <p className="text-[9px] font-bold text-gray-500 uppercase tracking-wide">Opening Round</p>
          <div className="grid grid-cols-2 gap-2">
            <BracketMatchup teamA={getTeam(2)} teamB={getTeam(3)} label="#2 vs #3" />
            <BracketMatchup teamA={getTeam(4)} teamB={getTeam(5)} label="#4 vs #5" />
          </div>

          <div className="bg-teal-50 rounded-lg p-2 border border-teal-100 text-center">
            <p className="text-[9px] font-bold text-teal-700 uppercase">Double Elimination</p>
            <p className="text-[9px] text-teal-500">#1 seed enters winners bracket with a bye</p>
          </div>
        </div>
      </div>
    </div>
  )
}


// ─── NWAC Regional Bracket ───
function NWACBracket({ bracket }) {
  const teams = bracket.teams || []
  const getTeam = (seed) => teams.find(t => t.seed === seed)

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      <BracketHeader bracket={bracket} />
      <div className="p-3 space-y-3">
        <p className="text-[10px] text-gray-400 italic">{bracket.description}</p>

        {/* Seeded Teams */}
        <div className="space-y-1">
          {teams.map(team => (
            <BracketTeamCompact key={team.team_id} team={team} />
          ))}
        </div>

        {/* Bracket Structure */}
        <div className="space-y-2 mt-3">
          {/* Auto-advance */}
          <div className="bg-teal-50 rounded-lg p-2 border border-teal-100">
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-bold text-teal-700 uppercase">Auto-advance to Final 8:</span>
              {getTeam(1) && (
                <span className="text-[10px] font-semibold text-teal-700">
                  #{getTeam(1).seed} {getTeam(1).short_name}
                </span>
              )}
            </div>
          </div>

          {/* First round */}
          <BracketMatchup
            teamA={getTeam(3)}
            teamB={getTeam(4)}
            label="Regional Play-in"
            description="Single elimination, hosted by #2 seed"
          />

          {/* Second round */}
          <BracketMatchup
            teamA={getTeam(2)}
            teamB={null}
            label="Regional Final"
            description="Winner of #3 vs #4 plays at #2. Best of 3. Winner advances to Final 8."
          />
        </div>
      </div>
    </div>
  )
}


// ─── Shared Bracket Components ───
function BracketHeader({ bracket }) {
  const badgeClass = BADGE_COLORS[bracket.division_level] || 'bg-gray-500 text-white'
  const divLabel = bracket.division_level === 'JUCO' ? 'NWAC' : bracket.division_level

  return (
    <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2">
      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${badgeClass}`}>
        {divLabel}
      </span>
      <h3 className="text-sm font-bold text-gray-800">{bracket.format_name}</h3>
    </div>
  )
}

function BracketTeamCompact({ team }) {
  const playoffPct = team.playoff_pct || 0
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-gray-50 hover:bg-teal-50/50 transition-colors">
      <span className="text-xs font-bold text-teal-600 w-4 text-right shrink-0">
        #{team.seed}
      </span>
      {team.logo_url && (
        <img
          src={team.logo_url}
          alt=""
          className="w-5 h-5 object-contain shrink-0"
          onError={(e) => { e.target.style.display = 'none' }}
        />
      )}
      <Link
        to={`/team/${team.team_id}`}
        className="text-xs font-semibold text-gray-800 hover:text-teal-700"
      >
        {team.short_name}
      </Link>
      <span className="text-[10px] text-gray-400 ml-auto">
        {team.projected_conf_record} conf
      </span>
      {team.power_rating && (
        <span className="text-[10px] font-bold text-teal-600 ml-1">
          {team.power_rating.toFixed(1)}
        </span>
      )}
      <div className="w-16">
        <OddsBar pct={playoffPct} small />
      </div>
    </div>
  )
}


// ─── Playoff Odds Overview Table ───
function PlayoffOddsTable({ conferences, playoffCountByConf }) {
  return (
    <div className="space-y-4">
      {conferences.map(conf => {
        const maxSeed = playoffCountByConf[conf.conference_name] || 0
        if (maxSeed === 0) return null
        const teams = conf.teams || []

        return (
          <div key={conf.conference_name} className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2">
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${BADGE_COLORS[conf.division_level] || 'bg-gray-500 text-white'}`}>
                {conf.division_level === 'JUCO' ? 'NWAC' : conf.division_level}
              </span>
              <h3 className="text-sm font-bold text-gray-800">{conf.conference_name}</h3>
            </div>

            <div className="p-3">
              <div className="space-y-1.5">
                {teams.map((team, i) => {
                  const playoffPct = team.playoff_pct || 0
                  const seedProbs = team.seed_probabilities || {}
                  const isIn = i < maxSeed

                  return (
                    <div
                      key={team.team_id}
                      className={`flex items-center gap-2 px-2 py-2 rounded-md transition-colors ${
                        isIn ? 'bg-teal-50/50 hover:bg-teal-50' : 'bg-gray-50/50 hover:bg-gray-50 opacity-60'
                      }`}
                    >
                      <span className="text-[10px] font-bold text-gray-400 w-4 text-right">{i + 1}</span>
                      {team.logo_url && (
                        <img
                          src={team.logo_url}
                          alt=""
                          className="w-5 h-5 object-contain shrink-0"
                          onError={(e) => { e.target.style.display = 'none' }}
                        />
                      )}
                      <Link
                        to={`/team/${team.team_id}`}
                        className="text-xs font-semibold text-gray-800 hover:text-teal-700 min-w-[80px] truncate"
                      >
                        {team.short_name}
                      </Link>

                      {/* Playoff odds bar */}
                      <div className="flex-1 max-w-[120px]">
                        <OddsBar pct={playoffPct} />
                      </div>

                      {/* Seed probability mini-bars */}
                      <div className="flex gap-0.5 items-end">
                        {Array.from({ length: maxSeed }, (_, si) => {
                          const sp = seedProbs[si + 1] || 0
                          const barH = Math.max(sp * 28, 1)
                          return (
                            <div key={si} className="flex flex-col items-center" title={`#${si + 1} seed: ${formatOdds(sp)}`}>
                              <div
                                className={`w-3 rounded-t-sm transition-all ${sp > 0 ? oddsColor(sp) : 'bg-gray-100'}`}
                                style={{ height: `${barH}px` }}
                              />
                              <span className="text-[7px] text-gray-400 mt-0.5">
                                {si + 1}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}


// ─── Main Page ───
export default function PlayoffProjections() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState('standings') // 'standings', 'brackets', 'odds'
  const [divFilter, setDivFilter] = useState('all')

  useEffect(() => {
    setLoading(true)
    fetch(`${API_BASE}/playoff-projections?season=2026`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const conferences = data?.conferences || []
  const playoffs = data?.playoffs || []

  // Build a lookup: conference_name -> playoff team count
  const playoffCountByConf = {}
  for (const bracket of playoffs) {
    playoffCountByConf[bracket.conference] = bracket.teams?.length || 0
  }

  // Exclude D1
  const nonD1Conferences = conferences.filter(c => c.division_level !== 'D1')

  // Filter by division
  const filteredConferences = divFilter === 'all'
    ? nonD1Conferences
    : nonD1Conferences.filter(c => c.division_level === divFilter)

  const filteredPlayoffs = divFilter === 'all'
    ? playoffs
    : playoffs.filter(b => b.division_level === divFilter)

  const DIVISIONS = ['all', 'D2', 'D3', 'NAIA', 'JUCO']

  // Render the right bracket component based on format
  function renderBracket(bracket) {
    if (bracket.format_type === 'double_elimination_pods') {
      return <GNACBracket key={bracket.conference} bracket={bracket} />
    }
    if (bracket.format_type === 'nwac_regional') {
      return <NWACBracket key={bracket.conference} bracket={bracket} />
    }
    if (bracket.format_name?.includes('CCC') || bracket.conference?.includes('Cascade')) {
      return <CCCBracket key={bracket.conference} bracket={bracket} />
    }
    if (bracket.format_name?.includes('NWC') || bracket.conference?.includes('Northwest Conference')) {
      return <NWCBracket key={bracket.conference} bracket={bracket} />
    }
    // Fallback - generic double elim
    return <NWCBracket key={bracket.conference} bracket={bracket} />
  }

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-pnw-slate">Playoff Projections</h1>
        <p className="text-sm text-gray-400 mt-1">
          Projected end-of-season standings, playoff fields, and tournament odds based on remaining schedules and power ratings
        </p>
        {data?.schedule_last_updated && (
          <p className="text-[10px] text-gray-300 mt-1">
            Schedules updated: {new Date(data.schedule_last_updated).toLocaleDateString()}
            {' - '}{data.total_future_games} games remaining
            {' - '}1,000 simulations
          </p>
        )}
      </div>

      {/* Controls */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-6 space-y-3">
        <div className="flex flex-wrap gap-4">
          {/* View toggle */}
          <div>
            <span className="text-xs font-bold text-gray-400 uppercase tracking-wide mr-3">View</span>
            <div className="inline-flex gap-1 bg-gray-100 rounded-lg p-1">
              {[
                { key: 'standings', label: 'Projected Standings' },
                { key: 'brackets', label: 'Playoff Brackets' },
                { key: 'odds', label: 'Playoff Odds' },
              ].map(v => (
                <button
                  key={v.key}
                  onClick={() => setView(v.key)}
                  className={`px-3 py-1.5 rounded-md text-xs font-bold transition-colors ${
                    view === v.key
                      ? 'bg-white text-pnw-slate shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
          </div>

          {/* Division filter */}
          <div>
            <span className="text-xs font-bold text-gray-400 uppercase tracking-wide mr-3">Division</span>
            <div className="inline-flex gap-1 bg-gray-100 rounded-lg p-1">
              {DIVISIONS.map(d => (
                <button
                  key={d}
                  onClick={() => setDivFilter(d)}
                  className={`px-3 py-1.5 rounded-md text-xs font-bold transition-colors ${
                    divFilter === d
                      ? 'bg-white text-pnw-slate shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {d === 'all' ? 'All' : d === 'JUCO' ? 'NWAC' : d}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {loading && (
        <div className="flex justify-center py-12">
          <div className="animate-spin h-8 w-8 border-4 border-teal-500 border-t-transparent rounded-full" />
        </div>
      )}

      {/* Standings View */}
      {!loading && data && view === 'standings' && (
        <div className="space-y-4">
          <p className="text-xs text-gray-400 italic">
            Projected records use power ratings and Elo win probability for each remaining game.
            Playoff odds come from 1,000 Monte Carlo simulations of the remaining schedule.
            Seed columns show the probability of finishing in that exact position.
          </p>
          {filteredConferences.map(conf => (
            <ProjectedStandingsTable
              key={conf.conference_name}
              conference={conf}
              playoffTeamCount={playoffCountByConf[conf.conference_name] || 0}
            />
          ))}
          {filteredConferences.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-8">
              No schedule data available yet. Run the future schedule scraper to generate projections.
            </p>
          )}
        </div>
      )}

      {/* Brackets View */}
      {!loading && data && view === 'brackets' && (
        <div className="space-y-4">
          <p className="text-xs text-gray-400 italic">
            Projected playoff fields based on each conference's tournament format and projected conference standings.
            Brackets show matchup structure with seeded teams.
          </p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {filteredPlayoffs.map(bracket => renderBracket(bracket))}
          </div>
          {filteredPlayoffs.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-8">
              No playoff projection data available yet.
            </p>
          )}
        </div>
      )}

      {/* Odds View */}
      {!loading && data && view === 'odds' && (
        <div className="space-y-4">
          <p className="text-xs text-gray-400 italic">
            Playoff probability and seed distribution for every team, based on 1,000 Monte Carlo simulations.
            The bar chart shows how likely each team is to finish in each seed position.
          </p>
          <PlayoffOddsTable
            conferences={filteredConferences}
            playoffCountByConf={playoffCountByConf}
          />
          {filteredConferences.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-8">
              No projection data available yet.
            </p>
          )}
        </div>
      )}

      <StatsLastUpdated />
    </div>
  )
}
