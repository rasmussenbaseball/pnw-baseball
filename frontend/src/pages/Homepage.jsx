import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useStatLeaders, useStandings, useNationalRankings, useTeamRatings } from '../hooks/useApi'
import { divisionBadgeClass } from '../utils/stats'

const SEASON = 2026

// ─── Stat value formatting ───
function fmtVal(value, format) {
  if (value == null) return '—'
  if (format === 'int') return Math.round(value)
  if (format === 'avg') return value.toFixed(3).replace(/^0/, '')
  if (format === 'float1') return value.toFixed(1)
  if (format === 'float2') return value.toFixed(2)
  if (format === 'pct') return (value * 100).toFixed(1) + '%'
  return value
}

// ─── Division badge colors for inline use ───
const DIV_COLORS = {
  D1: 'bg-blue-600', D2: 'bg-emerald-600', D3: 'bg-amber-600',
  NAIA: 'bg-red-600', JUCO: 'bg-purple-600',
}

export default function Homepage() {
  const { data: leaders } = useStatLeaders(SEASON, 5, true)
  const { data: standings } = useStandings(SEASON)
  const { data: rankings } = useNationalRankings(SEASON)
  const { data: ratings } = useTeamRatings(SEASON)

  return (
    <div>
      {/* Hero ticker — stat leaders marquee */}
      <LeaderTicker leaders={leaders} />

      {/* Main dashboard grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mt-5">
        {/* Left column — wider (2/3) */}
        <div className="lg:col-span-2 flex flex-col gap-5">
          <NationalRankingsWidget rankings={rankings} />
          <StandingsWidget standings={standings} />
        </div>

        {/* Right column — sidebar (1/3) */}
        <div className="flex flex-col gap-5">
          <StatLeadersWidget leaders={leaders} />
          <PowerRankingsWidget ratings={ratings} />
          <QuickLinksWidget />
        </div>
      </div>
    </div>
  )
}


// ════════════════════════════════════════════
// LEADER TICKER (top bar, scrolling stat leaders)
// ════════════════════════════════════════════
function LeaderTicker({ leaders }) {
  if (!leaders) return null

  const allLeaders = [
    ...(leaders.batting || []),
    ...(leaders.pitching || []),
  ]

  return (
    <div className="bg-pnw-slate rounded-xl overflow-hidden">
      <div className="flex overflow-x-auto scrollbar-hide gap-0 divide-x divide-gray-600">
        {allLeaders.map((cat) => {
          const top = cat.leaders?.[0]
          if (!top) return null
          return (
            <Link
              key={cat.key}
              to={cat.key === 'era' || cat.key === 'strikeouts' || cat.key === 'pitching_war' || cat.key === 'fip_plus' || cat.key === 'siera' || cat.key === 'k_minus_bb_pct'
                ? '/pitching' : '/hitting'}
              className="flex-none px-4 py-2.5 hover:bg-white/5 transition-colors min-w-0"
            >
              <div className="text-[10px] text-gray-400 uppercase tracking-wider font-medium">{cat.label} Leader</div>
              <div className="flex items-center gap-2 mt-0.5">
                {top.logo_url && (
                  <img src={top.logo_url} alt="" className="w-5 h-5 object-contain"
                    onError={(e) => { e.target.style.display = 'none' }} />
                )}
                <span className="text-sm text-white font-semibold truncate">
                  {top.first_name[0]}. {top.last_name}
                </span>
                <span className="text-sm text-pnw-teal font-bold ml-auto">
                  {fmtVal(top.value, cat.format)}
                </span>
              </div>
              <div className="text-[10px] text-gray-500 truncate">{top.short_name}</div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}


// ════════════════════════════════════════════
// NATIONAL RANKINGS WIDGET
// ════════════════════════════════════════════
function NationalRankingsWidget({ rankings }) {
  if (!rankings) return <WidgetSkeleton title="National Rankings" />

  // Show top 5 per division (skip JUCO)
  const divisions = (rankings.divisions || []).filter(d => d.division_level !== 'JUCO')

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-bold text-pnw-slate">National Rankings</h2>
        <Link to="/national-rankings" className="text-xs text-pnw-teal hover:underline">View all →</Link>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {divisions.map((div) => (
          <div key={div.division_level}>
            <div className={`text-xs font-bold text-white px-2 py-1 rounded-t ${DIV_COLORS[div.division_level] || 'bg-gray-600'}`}>
              {div.division_level}
            </div>
            <div className="border border-t-0 border-gray-200 rounded-b">
              {div.teams.slice(0, 5).map((team, i) => (
                <Link
                  key={team.team_id}
                  to={`/team/${team.team_id}`}
                  className={`flex items-center gap-1.5 px-2 py-1.5 text-xs hover:bg-gray-50 ${
                    i < div.teams.length - 1 && i < 4 ? 'border-b border-gray-100' : ''
                  }`}
                >
                  <span className="text-gray-400 w-4 text-right font-mono text-[10px]">
                    {Math.round(team.composite_rank)}
                  </span>
                  {team.logo_url && (
                    <img src={team.logo_url} alt="" className="w-4 h-4 object-contain"
                      onError={(e) => { e.target.style.display = 'none' }} />
                  )}
                  <span className="font-medium text-gray-800 truncate flex-1">{team.short_name}</span>
                  <span className="text-gray-400 text-[10px]">{team.record}</span>
                  {team.national_percentile && (
                    <span className={`text-[10px] font-semibold px-1 rounded ${
                      team.national_percentile >= 75 ? 'text-green-700 bg-green-50'
                      : team.national_percentile >= 50 ? 'text-amber-700 bg-amber-50'
                      : 'text-gray-500'
                    }`}>
                      {team.national_percentile.toFixed(0)}%
                    </span>
                  )}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}


// ════════════════════════════════════════════
// STANDINGS WIDGET (compact conference standings)
// ════════════════════════════════════════════
function StandingsWidget({ standings }) {
  const [showAll, setShowAll] = useState(false)
  if (!standings) return <WidgetSkeleton title="Standings" />

  const conferences = standings.conferences || []
  // Group by division level for cleaner display
  const byDiv = {}
  conferences.forEach(c => {
    const lvl = c.division_level
    if (!byDiv[lvl]) byDiv[lvl] = []
    byDiv[lvl].push(c)
  })

  const divOrder = ['D1', 'D2', 'D3', 'NAIA', 'JUCO']
  const visibleDivs = showAll ? divOrder : divOrder.filter(d => d !== 'JUCO')

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-bold text-pnw-slate">Conference Standings</h2>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowAll(!showAll)}
            className="text-xs text-pnw-teal hover:underline"
          >
            {showAll ? 'Hide JUCO' : 'Show JUCO'}
          </button>
          <Link to="/standings" className="text-xs text-pnw-teal hover:underline">Full standings →</Link>
        </div>
      </div>

      {visibleDivs.map(divLevel => {
        const confs = byDiv[divLevel]
        if (!confs) return null
        return (
          <div key={divLevel} className="mb-3 last:mb-0">
            <div className={`text-[10px] font-bold text-white px-2 py-0.5 rounded ${DIV_COLORS[divLevel] || 'bg-gray-600'} inline-block mb-1.5`}>
              {divLevel}
            </div>
            <div className={`grid gap-3 ${confs.length > 1 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1'}`}>
              {confs.map(conf => (
                <div key={conf.conference_id} className="border border-gray-200 rounded text-xs">
                  <div className="bg-gray-50 px-2 py-1 font-semibold text-gray-700 border-b border-gray-200 flex justify-between">
                    <span>{conf.conference_abbrev || conf.conference_name}</span>
                    <span className="text-gray-400 font-normal">Conf / Overall</span>
                  </div>
                  {conf.teams.map((team) => (
                    <Link
                      key={team.id}
                      to={`/team/${team.id}`}
                      className="flex items-center gap-1.5 px-2 py-1 hover:bg-gray-50 border-b border-gray-50 last:border-b-0"
                    >
                      {team.logo_url && (
                        <img src={team.logo_url} alt="" className="w-4 h-4 object-contain"
                          onError={(e) => { e.target.style.display = 'none' }} />
                      )}
                      <span className="font-medium text-gray-800 truncate flex-1">{team.short_name}</span>
                      <span className="text-gray-500 font-mono text-[10px] w-12 text-right">
                        {team.conf_wins + team.conf_losses > 0
                          ? `${team.conf_wins}-${team.conf_losses}`
                          : '—'}
                      </span>
                      <span className="text-gray-400 font-mono text-[10px] w-12 text-right">
                        {team.wins}-{team.losses}
                      </span>
                    </Link>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}


// ════════════════════════════════════════════
// STAT LEADERS WIDGET (sidebar)
// ════════════════════════════════════════════
function StatLeadersWidget({ leaders }) {
  if (!leaders) return <WidgetSkeleton title="Stat Leaders" />

  // Pick the most interesting categories for the sidebar
  const battingCats = (leaders.batting || []).slice(0, 3) // wRC+, HR, SB
  const pitchingCats = (leaders.pitching || []).slice(0, 3) // pWAR, FIP+, SIERA

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-bold text-pnw-slate">Stat Leaders</h2>
        <Link to="/stat-leaders" className="text-xs text-pnw-teal hover:underline">View all →</Link>
      </div>

      <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Batting</div>
      {battingCats.map(cat => (
        <LeaderCategory key={cat.key} cat={cat} type="batting" />
      ))}

      <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5 mt-3">Pitching</div>
      {pitchingCats.map(cat => (
        <LeaderCategory key={cat.key} cat={cat} type="pitching" />
      ))}
    </div>
  )
}

function LeaderCategory({ cat, type }) {
  return (
    <div className="mb-2.5 last:mb-0">
      <div className="text-xs font-semibold text-pnw-slate mb-1">{cat.label}</div>
      {cat.leaders?.slice(0, 3).map((p, i) => (
        <Link
          key={p.player_id}
          to={`/player/${p.player_id}`}
          className="flex items-center gap-1.5 py-0.5 text-xs hover:bg-gray-50 rounded px-1 -mx-1"
        >
          <span className={`w-4 text-right font-mono text-[10px] ${
            i === 0 ? 'text-amber-500 font-bold' : 'text-gray-400'
          }`}>
            {i + 1}
          </span>
          {p.logo_url && (
            <img src={p.logo_url} alt="" className="w-3.5 h-3.5 object-contain"
              onError={(e) => { e.target.style.display = 'none' }} />
          )}
          <span className="text-gray-700 truncate flex-1">
            {p.first_name[0]}. {p.last_name}
          </span>
          <span className="text-[10px] text-gray-400">{p.short_name}</span>
          <span className="font-bold text-pnw-slate ml-1 font-mono">
            {fmtVal(p.value, cat.format)}
          </span>
        </Link>
      ))}
    </div>
  )
}


// ════════════════════════════════════════════
// POWER RANKINGS WIDGET (team WAR / PPI)
// ════════════════════════════════════════════
function PowerRankingsWidget({ ratings }) {
  const [selectedDiv, setSelectedDiv] = useState('all')
  if (!ratings) return <WidgetSkeleton title="Power Rankings" />

  // API returns an array of division objects directly
  const divisions = Array.isArray(ratings) ? ratings : (ratings.divisions || [])
  // Flatten all teams and sort by total WAR
  let allTeams = []
  divisions.forEach(div => {
    (div.teams || []).forEach(t => {
      allTeams.push({
        ...t,
        team_id: t.team_id || t.id,
        division_level: t.division_level || div.division_level,
        record: t.record || `${t.wins}-${t.losses}`,
      })
    })
  })
  allTeams.sort((a, b) => (b.team_war || 0) - (a.team_war || 0))

  if (selectedDiv !== 'all') {
    allTeams = allTeams.filter(t => t.division_level === selectedDiv)
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-base font-bold text-pnw-slate">Power Rankings</h2>
        <Link to="/team-ratings" className="text-xs text-pnw-teal hover:underline">View all →</Link>
      </div>

      <div className="flex gap-1 mb-2.5 flex-wrap">
        {['all', 'D1', 'D2', 'D3', 'NAIA'].map(d => (
          <button
            key={d}
            onClick={() => setSelectedDiv(d)}
            className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
              selectedDiv === d
                ? 'bg-pnw-teal text-white'
                : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
            }`}
          >
            {d === 'all' ? 'All' : d}
          </button>
        ))}
      </div>

      <div className="space-y-0">
        {allTeams.slice(0, 10).map((team, i) => (
          <Link
            key={team.team_id}
            to={`/team/${team.team_id}`}
            className="flex items-center gap-1.5 py-1 text-xs hover:bg-gray-50 rounded px-1 -mx-1 border-b border-gray-50 last:border-0"
          >
            <span className={`w-4 text-right font-mono text-[10px] ${
              i < 3 ? 'text-amber-500 font-bold' : 'text-gray-400'
            }`}>
              {i + 1}
            </span>
            <span className={`w-1.5 h-1.5 rounded-full ${DIV_COLORS[team.division_level] || 'bg-gray-400'}`} />
            {team.logo_url && (
              <img src={team.logo_url} alt="" className="w-4 h-4 object-contain"
                onError={(e) => { e.target.style.display = 'none' }} />
            )}
            <span className="font-medium text-gray-800 truncate flex-1">{team.short_name}</span>
            <span className="text-gray-400 text-[10px]">{team.record}</span>
            <span className="font-bold text-pnw-slate font-mono text-[11px] w-8 text-right">
              {team.team_war?.toFixed(1) || '0.0'}
            </span>
          </Link>
        ))}
      </div>
      <div className="text-[10px] text-gray-400 text-right mt-1">Ranked by Team WAR</div>
    </div>
  )
}


// ════════════════════════════════════════════
// QUICK LINKS WIDGET
// ════════════════════════════════════════════
function QuickLinksWidget() {
  const links = [
    { to: '/juco-tracker', label: 'JUCO Tracker', desc: 'Uncommitted sophomores' },
    { to: '/war', label: 'WAR Leaders', desc: 'Top players by WAR' },
    { to: '/hitting', label: 'Batting Leaders', desc: 'Full batting leaderboard' },
    { to: '/pitching', label: 'Pitching Leaders', desc: 'Full pitching leaderboard' },
    { to: '/compare', label: 'Team Compare', desc: 'Head-to-head team stats' },
    { to: '/glossary', label: 'Glossary', desc: 'Stat definitions & methodology' },
  ]

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <h2 className="text-base font-bold text-pnw-slate mb-2">Quick Links</h2>
      <div className="grid grid-cols-2 gap-1.5">
        {links.map(link => (
          <Link
            key={link.to}
            to={link.to}
            className="px-2.5 py-2 rounded-lg border border-gray-100 hover:border-pnw-teal hover:bg-pnw-teal/5 transition-colors"
          >
            <div className="text-xs font-semibold text-pnw-slate">{link.label}</div>
            <div className="text-[10px] text-gray-400">{link.desc}</div>
          </Link>
        ))}
      </div>
    </div>
  )
}


// ════════════════════════════════════════════
// LOADING SKELETON
// ════════════════════════════════════════════
function WidgetSkeleton({ title }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <h2 className="text-base font-bold text-pnw-slate mb-3">{title}</h2>
      <div className="animate-pulse space-y-2">
        <div className="h-3 bg-gray-200 rounded w-3/4" />
        <div className="h-3 bg-gray-200 rounded w-1/2" />
        <div className="h-3 bg-gray-200 rounded w-2/3" />
        <div className="h-3 bg-gray-200 rounded w-1/2" />
      </div>
    </div>
  )
}
