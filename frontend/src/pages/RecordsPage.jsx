import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { formatStat, divisionBadgeClass } from '../utils/stats'
import StatsLastUpdated from '../components/StatsLastUpdated'

const API_BASE = '/api/v1'
const LEVELS = ['PNW', 'D1', 'D2', 'D3', 'NAIA', 'JUCO']
const SCOPES = [
  { key: 'single_season', label: 'Single Season' },
  { key: 'career', label: 'Career' },
]

function RecordTable({ stat, scope }) {
  const leaders = stat.leaders || []
  if (!leaders.length) return <p className="text-xs text-gray-400 italic px-2 py-1">No qualifying records</p>

  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-gray-400 text-[10px] uppercase tracking-wide">
          <th className="text-left pb-1 pl-1 w-6">#</th>
          <th className="text-left pb-1">Player</th>
          <th className="text-left pb-1">Team</th>
          {scope === 'single_season' && <th className="text-center pb-1">Year</th>}
          <th className="text-right pb-1 pr-1">Value</th>
        </tr>
      </thead>
      <tbody>
        {leaders.map((r, i) => (
          <tr key={`${r.player_id}-${r.season}-${i}`} className={i % 2 === 0 ? 'bg-gray-50/50' : ''}>
            <td className="py-1 pl-1 text-gray-400 font-medium">{i + 1}</td>
            <td className="py-1">
              <Link to={`/player/${r.player_id}`} className="text-teal-700 hover:underline font-medium">
                {r.first_name} {r.last_name}
              </Link>
            </td>
            <td className="py-1">
              <div className="flex items-center gap-1">
                {r.logo_url && (
                  <img src={r.logo_url} alt="" className="w-3.5 h-3.5 object-contain"
                       onError={(e) => { e.target.style.display = 'none' }} />
                )}
                <span className="text-gray-600">{r.team_short}</span>
              </div>
            </td>
            {scope === 'single_season' && (
              <td className="py-1 text-center text-gray-500">{r.season}</td>
            )}
            <td className="py-1 pr-1 text-right font-bold text-pnw-slate">
              {formatStat(r.value, stat.format)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function TeamRecordTable({ stat }) {
  const leaders = stat.leaders || []
  if (!leaders.length) return <p className="text-xs text-gray-400 italic px-2 py-1">No qualifying records</p>

  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-gray-400 text-[10px] uppercase tracking-wide">
          <th className="text-left pb-1 pl-1 w-6">#</th>
          <th className="text-left pb-1">Team</th>
          <th className="text-center pb-1">Year</th>
          <th className="text-right pb-1 pr-1">Value</th>
        </tr>
      </thead>
      <tbody>
        {leaders.map((r, i) => (
          <tr key={`${r.team_id}-${r.season}-${i}`} className={i % 2 === 0 ? 'bg-gray-50/50' : ''}>
            <td className="py-1 pl-1 text-gray-400 font-medium">{i + 1}</td>
            <td className="py-1">
              <Link to={`/team/${r.team_id}`} className="flex items-center gap-1.5 text-teal-700 hover:underline font-medium">
                {r.logo_url && (
                  <img src={r.logo_url} alt="" className="w-4 h-4 object-contain"
                       onError={(e) => { e.target.style.display = 'none' }} />
                )}
                {r.team_short}
              </Link>
            </td>
            <td className="py-1 text-center text-gray-500">{r.season}</td>
            <td className="py-1 pr-1 text-right font-bold text-pnw-slate">
              {formatStat(r.value, stat.format)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function StatSection({ title, data, scope, isTeam = false }) {
  if (!data || !Object.keys(data).length) return null
  const entries = Object.entries(data)

  return (
    <div>
      <h3 className="text-base font-bold text-pnw-slate mb-3 flex items-center gap-2">
        {title}
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {entries.map(([key, stat]) => (
          <div key={key} className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            <div className="px-3 py-2 bg-gray-50 border-b border-gray-100">
              <span className="text-xs font-bold text-gray-700 uppercase tracking-wide">{stat.label}</span>
            </div>
            <div className="p-2">
              {isTeam
                ? <TeamRecordTable stat={stat} />
                : <RecordTable stat={stat} scope={scope} />
              }
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}


export default function RecordsPage() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [level, setLevel] = useState('PNW')
  const [scope, setScope] = useState('single_season')
  const [category, setCategory] = useState('batting')

  useEffect(() => {
    setLoading(true)
    fetch(`${API_BASE}/records?limit=5`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const battingData = data?.batting?.[level]?.[scope] || {}
  const pitchingData = data?.pitching?.[level]?.[scope] || {}
  const teamData = data?.team?.[level]?.single_season || {}

  return (
    <div className="max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-pnw-slate">PNW Records</h1>
        <p className="text-sm text-gray-400 mt-1">
          Single-season and career record holders across all PNW divisions
        </p>
      </div>

      {/* Controls */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-6 space-y-3">
        {/* Division level tabs */}
        <div>
          <span className="text-xs font-bold text-gray-400 uppercase tracking-wide mr-3">Division</span>
          <div className="inline-flex gap-1 bg-gray-100 rounded-lg p-1">
            {LEVELS.map(l => (
              <button
                key={l}
                onClick={() => setLevel(l)}
                className={`px-3 py-1.5 rounded-md text-xs font-bold transition-colors ${
                  level === l
                    ? 'bg-white text-pnw-slate shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {l === 'JUCO' ? 'NWAC' : l}
              </button>
            ))}
          </div>
        </div>

        {/* Category + scope tabs */}
        <div className="flex flex-wrap gap-4">
          <div>
            <span className="text-xs font-bold text-gray-400 uppercase tracking-wide mr-3">Category</span>
            <div className="inline-flex gap-1 bg-gray-100 rounded-lg p-1">
              {[
                { key: 'batting', label: 'Batting' },
                { key: 'pitching', label: 'Pitching' },
                { key: 'team', label: 'Team' },
              ].map(c => (
                <button
                  key={c.key}
                  onClick={() => setCategory(c.key)}
                  className={`px-3 py-1.5 rounded-md text-xs font-bold transition-colors ${
                    category === c.key
                      ? 'bg-white text-pnw-slate shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          {category !== 'team' && (
            <div>
              <span className="text-xs font-bold text-gray-400 uppercase tracking-wide mr-3">Scope</span>
              <div className="inline-flex gap-1 bg-gray-100 rounded-lg p-1">
                {SCOPES.map(s => (
                  <button
                    key={s.key}
                    onClick={() => setScope(s.key)}
                    className={`px-3 py-1.5 rounded-md text-xs font-bold transition-colors ${
                      scope === s.key
                        ? 'bg-white text-pnw-slate shadow-sm'
                        : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {loading && (
        <div className="flex justify-center py-12">
          <div className="animate-spin h-8 w-8 border-4 border-teal-500 border-t-transparent rounded-full" />
        </div>
      )}

      {!loading && data && (
        <div className="space-y-8">
          {/* Qualification note */}
          <p className="text-xs text-gray-400 italic">
            {category === 'batting' && scope === 'single_season' && 'Minimum 100 PA for single-season batting records.'}
            {category === 'batting' && scope === 'career' && 'Minimum 250 career PA for career batting records.'}
            {category === 'pitching' && scope === 'single_season' && 'Minimum 40 IP for single-season pitching records.'}
            {category === 'pitching' && scope === 'career' && 'Minimum 100 career IP for career pitching records.'}
            {category === 'team' && 'Single-season team records (2020 season excluded).'}
          </p>

          {category === 'batting' && (
            <StatSection
              title={`${scope === 'career' ? 'Career' : 'Single-Season'} Batting Records${level !== 'PNW' ? ` - ${level === 'JUCO' ? 'NWAC' : level}` : ''}`}
              data={battingData}
              scope={scope}
            />
          )}

          {category === 'pitching' && (
            <StatSection
              title={`${scope === 'career' ? 'Career' : 'Single-Season'} Pitching Records${level !== 'PNW' ? ` - ${level === 'JUCO' ? 'NWAC' : level}` : ''}`}
              data={pitchingData}
              scope={scope}
            />
          )}

          {category === 'team' && (
            <StatSection
              title={`Single-Season Team Records${level !== 'PNW' ? ` - ${level === 'JUCO' ? 'NWAC' : level}` : ''}`}
              data={teamData}
              scope="single_season"
              isTeam
            />
          )}
        </div>
      )}

      <StatsLastUpdated />
    </div>
  )
}
