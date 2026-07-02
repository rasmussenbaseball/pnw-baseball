/**
 * Defensive Alignments — /portal/alignments.
 *
 * Per-hitter defensive positioning for an opponent, built from the fine
 * 5-infield + 5-outfield spray zones (the same granularity 6-4-3 Charts uses).
 * Each hitter shows a spray fan (interactive vs RHP / vs LHP) plus per-fielder
 * shift recommendations derived from where they actually put the ball.
 *
 * Data: /api/v1/portal/alignments?team_id=&season=
 */

import { useState, useEffect, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { usePortalTeam } from '../context/PortalTeamContext'
import { CURRENT_SEASON } from '../lib/seasons'
import SprayChart from '../components/SprayChart'

const SEASON = CURRENT_SEASON

const TONE_DOT = {
  shift: '#7c3aed',   // purple — a real shift
  shade: '#d97706',   // amber — shade
  note: '#6b7280',    // gray — note
  data: '#0d9488',    // teal — data callout
}

function Card({ children, className = '' }) {
  return <section className={`bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 ${className}`}>{children}</section>
}

// A compact pull / middle / oppo bar for the infield lanes.
function LaneBar({ pull, mid, oppo, pullSide }) {
  const seg = [
    [`${pullSide === 'left' ? 'Pull (L)' : 'Oppo (L)'}`, pull ?? 0, '#0d5c63'],
    ['Middle', mid ?? 0, '#c98a2b'],
    [`${pullSide === 'left' ? 'Oppo (R)' : 'Pull (R)'}`, oppo ?? 0, '#4a7fb5'],
  ]
  const total = seg.reduce((s, x) => s + x[1], 0) || 1
  return (
    <div>
      <div className="flex h-2.5 rounded-full overflow-hidden">
        {seg.map(([l, v, c]) => <div key={l} style={{ width: `${(v / total) * 100}%`, backgroundColor: c }} title={`${l} ${Math.round((v / total) * 100)}%`} />)}
      </div>
      <div className="flex justify-between text-[9px] text-gray-500 mt-0.5">
        {seg.map(([l, v]) => <span key={l}>{l} {Math.round((v / total) * 100)}%</span>)}
      </div>
    </div>
  )
}

function HandBadge({ h }) {
  if (!h) return null
  return <span className="inline-block text-[10px] font-bold px-1.5 py-0.5 rounded bg-nw-teal/10 text-nw-teal">{h}</span>
}

const SHIFT_STYLE = shift => {
  const l = (shift?.label || '').toLowerCase()
  if (l.startsWith('full shift')) return 'bg-rose-100 text-rose-800 border-rose-300'
  if (l.startsWith('shade')) return 'bg-amber-100 text-amber-800 border-amber-300'
  return 'bg-slate-100 text-slate-600 border-slate-300'
}

function HitterCard({ h }) {
  const lanes = h.lanes || {}
  const shift = h.shift || {}
  return (
    <Card className="p-3.5">
      <div className="flex items-center gap-2 mb-2">
        {h.player_id
          ? <Link to={`/players/${h.player_id}`} className="font-bold text-portal-purple-dark dark:text-gray-100 hover:underline truncate">{h.name}</Link>
          : <span className="font-bold text-portal-purple-dark dark:text-gray-100 truncate">{h.name}</span>}
        <span className="text-xs text-gray-500">{h.position}</span>
        <HandBadge h={h.bats} />
        <span className="ml-auto text-[10px] text-gray-400">{h.bip} BIP · {h.pa} PA</span>
      </div>

      {/* Shift call */}
      {shift.label && (
        <div className="mb-1.5">
          <span className={`text-xs font-bold px-2 py-0.5 rounded border ${SHIFT_STYLE(shift)}`}>{shift.label}</span>
        </div>
      )}

      {/* Field + fielder dots (amber = where to play) over the spray density */}
      <SprayChart data={h.spray_chart} bats={h.bats} fielders={h.fielders} />
      <div className="text-[10px] text-gray-400 mt-0.5 mb-1 text-center">
        <span className="inline-block w-2 h-2 rounded-full bg-amber-500 align-middle mr-1" />
        amber = ideal fielder spot · shading = where balls go
      </div>

      {/* Fielder move notes */}
      {(shift.moves || []).length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {shift.moves.map((m, i) => (
            <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200">
              <b>{m.pos}</b> {m.note}
            </span>
          ))}
        </div>
      )}

      {/* Infield lane summary */}
      <div className="mb-2">
        <div className="text-[10px] uppercase font-semibold text-gray-400 mb-0.5">Ground-ball lanes</div>
        <LaneBar pull={lanes.if_pull} mid={lanes.if_mid} oppo={lanes.if_oppo} pullSide={lanes.pull_side} />
      </div>

      {/* Recommendations */}
      <ul className="space-y-1 border-t border-gray-100 dark:border-gray-700 pt-2">
        {(h.recommendations || []).map((r, i) => (
          <li key={i} className="flex items-start gap-1.5">
            <span className="mt-[3px] w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: TONE_DOT[r.tone] || TONE_DOT.note }} />
            <span className="text-[12px] text-gray-700 dark:text-gray-200 leading-snug">{r.text}</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

export default function Alignments() {
  const { team: portalTeam } = usePortalTeam()
  const [searchParams] = useSearchParams()
  const [teamId, setTeamId] = useState(Number(searchParams.get('team_id')) || null)

  const { data: teamsData } = useApi('/portal/series-planner/teams', {})
  const teams = teamsData?.teams || []

  // Default the opponent to the coach's portal team (they'll usually switch).
  useEffect(() => {
    if (teamId == null && portalTeam?.id) setTeamId(portalTeam.id)
  }, [portalTeam?.id, teamId])

  const { data, loading, error } = useApi(
    teamId ? '/portal/alignments' : null,
    teamId ? { team_id: teamId, season: SEASON } : {},
    [teamId],
  )

  const grouped = useMemo(() => {
    const g = {}
    for (const t of teams) (g[t.conference || 'Other'] = g[t.conference || 'Other'] || []).push(t)
    return g
  }, [teams])

  return (
    <div className="max-w-6xl mx-auto px-3 sm:px-5 py-5 space-y-4">
      <Card className="p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <div>
            <h1 className="text-lg font-bold text-portal-purple-dark dark:text-gray-100">Defensive Alignments</h1>
            <p className="text-xs text-gray-500 dark:text-gray-400">Where each hitter puts the ball — 5 infield + 5 outfield lanes — with shift calls.</p>
          </div>
          <select value={teamId ?? ''} onChange={e => setTeamId(Number(e.target.value))}
            className="ml-auto px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-nw-teal min-w-[220px]">
            <option value="">Pick an opponent…</option>
            {Object.keys(grouped).sort().map(conf => (
              <optgroup key={conf} label={conf}>
                {grouped[conf].map(t => <option key={t.id} value={t.id}>{t.short_name || t.name}</option>)}
              </optgroup>
            ))}
          </select>
          {teamId && (
            <Link to={`/portal/alignments/cards?team_id=${teamId}`}
              className="px-3 py-2 rounded-lg bg-portal-purple text-portal-cream text-sm font-semibold hover:bg-portal-purple-dark whitespace-nowrap">
              Pocket cards →
            </Link>
          )}
        </div>
        {teamsData?.generated_at && (
          <div className="text-[10px] text-gray-400 mt-2">Data generated {teamsData.generated_at}. Grounder / air-ball lanes from play-by-play.</div>
        )}
      </Card>

      {error && <Card className="p-4"><p className="text-sm text-red-700">{error}</p></Card>}
      {data?.error && <Card className="p-4"><p className="text-sm text-amber-700">{data.message}</p></Card>}
      {loading && !data && <Card className="p-8"><p className="text-sm text-gray-400 animate-pulse">Building alignments…</p></Card>}

      {data?.hitters && (
        <>
          <div className="text-sm font-semibold text-gray-600 dark:text-gray-300">
            {data.team?.short_name}: {data.hitters.length} hitters with enough batted-ball data
          </div>
          {data.hitters.length === 0 ? (
            <Card className="p-6"><p className="text-sm text-gray-500 italic">Not enough classified batted balls for this team yet.</p></Card>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {data.hitters.map(h => <HitterCard key={h.player_id} h={h} />)}
            </div>
          )}
          <p className="text-[11px] text-gray-400 italic">
            Lanes come from box-score play-by-play (fielder + hit location). Gap and depth reads are limited by how precisely
            each game was scored, so treat thin samples as directional.
          </p>
        </>
      )}
    </div>
  )
}
