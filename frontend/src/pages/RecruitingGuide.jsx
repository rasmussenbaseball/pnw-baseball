import React, { useState, useMemo } from 'react'
import {
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import { useApi } from '../hooks/useApi'
import { useTeams } from '../hooks/useApi'

// Color palette for charts
const COLORS = ['#00687a', '#7dd3fc', '#f97316', '#94a3b8', '#4ade80', '#f472b6', '#a78bfa']
const TEAL_PRIMARY = '#00687a'
const TEAL_LIGHT = '#7dd3fc'

// Helper function to convert inches to feet'inches" format
const inchesToFeetStr = (inches) => {
  if (!inches) return '-'
  const feet = Math.floor(inches / 12)
  const remaining = inches % 12
  return `${feet}'${remaining}"`
}

// Team Selector Component
function TeamSelector({ teams, selectedTeamId, onTeamSelect, loading: teamsLoading }) {
  // Group teams by division
  const groupedTeams = useMemo(() => {
    if (!teams) return {}
    return teams.reduce((acc, team) => {
      const div = team.division_name || 'Other'
      if (!acc[div]) acc[div] = []
      acc[div].push(team)
      return acc
    }, {})
  }, [teams])

  return (
    <div className="mb-6">
      <label className="block text-sm font-semibold text-gray-700 mb-2">Select a Team</label>
      <select
        value={selectedTeamId || ''}
        onChange={(e) => onTeamSelect(e.target.value ? parseInt(e.target.value) : null)}
        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-nw-teal bg-white"
        disabled={teamsLoading}
      >
        <option value="">-- Choose a team --</option>
        {Object.entries(groupedTeams).map(([division, divTeams]) => (
          <optgroup key={division} label={division}>
            {divTeams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.short_name || team.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  )
}

// Team Header Component
function TeamHeader({ teamInfo, loading }) {
  if (loading) {
    return (
      <div className="bg-nw-teal/10 border border-nw-teal/30 rounded-xl p-6 mb-8 animate-pulse">
        <div className="h-12 bg-gray-300 rounded w-1/3 mb-2"></div>
      </div>
    )
  }

  if (!teamInfo) return null

  return (
    <div className="bg-gradient-to-r from-nw-teal/20 to-nw-teal/10 border border-nw-teal/40 rounded-xl p-6 mb-8">
      <div className="flex items-start gap-4">
        {teamInfo.logo_url && (
          <img
            src={teamInfo.logo_url}
            alt={teamInfo.name}
            className="h-16 w-16 object-cover rounded-lg"
            onError={(e) => (e.target.style.display = 'none')}
          />
        )}
        <div className="flex-1">
          <h1 className="text-3xl font-bold text-nw-teal mb-1">{teamInfo.name}</h1>
          <p className="text-gray-700 font-medium">
            {teamInfo.city}, {teamInfo.state} • {teamInfo.school_name}
          </p>
          <p className="text-sm text-gray-600 mt-2">
            {teamInfo.division_name} • {teamInfo.conference_name}
          </p>
        </div>
      </div>
    </div>
  )
}


// Season History Table Component
function SeasonHistory({ seasonRecords, loading }) {
  if (loading) {
    return (
      <div className="bg-white rounded-xl shadow-sm p-6 mb-8 border border-gray-100 animate-pulse">
        <div className="h-6 bg-gray-300 rounded w-1/4 mb-6"></div>
        <div className="h-48 bg-gray-200 rounded"></div>
      </div>
    )
  }

  if (!seasonRecords || seasonRecords.length === 0) {
    return null
  }

  // Sort descending (most recent first) for the table
  const sorted = [...seasonRecords].sort((a, b) => b.season - a.season)

  // Compute totals
  const totals = sorted.reduce(
    (acc, r) => {
      acc.wins += r.wins || 0
      acc.losses += r.losses || 0
      acc.ties += r.ties || 0
      acc.confWins += r.conf_wins || 0
      acc.confLosses += r.conf_losses || 0
      return acc
    },
    { wins: 0, losses: 0, ties: 0, confWins: 0, confLosses: 0 }
  )

  const fmtPct = (w, l) => {
    const total = w + l
    if (total === 0) return '-'
    return (w / total).toFixed(3).replace(/^0/, '')
  }

  const fmtRecord = (w, l, t) => {
    if (t && t > 0) return `${w}-${l}-${t}`
    return `${w}-${l}`
  }

  return (
    <div className="bg-white rounded-xl shadow-sm p-6 mb-8 border border-gray-100">
      <h2 className="text-xl font-bold text-gray-900 mb-4">Year-by-Year Record</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b-2 border-gray-200">
              <th className="text-left py-3 px-4 font-semibold text-gray-900">Season</th>
              <th className="text-center py-3 px-4 font-semibold text-gray-900">Overall</th>
              <th className="text-center py-3 px-4 font-semibold text-gray-900">Win%</th>
              <th className="text-center py-3 px-4 font-semibold text-gray-900">Conference</th>
              <th className="text-center py-3 px-4 font-semibold text-gray-900">Conf%</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, idx) => {
              const overallPct = fmtPct(r.wins, r.losses)
              const confPct = fmtPct(r.conf_wins || 0, r.conf_losses || 0)
              const hasConf = (r.conf_wins || 0) + (r.conf_losses || 0) > 0
              return (
                <tr key={r.season} className={idx % 2 === 0 ? 'bg-gray-50' : ''}>
                  <td className="py-3 px-4 font-semibold text-nw-teal">{r.season}</td>
                  <td className="py-3 px-4 text-center font-medium text-gray-900">
                    {fmtRecord(r.wins, r.losses, r.ties)}
                  </td>
                  <td className="py-3 px-4 text-center text-gray-700">{overallPct}</td>
                  <td className="py-3 px-4 text-center font-medium text-gray-900">
                    {hasConf ? `${r.conf_wins}-${r.conf_losses}` : '-'}
                  </td>
                  <td className="py-3 px-4 text-center text-gray-700">{hasConf ? confPct : '-'}</td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-gray-300 bg-nw-teal/5 font-semibold">
              <td className="py-3 px-4 text-gray-900">Totals ({sorted.length} seasons)</td>
              <td className="py-3 px-4 text-center text-gray-900">
                {fmtRecord(totals.wins, totals.losses, totals.ties)}
              </td>
              <td className="py-3 px-4 text-center text-gray-700">{fmtPct(totals.wins, totals.losses)}</td>
              <td className="py-3 px-4 text-center text-gray-900">
                {totals.confWins + totals.confLosses > 0
                  ? `${totals.confWins}-${totals.confLosses}`
                  : '-'}
              </td>
              <td className="py-3 px-4 text-center text-gray-700">
                {totals.confWins + totals.confLosses > 0
                  ? fmtPct(totals.confWins, totals.confLosses)
                  : '-'}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}

// Team Trends Component
function TeamTrends({ seasonRecords, warBySeason, loading }) {
  if (loading) {
    return (
      <div className="bg-white rounded-xl shadow-sm p-6 mb-8 border border-gray-100 animate-pulse">
        <div className="h-6 bg-gray-300 rounded w-1/4 mb-6"></div>
        <div className="h-64 bg-gray-200 rounded"></div>
      </div>
    )
  }

  if (!seasonRecords || seasonRecords.length === 0) {
    return null
  }

  // Prepare data for W-L stacked bar chart (Win% / Loss%)
  const recordsData = seasonRecords.map((r) => {
    const total = (r.wins || 0) + (r.losses || 0)
    const winPct = total > 0 ? parseFloat(((r.wins || 0) / total * 100).toFixed(1)) : 0
    const lossPct = total > 0 ? parseFloat(((r.losses || 0) / total * 100).toFixed(1)) : 0
    return { season: r.season, winPct, lossPct }
  })

  // Prepare WAR data
  const warData = warBySeason
    ? warBySeason.map((w) => ({
        season: w.season,
        owar: parseFloat(w.total_owar) || 0,
        pwar: parseFloat(w.total_pwar) || 0,
        totalwar: parseFloat(w.total_war) || 0,
      }))
    : []

  return (
    <div className="space-y-8 mb-8">
      {/* Win-Loss % Stacked Bar */}
      <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100">
        <h3 className="text-lg font-bold text-gray-900 mb-4">Win-Loss % by Season</h3>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={recordsData} stackOffset="none">
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="season" stroke="#6b7280" />
            <YAxis stroke="#6b7280" domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
            <Tooltip
              contentStyle={{ backgroundColor: '#fff', border: `1px solid ${TEAL_PRIMARY}` }}
              formatter={(v) => `${v}%`}
            />
            <Legend />
            <Bar dataKey="winPct" stackId="wl" fill={TEAL_PRIMARY} name="Win %" />
            <Bar dataKey="lossPct" stackId="wl" fill="#ef4444" name="Loss %" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Total WAR by Season */}
      {warData.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100">
          <h3 className="text-lg font-bold text-gray-900 mb-4">Total WAR by Season</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={warData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="season" stroke="#6b7280" />
              <YAxis stroke="#6b7280" />
              <Tooltip contentStyle={{ backgroundColor: '#fff', border: `1px solid ${TEAL_PRIMARY}` }} />
              <Legend />
              <Bar dataKey="owar" fill={TEAL_PRIMARY} name="Offensive WAR" />
              <Bar dataKey="pwar" fill={TEAL_LIGHT} name="Pitching WAR" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

// Roster Overview Component
function RosterOverview({ rosterOverview, fourYearRetention, loading }) {
  if (loading) {
    return (
      <div className="bg-white rounded-xl shadow-sm p-6 mb-8 border border-gray-100 animate-pulse">
        <div className="h-6 bg-gray-300 rounded w-1/4 mb-6"></div>
        <div className="h-48 bg-gray-200 rounded"></div>
      </div>
    )
  }

  if (!rosterOverview) return null

  const byClassData =
    rosterOverview.by_class && Object.entries(rosterOverview.by_class).length > 0
      ? Object.entries(rosterOverview.by_class).map(([cls, count]) => ({
          name: cls,
          value: count,
        }))
      : []

  return (
    <div className="space-y-8 mb-8">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100">
          <p className="text-sm font-semibold text-gray-600 uppercase mb-2">Roster Size</p>
          <p className="text-3xl font-bold text-nw-teal">{rosterOverview.total_players}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100">
          <p className="text-sm font-semibold text-gray-600 uppercase mb-2">Appeared in Games</p>
          <p className="text-3xl font-bold text-green-600">{rosterOverview.players_appeared || 0}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100">
          <p className="text-sm font-semibold text-gray-600 uppercase mb-2">Pitchers</p>
          <p className="text-3xl font-bold text-blue-600">{rosterOverview.pitcher_count}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100">
          <p className="text-sm font-semibold text-gray-600 uppercase mb-2">Hitters</p>
          <p className="text-3xl font-bold text-orange-600">{rosterOverview.hitter_count}</p>
        </div>
      </div>

      {/* Class Distribution Pie Chart */}
      {byClassData.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100">
          <h3 className="text-lg font-bold text-gray-900 mb-4">Roster by Class</h3>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie data={byClassData} cx="50%" cy="50%" labelLine={false} label={({ name, value }) => `${name}: ${value}`} outerRadius={100} fill="#8884d8" dataKey="value">
                {byClassData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 4-Year Retention */}
      {fourYearRetention && fourYearRetention.is_four_year_school && (
        <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100">
          <h3 className="text-lg font-bold text-gray-900 mb-4">Four-Year Retention</h3>
          <p className="text-3xl font-bold text-nw-teal mb-2">{(fourYearRetention.rate * 100).toFixed(1)}%</p>
          <p className="text-sm text-gray-600">
            {fourYearRetention.four_year_players} of {fourYearRetention.total_tracked} players complete 4 years
          </p>
        </div>
      )}
    </div>
  )
}

// Freshman Production Component
function FreshmanProduction({ freshmanProduction, loading }) {
  if (loading || !freshmanProduction || freshmanProduction.length === 0) {
    return null
  }

  const data = freshmanProduction.map((f) => ({
    season: f.season,
    pa_pct: (parseFloat(f.fresh_pa_pct) * 100).toFixed(1),
    ip_pct: (parseFloat(f.fresh_ip_pct) * 100).toFixed(1),
  }))

  return (
    <div className="space-y-8 mb-8">
      <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100">
        <h3 className="text-lg font-bold text-gray-900 mb-4">Freshman Offensive Production</h3>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="season" stroke="#6b7280" />
            <YAxis stroke="#6b7280" domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
            <Tooltip contentStyle={{ backgroundColor: '#fff', border: `1px solid ${TEAL_PRIMARY}` }} formatter={(v) => `${v}%`} />
            <Bar dataKey="pa_pct" fill={TEAL_PRIMARY} name="Freshman PA %" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100">
        <h3 className="text-lg font-bold text-gray-900 mb-4">Freshman Pitching Production</h3>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="season" stroke="#6b7280" />
            <YAxis stroke="#6b7280" domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
            <Tooltip contentStyle={{ backgroundColor: '#fff', border: `1px solid ${TEAL_PRIMARY}` }} formatter={(v) => `${v}%`} />
            <Bar dataKey="ip_pct" fill="#3b82f6" name="Freshman IP %" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// Roster Turnover Component
function RosterTurnover({ rosterTurnover, loading }) {
  if (loading || !rosterTurnover || rosterTurnover.length === 0) {
    return null
  }

  const data = rosterTurnover.map((rt) => ({
    transition: `${rt.from_season} → ${rt.to_season}`,
    seniors_graduated: rt.seniors_graduated || 0,
    non_seniors_returned: rt.non_seniors_returned || 0,
    new_players: rt.new_players || 0,
    retention_pct: (parseFloat(rt.retention_pct) * 100).toFixed(1),
  }))

  return (
    <div className="bg-white rounded-xl shadow-sm p-6 mb-8 border border-gray-100">
      <h3 className="text-lg font-bold text-gray-900 mb-4">Roster Turnover Year-over-Year</h3>
      <p className="text-sm text-gray-500 mb-4">Retention % excludes graduating seniors</p>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="transition" stroke="#6b7280" />
          <YAxis stroke="#6b7280" />
          <Tooltip contentStyle={{ backgroundColor: '#fff', border: `1px solid ${TEAL_PRIMARY}` }} />
          <Legend />
          <Bar dataKey="non_seniors_returned" stackId="roster" fill={TEAL_PRIMARY} name="Returning Non-Seniors" />
          <Bar dataKey="seniors_graduated" stackId="roster" fill="#94a3b8" name="Seniors Graduated" />
          <Bar dataKey="new_players" stackId="roster" fill="#f97316" name="New Players" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
        {data.map((d, idx) => (
          <div key={idx} className="text-center p-2 bg-gray-50 rounded-lg">
            <p className="text-xs text-gray-500">{d.transition}</p>
            <p className="text-lg font-bold text-nw-teal">{d.retention_pct}%</p>
            <p className="text-xs text-gray-500">non-senior retention</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// Average Size by Position Component
function AverageSizeByPosition({ avgSizeByPosition, loading }) {
  if (loading || !avgSizeByPosition || avgSizeByPosition.length === 0) {
    return null
  }

  return (
    <div className="bg-white rounded-xl shadow-sm p-6 mb-8 border border-gray-100">
      <h3 className="text-lg font-bold text-gray-900 mb-4">Average Size by Position</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200">
              <th className="text-left py-3 px-4 font-semibold text-gray-900">Position</th>
              <th className="text-left py-3 px-4 font-semibold text-gray-900">Avg Height</th>
              <th className="text-left py-3 px-4 font-semibold text-gray-900">Avg Weight</th>
              <th className="text-left py-3 px-4 font-semibold text-gray-900">Players</th>
            </tr>
          </thead>
          <tbody>
            {avgSizeByPosition.map((pos, idx) => (
              <tr key={idx} className={idx % 2 === 0 ? 'bg-gray-50' : ''}>
                <td className="py-3 px-4 font-medium text-gray-900">{pos.position_group}</td>
                <td className="py-3 px-4 text-gray-700">{inchesToFeetStr(pos.avg_height_inches)}</td>
                <td className="py-3 px-4 text-gray-700">{pos.avg_weight ? `${pos.avg_weight} lbs` : '-'}</td>
                <td className="py-3 px-4 text-gray-700">{pos.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// Player Hometowns Component
function PlayerHometowns({ playerHometowns, hometownBreakdown, loading }) {
  if (loading || !hometownBreakdown) {
    return null
  }

  const stateData = hometownBreakdown.by_state
    ? hometownBreakdown.by_state.map((s) => ({ name: s.state, value: s.count }))
    : []

  return (
    <div className="space-y-8 mb-8">
      {/* State breakdown */}
      {stateData.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100">
          <h3 className="text-lg font-bold text-gray-900 mb-4">Players by State</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={stateData} layout="vertical" margin={{ left: 80 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis type="number" stroke="#6b7280" />
              <YAxis dataKey="name" type="category" stroke="#6b7280" width={70} tick={{ fontSize: 12 }} />
              <Tooltip contentStyle={{ backgroundColor: '#fff', border: `1px solid ${TEAL_PRIMARY}` }} />
              <Bar dataKey="value" fill={TEAL_PRIMARY} name="Player Count" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Player list */}
      {playerHometowns && playerHometowns.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100">
          <h3 className="text-lg font-bold text-gray-900 mb-4">All Players</h3>
          <div className="max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 sticky top-0 bg-gray-50">
                  <th className="text-left py-3 px-4 font-semibold text-gray-900">Name</th>
                  <th className="text-left py-3 px-4 font-semibold text-gray-900">Hometown</th>
                </tr>
              </thead>
              <tbody>
                {playerHometowns.map((player, idx) => (
                  <tr key={idx} className={idx % 2 === 0 ? 'bg-gray-50' : ''}>
                    <td className="py-3 px-4 font-medium text-gray-900">{player.name}</td>
                    <td className="py-3 px-4 text-gray-700">
                      {player.hometown}
                    </td>
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

// Best Players Component
function BestPlayers({ bestPlayers, loading }) {
  if (loading || !bestPlayers) {
    return null
  }

  const battingPlayers = bestPlayers.batting || []
  const pitchingPlayers = bestPlayers.pitching || []

  if (battingPlayers.length === 0 && pitchingPlayers.length === 0) {
    return null
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
      {/* Top Hitters */}
      {battingPlayers.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100">
          <h3 className="text-lg font-bold text-gray-900 mb-4">Top Hitters (All-Time WAR)</h3>
          <div className="space-y-3">
            {battingPlayers.slice(0, 10).map((player, idx) => (
              <div key={idx} className="flex items-start gap-3 pb-3 border-b border-gray-100 last:border-b-0">
                <div className="flex-shrink-0 w-6 h-6 rounded-full bg-nw-teal text-white flex items-center justify-center text-xs font-bold">
                  {idx + 1}
                </div>
                <div className="flex-1">
                  <p className="font-semibold text-gray-900">{player.name}</p>
                  <p className="text-sm text-gray-600">
                    {player.position} • {player.seasons && player.seasons.join(', ')}
                  </p>
                  <p className="text-sm font-semibold text-nw-teal mt-1">
                    {parseFloat(player.total_war).toFixed(1)} WAR
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top Pitchers */}
      {pitchingPlayers.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100">
          <h3 className="text-lg font-bold text-gray-900 mb-4">Top Pitchers (All-Time WAR)</h3>
          <div className="space-y-3">
            {pitchingPlayers.slice(0, 10).map((player, idx) => (
              <div key={idx} className="flex items-start gap-3 pb-3 border-b border-gray-100 last:border-b-0">
                <div className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white flex items-center justify-center text-xs font-bold">
                  {idx + 1}
                </div>
                <div className="flex-1">
                  <p className="font-semibold text-gray-900">{player.name}</p>
                  <p className="text-sm text-gray-600">
                    {player.position} • {player.seasons && player.seasons.join(', ')}
                  </p>
                  <p className="text-sm font-semibold text-blue-600 mt-1">
                    {parseFloat(player.total_war).toFixed(1)} WAR
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}


// Main Component
export default function RecruitingGuide() {
  const [selectedTeamId, setSelectedTeamId] = useState(null)

  // Fetch teams
  const { data: teams = [], loading: teamsLoading } = useTeams()

  // Fetch guide data for selected team
  const endpoint = selectedTeamId ? `/recruiting/guide/${selectedTeamId}` : '/teams'
  const { data: rawGuide, loading: guideLoading } = useApi(endpoint, {}, [selectedTeamId])
  const guideData = selectedTeamId ? rawGuide : null
  const loading = guideLoading && selectedTeamId

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-800 mb-1">Recruiting Guide</h1>
        <p className="text-sm text-gray-500 mb-4">Complete program profiles, roster analysis, and recruiting intel.</p>

        {/* Team Selector */}
        <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100 mb-8">
          <TeamSelector teams={teams} selectedTeamId={selectedTeamId} onTeamSelect={setSelectedTeamId} loading={teamsLoading} />
        </div>

        {/* Content - only show if team selected */}
        {selectedTeamId && (
          <>
            {/* Team Header */}
            <TeamHeader teamInfo={guideData?.team_info} loading={loading} />

            {/* Year-by-Year Record */}
            <SeasonHistory seasonRecords={guideData?.season_records} loading={loading} />

            {/* Team Trends */}
            <TeamTrends seasonRecords={guideData?.season_records} warBySeason={guideData?.war_by_season} loading={loading} />

            {/* Roster Overview */}
            <RosterOverview
              rosterOverview={guideData?.roster_overview}
              fourYearRetention={guideData?.four_year_retention}
              loading={loading}
            />

            {/* Freshman Production */}
            <FreshmanProduction freshmanProduction={guideData?.freshman_production} loading={loading} />

            {/* Roster Turnover */}
            <RosterTurnover rosterTurnover={guideData?.roster_turnover} loading={loading} />

            {/* Average Size by Position */}
            <AverageSizeByPosition avgSizeByPosition={guideData?.avg_size_by_position} loading={loading} />

            {/* Player Hometowns */}
            <PlayerHometowns playerHometowns={guideData?.player_hometowns} hometownBreakdown={guideData?.hometown_breakdown} loading={loading} />

            {/* Best Players */}
            <BestPlayers bestPlayers={guideData?.best_players} loading={loading} />

          </>
        )}

        {/* Empty State */}
        {!selectedTeamId && (
          <div className="text-center py-16 text-gray-400">
            <svg className="w-16 h-16 mx-auto mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21" />
            </svg>
            <p className="text-lg font-medium text-gray-500 mb-1">Select a team above</p>
            <p className="text-sm">View roster analysis, trends, hometowns, and more for any PNW program.</p>
          </div>
        )}
      </div>
    </div>
  )
}
