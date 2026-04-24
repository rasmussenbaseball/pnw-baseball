import { useState, useMemo, useEffect } from 'react'
import {
  useTeams,
  useDivisions,
  useHistoricMatchup,
  useHistoricMatchupOpponents,
} from '../hooks/useApi'

const SEASON = 2026

export default function HistoricMatchups() {
  const [divisionId, setDivisionId] = useState('')
  const [teamAId, setTeamAId] = useState(null)
  const [teamBId, setTeamBId] = useState(null)
  const [mode, setMode] = useState('batting')   // 'batting' | 'pitching'

  const { data: divisions } = useDivisions()
  const { data: teams } = useTeams({
    season: SEASON,
    ...(divisionId && { division_id: divisionId }),
  })
  const { data: oppData } = useHistoricMatchupOpponents(teamAId, SEASON)
  const { data, loading, error } = useHistoricMatchup(teamAId, teamBId, SEASON)

  const sortedTeams = useMemo(() => {
    if (!teams) return []
    return [...teams].sort((a, b) =>
      (a.short_name || a.name).localeCompare(b.short_name || b.name)
    )
  }, [teams])

  const opponents = oppData?.opponents || []

  // If team A changes and the current opponent isn't in the new opponent
  // list, clear team B so we don't show stale data.
  useEffect(() => {
    if (!teamAId) {
      setTeamBId(null)
      return
    }
    if (teamBId && opponents.length > 0) {
      if (!opponents.some(o => o.id === teamBId)) {
        setTeamBId(null)
      }
    }
  }, [teamAId, teamBId, opponents])

  const swap = () => {
    if (!teamAId || !teamBId) return
    const tmp = teamAId
    setTeamAId(teamBId)
    setTeamBId(tmp)
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-5">
      <h1 className="text-xl font-bold text-gray-900 mb-1">Historic</h1>
      <p className="text-xs text-gray-500 mb-4">
        How a team's hitters and pitchers performed against a specific opponent this season
      </p>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-end mb-5">
        <select
          value={divisionId}
          onChange={e => {
            setDivisionId(e.target.value)
            setTeamAId(null)
            setTeamBId(null)
          }}
          className="rounded border border-gray-300 px-2 py-1.5 text-sm"
        >
          <option value="">All Divisions</option>
          {(divisions || []).map(d => (
            <option key={d.id} value={d.id}>{d.level}</option>
          ))}
        </select>

        <select
          value={teamAId || ''}
          onChange={e => {
            setTeamAId(e.target.value ? Number(e.target.value) : null)
            setTeamBId(null)
          }}
          className="rounded border border-gray-300 px-2 py-1.5 text-sm min-w-[180px]"
        >
          <option value="">Team...</option>
          {sortedTeams.map(t => (
            <option key={t.id} value={t.id}>{t.short_name || t.name}</option>
          ))}
        </select>

        <button
          type="button"
          onClick={swap}
          disabled={!teamAId || !teamBId}
          title="Swap teams"
          className="rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          ⇄
        </button>

        <select
          value={teamBId || ''}
          onChange={e => setTeamBId(e.target.value ? Number(e.target.value) : null)}
          disabled={!teamAId}
          className="rounded border border-gray-300 px-2 py-1.5 text-sm min-w-[180px] disabled:bg-gray-100"
        >
          <option value="">Opponent...</option>
          {opponents.map(o => (
            <option key={o.id} value={o.id}>{o.short_name || o.name}</option>
          ))}
        </select>

        <select
          value={SEASON}
          disabled
          className="rounded border border-gray-300 px-2 py-1.5 text-sm bg-gray-100 text-gray-500"
        >
          <option value={SEASON}>{SEASON}</option>
        </select>
      </div>

      {!teamAId && <Empty icon="🔍" text="Select a team" />}
      {teamAId && !teamBId && <Empty icon="🆚" text="Select an opponent" />}
      {teamAId && teamBId && loading && <Empty icon="⏳" text="Loading matchup..." spin />}
      {error && <div className="text-red-500 text-sm py-6 text-center">{error}</div>}

      {data && teamAId && teamBId && data.games.length === 0 && (
        <Empty icon="📭" text="No games between these teams this season" />
      )}

      {data && data.games.length > 0 && (
        <>
          {/* Game scoreboard */}
          <div className="mb-6">
            <h2 className="text-xs uppercase tracking-wide text-gray-500 mb-2 font-semibold">
              Series results · {data.games.length} game{data.games.length === 1 ? '' : 's'}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {data.games.map(g => (
                <GameCard key={g.id} game={g} teamAId={teamAId} />
              ))}
            </div>
          </div>

          {/* Batting / Pitching toggle (shared across both sides) */}
          <div className="flex gap-0.5 mb-3 bg-gray-100 rounded-lg p-0.5 w-fit">
            {['batting', 'pitching'].map(t => (
              <button
                key={t}
                onClick={() => setMode(t)}
                className={`px-3 py-1 rounded text-xs font-medium ${
                  mode === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
                }`}
              >
                {t === 'batting' ? 'Batting' : 'Pitching'}
              </button>
            ))}
          </div>

          {/* Side-by-side stats */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <SideStats
              team={data.team_a}
              batting={data.team_a_batting}
              pitching={data.team_a_pitching}
              totals={data.team_a_totals}
              mode={mode}
            />
            <SideStats
              team={data.team_b}
              batting={data.team_b_batting}
              pitching={data.team_b_pitching}
              totals={data.team_b_totals}
              mode={mode}
            />
          </div>
        </>
      )}
    </div>
  )
}

function Empty({ icon, text, spin }) {
  return (
    <div className="text-center py-16 text-gray-400">
      <div className={`text-3xl mb-2 ${spin ? 'animate-spin' : ''}`}>{icon}</div>
      <div className="text-sm">{text}</div>
    </div>
  )
}

function GameCard({ game, teamAId }) {
  const aIsHome = game.home_team_id === teamAId
  const aShort = aIsHome ? game.home_short : game.away_short
  const bShort = aIsHome ? game.away_short : game.home_short
  const aScore = aIsHome ? game.home_score : game.away_score
  const bScore = aIsHome ? game.away_score : game.home_score
  const aWon = aScore > bScore
  const aLost = bScore > aScore
  const locLabel = game.is_neutral_site
    ? 'Neutral'
    : aIsHome
      ? 'Home'
      : 'Away'

  const dateLabel = game.game_date
    ? new Date(game.game_date + 'T12:00:00').toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      })
    : ''

  return (
    <div className="border border-gray-200 rounded p-2 bg-white">
      <div className="flex items-center justify-between text-[10px] text-gray-500 mb-1">
        <span>{dateLabel}</span>
        <span>{locLabel}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className={`text-sm font-medium ${aWon ? 'text-pnw-forest' : aLost ? 'text-gray-500' : 'text-gray-700'}`}>
          {aShort}
        </span>
        <span className={`text-sm font-bold ${aWon ? 'text-pnw-forest' : 'text-gray-700'}`}>
          {aScore}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className={`text-sm font-medium ${!aWon && !aLost ? 'text-gray-700' : aLost ? 'text-pnw-forest' : 'text-gray-500'}`}>
          {bShort}
        </span>
        <span className={`text-sm font-bold ${aLost ? 'text-pnw-forest' : 'text-gray-700'}`}>
          {bScore}
        </span>
      </div>
      {(game.winning_pitcher || game.losing_pitcher || game.save_pitcher) && (
        <div className="mt-1 pt-1 border-t border-gray-100 text-[10px] text-gray-500 leading-snug">
          {game.winning_pitcher && (
            <div>W: <span className="text-gray-700">{game.winning_pitcher}</span></div>
          )}
          {game.losing_pitcher && (
            <div>L: <span className="text-gray-700">{game.losing_pitcher}</span></div>
          )}
          {game.save_pitcher && (
            <div>SV: <span className="text-gray-700">{game.save_pitcher}</span></div>
          )}
        </div>
      )}
    </div>
  )
}

function SideStats({ team, batting, pitching, totals, mode }) {
  return (
    <div className="border border-gray-200 rounded">
      <div className="flex items-center gap-2 px-3 py-2 bg-pnw-forest text-white rounded-t">
        {team.logo_url && (
          <img src={team.logo_url} alt="" className="w-6 h-6 object-contain bg-white rounded p-0.5" />
        )}
        <span className="font-semibold">{team.short_name || team.name}</span>
        <span className="text-[10px] text-white/70">
          {team.conference_abbrev} · {team.division_level}
        </span>
      </div>

      {totals && mode === 'batting' && <TeamBattingTotals t={totals.batting} />}
      {totals && mode === 'pitching' && <TeamPitchingTotals t={totals.pitching} />}

      <div className="overflow-x-auto">
        {mode === 'batting' && <BattingTable rows={batting} />}
        {mode === 'pitching' && <PitchingTable rows={pitching} />}
      </div>
    </div>
  )
}

function TeamBattingTotals({ t }) {
  if (!t) return null
  return (
    <div className="border-b border-gray-200 bg-pnw-cream/50 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold mb-1.5">
        Series Totals
      </div>
      <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
        <Stat label="AVG" value={fmtRate(t.avg)} />
        <Stat label="OBP" value={fmtRate(t.obp)} />
        <Stat label="SLG" value={fmtRate(t.slg)} />
        <Stat label="OPS" value={fmtRate(t.ops)} />
        <Stat label="ISO" value={fmtRate(t.iso)} />
        <Stat label="wOBA" value={fmtRate(t.woba)} />
        <Stat label="wRC+" value={fmtNum(t.wrc_plus, 0)} />
        <Stat label="BABIP" value={fmtRate(t.babip)} />
        <Stat label="BB%" value={fmtPct(t.bb_pct)} />
        <Stat label="K%" value={fmtPct(t.k_pct)} />
        <Stat label="HR" value={t.hr} />
        <Stat label="SB" value={t.sb} />
        <Stat label="R" value={t.r} />
        <Stat label="H" value={t.h} />
        <Stat label="PA" value={t.pa} />
        <Stat label="AB" value={t.ab} />
      </div>
    </div>
  )
}

function TeamPitchingTotals({ t }) {
  if (!t) return null
  return (
    <div className="border-b border-gray-200 bg-pnw-cream/50 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold mb-1.5">
        Series Totals
      </div>
      <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
        <Stat label="ERA" value={fmtNum(t.era, 2)} />
        <Stat label="FIP" value={fmtNum(t.fip, 2)} />
        <Stat label="xFIP" value={fmtNum(t.xfip, 2)} />
        <Stat label="WHIP" value={fmtNum(t.whip, 2)} />
        <Stat label="K/9" value={fmtNum(t.k9, 1)} />
        <Stat label="BB/9" value={fmtNum(t.bb9, 1)} />
        <Stat label="K%" value={fmtPct(t.k_pct)} />
        <Stat label="BB%" value={fmtPct(t.bb_pct)} />
        <Stat label="K/BB" value={fmtNum(t.k_bb, 2)} />
        <Stat label="BABIP" value={fmtRate(t.babip)} />
        <Stat label="IP" value={fmtIp(t.ip)} />
        <Stat label="K" value={t.k} />
        <Stat label="BB" value={t.bb} />
        <Stat label="H" value={t.h} />
        <Stat label="ER" value={t.er} />
      </div>
    </div>
  )
}

function Stat({ label, value }) {
  return (
    <div className="text-center">
      <div className="text-[9px] uppercase tracking-wide text-gray-500 font-semibold">{label}</div>
      <div className="text-xs font-semibold text-gray-900">{value ?? '-'}</div>
    </div>
  )
}

function fmtPct(v) {
  if (v === null || v === undefined) return '-'
  return (v * 100).toFixed(1) + '%'
}

function BattingTable({ rows }) {
  if (!rows || rows.length === 0) {
    return <div className="text-center text-xs text-gray-400 py-6">No batters</div>
  }
  return (
    <table className="w-full text-xs">
      <thead>
        {/* Section header: matchup vs season */}
        <tr className="bg-gray-100 text-gray-600 uppercase tracking-wide text-[9px]">
          <th className="sticky left-0 z-20 bg-gray-100" colSpan={1}></th>
          <th colSpan={16} className="text-center py-1 border-r border-gray-300 font-semibold">
            Matchup
          </th>
          <th colSpan={6} className="text-center py-1 bg-pnw-cream text-pnw-forest font-semibold">
            Season
          </th>
        </tr>
        <tr className="bg-gray-50 text-gray-600 uppercase tracking-wide text-[10px]">
          <th className="text-left px-2 py-1.5 sticky left-0 z-20 bg-gray-50">Player</th>
          <th className="px-1 py-1.5">G</th>
          <th className="px-1 py-1.5">PA</th>
          <th className="px-1 py-1.5">AB</th>
          <th className="px-1 py-1.5">R</th>
          <th className="px-1 py-1.5">H</th>
          <th className="px-1 py-1.5">2B</th>
          <th className="px-1 py-1.5">3B</th>
          <th className="px-1 py-1.5">HR</th>
          <th className="px-1 py-1.5">RBI</th>
          <th className="px-1 py-1.5">BB</th>
          <th className="px-1 py-1.5">K</th>
          <th className="px-1 py-1.5">SB</th>
          <th className="px-1 py-1.5">AVG</th>
          <th className="px-1 py-1.5">OBP</th>
          <th className="px-1 py-1.5">SLG</th>
          <th className="px-1 py-1.5 border-r border-gray-300">OPS</th>
          <th className="px-1 py-1.5 bg-pnw-cream/50">PA</th>
          <th className="px-1 py-1.5 bg-pnw-cream/50">AVG</th>
          <th className="px-1 py-1.5 bg-pnw-cream/50">OPS</th>
          <th className="px-1 py-1.5 bg-pnw-cream/50">HR</th>
          <th className="px-1 py-1.5 bg-pnw-cream/50">K%</th>
          <th className="px-1 py-1.5 bg-pnw-cream/50">BB%</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const rowBg = i % 2 === 0 ? 'bg-white' : 'bg-gray-50'
          return (
            <tr key={r.player_id || `n${i}`} className={rowBg}>
              <td className={`text-left px-2 py-1.5 text-gray-900 font-medium whitespace-nowrap sticky left-0 z-10 ${rowBg}`}>
                {r.player_name}
              </td>
              <td className="text-center px-1 py-1.5 text-gray-700">{r.g}</td>
              <td className="text-center px-1 py-1.5 text-gray-700">{r.pa}</td>
              <td className="text-center px-1 py-1.5 text-gray-700">{r.ab}</td>
              <td className="text-center px-1 py-1.5 text-gray-700">{r.r}</td>
              <td className="text-center px-1 py-1.5 text-gray-700">{r.h}</td>
              <td className="text-center px-1 py-1.5 text-gray-700">{r.doubles}</td>
              <td className="text-center px-1 py-1.5 text-gray-700">{r.triples}</td>
              <td className="text-center px-1 py-1.5 text-gray-700">{r.hr}</td>
              <td className="text-center px-1 py-1.5 text-gray-700">{r.rbi}</td>
              <td className="text-center px-1 py-1.5 text-gray-700">{r.bb}</td>
              <td className="text-center px-1 py-1.5 text-gray-700">{r.k}</td>
              <td className="text-center px-1 py-1.5 text-gray-700">{r.sb}</td>
              <td className="text-center px-1 py-1.5 font-semibold text-gray-900">{fmtRate(r.avg)}</td>
              <td className="text-center px-1 py-1.5 text-gray-700">{fmtRate(r.obp)}</td>
              <td className="text-center px-1 py-1.5 text-gray-700">{fmtRate(r.slg)}</td>
              <td className="text-center px-1 py-1.5 text-gray-700 border-r border-gray-300">{fmtRate(r.ops)}</td>
              <td className="text-center px-1 py-1.5 text-gray-700 bg-pnw-cream/30">{r.season_pa ?? '-'}</td>
              <td className="text-center px-1 py-1.5 text-gray-700 bg-pnw-cream/30 font-semibold">{fmtRate(r.season_avg)}</td>
              <td className="text-center px-1 py-1.5 text-gray-700 bg-pnw-cream/30">{fmtRate(r.season_ops)}</td>
              <td className="text-center px-1 py-1.5 text-gray-700 bg-pnw-cream/30">{r.season_hr ?? '-'}</td>
              <td className="text-center px-1 py-1.5 text-gray-700 bg-pnw-cream/30">{fmtPct(r.season_k_pct)}</td>
              <td className="text-center px-1 py-1.5 text-gray-700 bg-pnw-cream/30">{fmtPct(r.season_bb_pct)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function PitchingTable({ rows }) {
  if (!rows || rows.length === 0) {
    return <div className="text-center text-xs text-gray-400 py-6">No pitchers</div>
  }
  return (
    <table className="w-full text-xs">
      <thead>
        {/* Section header: matchup vs season */}
        <tr className="bg-gray-100 text-gray-600 uppercase tracking-wide text-[9px]">
          <th className="sticky left-0 z-20 bg-gray-100" colSpan={1}></th>
          <th colSpan={12} className="text-center py-1 border-r border-gray-300 font-semibold">
            Matchup
          </th>
          <th colSpan={4} className="text-center py-1 bg-pnw-cream text-pnw-forest font-semibold">
            Season
          </th>
        </tr>
        <tr className="bg-gray-50 text-gray-600 uppercase tracking-wide text-[10px]">
          <th className="text-left px-2 py-1.5 sticky left-0 z-20 bg-gray-50">Player</th>
          <th className="px-1 py-1.5">G</th>
          <th className="px-1 py-1.5">GS</th>
          <th className="px-1 py-1.5">Dec</th>
          <th className="px-1 py-1.5">IP</th>
          <th className="px-1 py-1.5">H</th>
          <th className="px-1 py-1.5">R</th>
          <th className="px-1 py-1.5">ER</th>
          <th className="px-1 py-1.5">BB</th>
          <th className="px-1 py-1.5">K</th>
          <th className="px-1 py-1.5">ERA</th>
          <th className="px-1 py-1.5">WHIP</th>
          <th className="px-1 py-1.5 border-r border-gray-300">oAVG</th>
          <th className="px-1 py-1.5 bg-pnw-cream/50">IP</th>
          <th className="px-1 py-1.5 bg-pnw-cream/50">FIP</th>
          <th className="px-1 py-1.5 bg-pnw-cream/50">K%</th>
          <th className="px-1 py-1.5 bg-pnw-cream/50">BB%</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const rowBg = i % 2 === 0 ? 'bg-white' : 'bg-gray-50'
          return (
            <tr key={r.player_id || `n${i}`} className={rowBg}>
              <td className={`text-left px-2 py-1.5 text-gray-900 font-medium whitespace-nowrap sticky left-0 z-10 ${rowBg}`}>
                {r.player_name}
              </td>
              <td className="text-center px-1 py-1.5 text-gray-700">{r.g}</td>
              <td className="text-center px-1 py-1.5 text-gray-700">{r.gs}</td>
              <td className="text-center px-1 py-1.5 text-gray-700 text-[10px]">
                {r.decision_summary || '-'}
              </td>
              <td className="text-center px-1 py-1.5 text-gray-700">{fmtIp(r.ip)}</td>
              <td className="text-center px-1 py-1.5 text-gray-700">{r.h}</td>
              <td className="text-center px-1 py-1.5 text-gray-700">{r.r}</td>
              <td className="text-center px-1 py-1.5 text-gray-700">{r.er}</td>
              <td className="text-center px-1 py-1.5 text-gray-700">{r.bb}</td>
              <td className="text-center px-1 py-1.5 text-gray-700">{r.k}</td>
              <td className="text-center px-1 py-1.5 font-semibold text-gray-900">{fmtNum(r.era, 2)}</td>
              <td className="text-center px-1 py-1.5 text-gray-700">{fmtNum(r.whip, 2)}</td>
              <td className="text-center px-1 py-1.5 text-gray-700 border-r border-gray-300">{fmtRate(r.opp_avg)}</td>
              <td className="text-center px-1 py-1.5 text-gray-700 bg-pnw-cream/30">{r.season_ip != null ? fmtIp(r.season_ip) : '-'}</td>
              <td className="text-center px-1 py-1.5 text-gray-700 bg-pnw-cream/30 font-semibold">{fmtNum(r.season_fip, 2)}</td>
              <td className="text-center px-1 py-1.5 text-gray-700 bg-pnw-cream/30">{fmtPct(r.season_k_pct)}</td>
              <td className="text-center px-1 py-1.5 text-gray-700 bg-pnw-cream/30">{fmtPct(r.season_bb_pct)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function fmtRate(v) {
  if (v === null || v === undefined) return '-'
  // Drop the leading zero: 0.417 -> .417
  const s = v.toFixed(3)
  return s.startsWith('0') ? s.slice(1) : s
}

function fmtNum(v, decimals = 2) {
  if (v === null || v === undefined) return '-'
  return v.toFixed(decimals)
}

function fmtIp(v) {
  if (v === null || v === undefined) return '-'
  // Already stored as baseball notation (6.2 = 6 2/3) — display as-is.
  return v.toFixed(1)
}
