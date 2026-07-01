/**
 * Advance Report — /portal/advance-report.
 *
 * The coach-facing, printable series-prep sheet. Reuses the Team Scouting data
 * payload but leads with the auto-generated game plan + per-key-player attack
 * bullets (the piece 6-4-3 Charts makes coaches write by hand).
 *
 * Data: /api/v1/portal/advance-report?team_id=X&season=Y
 */

import { useState, useEffect, useMemo, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { usePortalTeam } from '../context/PortalTeamContext'
import { CURRENT_SEASON } from '../lib/seasons'
import ReportActions from '../components/ReportActions'

const SEASON = CURRENT_SEASON

// ── threat badge colors (scouting POV: a hot bat is a red flag) ──
const THREAT_STYLE = {
  'Elite bat':          'bg-rose-100 text-rose-800 border border-rose-300',
  'Above-average bat':  'bg-amber-100 text-amber-800 border border-amber-300',
  'Average bat':        'bg-slate-100 text-slate-700 border border-slate-300',
  'Below-average bat':  'bg-emerald-100 text-emerald-800 border border-emerald-300',
  'unrated':            'bg-slate-100 text-slate-500 border border-slate-200',
}

function handBadge(h) {
  if (!h) return null
  return (
    <span className="inline-block text-[10px] font-bold px-1.5 py-0.5 rounded bg-nw-teal/10 text-nw-teal">
      {h}
    </span>
  )
}

// A single game-plan bullet: green dot for "Exploit", amber for "Respect".
function PlanBullet({ text }) {
  const isExploit = /^exploit/i.test(text)
  return (
    <li className="flex gap-2 items-start text-sm leading-snug">
      <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${isExploit ? 'bg-emerald-500' : 'bg-amber-500'}`} />
      <span className="text-gray-700 dark:text-gray-200">{text}</span>
    </li>
  )
}

// ── count-state tendency table ───────────────────────────────────
const fmtRate = (v) => v == null ? '—' : Number(v).toFixed(3).replace(/^0/, '')
const fmtPct = (v) => v == null ? '—' : `${Math.round(v * 100)}%`

function CountTable({ title, rows }) {
  if (!rows || !rows.length) return null
  return (
    <div>
      <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1.5">{title}</div>
      <table className="w-full text-sm tabular-nums">
        <thead>
          <tr className="text-[11px] uppercase text-gray-400 text-right">
            <th className="text-left font-medium py-1">Count</th>
            <th className="font-medium">PA</th><th className="font-medium">AVG</th>
            <th className="font-medium">OPS</th><th className="font-medium">K%</th><th className="font-medium">BB%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.label}
                className={`text-right border-t border-gray-100 dark:border-gray-700 ${r.label === '2 Strikes' ? 'font-semibold' : ''}`}>
              <td className="text-left py-1 text-gray-700 dark:text-gray-200">{r.label}</td>
              <td className="text-gray-400">{r.pa}</td>
              <td>{fmtRate(r.avg)}</td>
              <td>{fmtRate(r.ops)}</td>
              <td>{fmtPct(r.k_pct)}</td>
              <td>{fmtPct(r.bb_pct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Card({ children, className = '' }) {
  return (
    <section className={`bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 ${className}`}>
      {children}
    </section>
  )
}

// ── player cards ─────────────────────────────────────────────────

function HitterCard({ h }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 break-inside-avoid">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          {h.player_id
            ? <Link to={`/players/${h.player_id}`} className="font-semibold text-portal-purple-dark dark:text-gray-100 hover:underline truncate">{h.name}</Link>
            : <span className="font-semibold text-portal-purple-dark dark:text-gray-100 truncate">{h.name}</span>}
          <span className="text-xs text-gray-500 shrink-0">{h.position}</span>
          {handBadge(h.bats)}
        </div>
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${THREAT_STYLE[h.threat] || THREAT_STYLE.unrated}`}>
          {h.threat}
        </span>
      </div>
      <div className="text-xs text-gray-500 dark:text-gray-400 mb-2 font-mono">
        {h.line}{h.wrc_plus != null ? ` · ${h.wrc_plus} wRC+` : ''}{h.pa != null ? ` · ${h.pa} PA` : ''}
      </div>
      <ul className="space-y-1">
        {h.attack.map((b, i) => (
          <li key={i} className="flex gap-2 items-start text-sm leading-snug">
            <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-nw-teal shrink-0" />
            <span className="text-gray-700 dark:text-gray-200">{b}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function PitcherCard({ p }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 break-inside-avoid">
      <div className="flex items-center gap-2 mb-1.5">
        {p.player_id
          ? <Link to={`/players/${p.player_id}`} className="font-semibold text-portal-purple-dark dark:text-gray-100 hover:underline truncate">{p.name}</Link>
          : <span className="font-semibold text-portal-purple-dark dark:text-gray-100 truncate">{p.name}</span>}
        {handBadge(p.throws)}
      </div>
      <div className="text-xs text-gray-500 dark:text-gray-400 mb-2 font-mono">
        {p.line}{p.ip != null ? ` · ${p.ip} IP` : ''}
      </div>
      <ul className="space-y-1">
        {p.approach.map((b, i) => (
          <li key={i} className="flex gap-2 items-start text-sm leading-snug">
            <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-nw-teal shrink-0" />
            <span className="text-gray-700 dark:text-gray-200">{b}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── page ─────────────────────────────────────────────────────────

export default function AdvanceReport() {
  const { team: portalTeam } = usePortalTeam()
  const [searchParams] = useSearchParams()
  const urlTeamId = Number(searchParams.get('team_id')) || null
  const [selectedId, setSelectedId] = useState(urlTeamId)
  const { data: teams } = useApi('/teams', {})

  useEffect(() => {
    // Seed from ?team_id=, else fall back to the coach's own portal team.
    if (selectedId == null && portalTeam?.id) setSelectedId(portalTeam.id)
  }, [portalTeam?.id, selectedId])

  const { data, loading, error } = useApi(
    '/portal/advance-report',
    selectedId ? { team_id: selectedId, season: SEASON } : {},
    [selectedId],
  )

  const teamOptions = useMemo(() => {
    if (!teams) return []
    return [...teams]
      .filter(t => t.is_active)
      .sort((a, b) => (a.short_name || a.name).localeCompare(b.short_name || b.name))
  }, [teams])

  const n = data?.advance_narrative
  const reportRef = useRef(null)

  return (
    <div className="max-w-6xl mx-auto px-3 sm:px-5 py-5 space-y-4">
      {/* Controls (hidden on print) */}
      <Card className="p-4 print:hidden">
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-sm font-semibold text-portal-purple-dark dark:text-gray-100">Advance scout:</label>
          <select
            value={selectedId ?? ''}
            onChange={(e) => setSelectedId(Number(e.target.value))}
            className="px-3 py-2 rounded-lg border border-gray-300 text-sm
                       focus:outline-none focus:ring-2 focus:ring-nw-teal min-w-[260px]"
          >
            <option value="">Pick an opponent...</option>
            {teamOptions.map(t => (
              <option key={t.id} value={t.id}>
                {t.short_name || t.name}{t.conference_abbrev ? ` (${t.conference_abbrev})` : ''}
              </option>
            ))}
          </select>
          {data && !data.error && (
            <div className="ml-auto flex items-center gap-3">
              <Link to={`/portal/team-scouting?team_id=${selectedId}`}
                    className="text-sm text-nw-teal hover:underline">Full stat report →</Link>
              <ReportActions targetRef={reportRef}
                filename={`advance_${(data.team.short_name || data.team.name || 'team').replace(/\s+/g, '_')}_${data.season}`} />
            </div>
          )}
        </div>
      </Card>

      {error && (
        <Card className="p-4"><p className="text-sm text-red-700">{error}</p></Card>
      )}
      {loading && !data && (
        <Card className="p-4"><p className="text-sm text-gray-500 italic">Building advance report...</p></Card>
      )}

      {data && !data.error && n && (
        <div ref={reportRef} className="space-y-4 bg-white dark:bg-gray-900 p-1">
          {/* Header */}
          <section className="bg-portal-purple text-portal-cream rounded-xl px-5 py-4 shadow">
            <div className="flex items-center gap-4 flex-wrap">
              {data.team.logo_url && (
                <img src={data.team.logo_url} alt="" className="w-14 h-14 object-contain bg-white rounded-md p-1" />
              )}
              <div className="flex-1 min-w-[200px]">
                <div className="text-[11px] uppercase tracking-wider opacity-80">Advance Report · {data.season}</div>
                <h1 className="text-2xl font-semibold tracking-tight">{data.team.name}</h1>
                <p className="text-sm opacity-90">
                  {data.team.conference_name} ({data.team.division_level})
                </p>
              </div>
              <div className="grid grid-cols-3 gap-4 text-center">
                <div><div className="text-lg font-bold">{data.team.wins ?? 0}-{data.team.losses ?? 0}</div><div className="text-[11px] opacity-80">Overall</div></div>
                <div><div className="text-lg font-bold">{data.team.conference_wins ?? 0}-{data.team.conference_losses ?? 0}</div><div className="text-[11px] opacity-80">Conf</div></div>
                <div><div className="text-lg font-bold">{data.recent?.record || '—'}</div><div className="text-[11px] opacity-80">Last 10</div></div>
              </div>
            </div>
          </section>

          {/* Game plan */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card className="p-4 break-inside-avoid">
              <h2 className="text-sm font-bold uppercase tracking-wide text-portal-purple-dark dark:text-gray-100 mb-3">
                When you're pitching to them
              </h2>
              {n.game_plan.when_pitching.length
                ? <ul className="space-y-2">{n.game_plan.when_pitching.map((b, i) => <PlanBullet key={i} text={b} />)}</ul>
                : <p className="text-sm text-gray-400 italic">No stand-out team tendencies.</p>}
            </Card>
            <Card className="p-4 break-inside-avoid">
              <h2 className="text-sm font-bold uppercase tracking-wide text-portal-purple-dark dark:text-gray-100 mb-3">
                When you're hitting off them
              </h2>
              {n.game_plan.when_hitting.length
                ? <ul className="space-y-2">{n.game_plan.when_hitting.map((b, i) => <PlanBullet key={i} text={b} />)}</ul>
                : <p className="text-sm text-gray-400 italic">No stand-out staff tendencies.</p>}
            </Card>
          </div>

          {/* Count tendencies */}
          {(n.count_tendencies?.offense?.length > 0 || n.count_tendencies?.pitching?.length > 0) && (
            <Card className="p-4 break-inside-avoid">
              <h2 className="text-sm font-bold uppercase tracking-wide text-portal-purple-dark dark:text-gray-100 mb-3">
                Count tendencies <span className="text-gray-400 font-normal normal-case">· work the count in your favor</span>
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <CountTable title="Their hitters, by count" rows={n.count_tendencies.offense} />
                <CountTable title="Their pitchers allow, by count" rows={n.count_tendencies.pitching} />
              </div>
            </Card>
          )}

          {/* Key hitters */}
          <Card className="p-4">
            <h2 className="text-sm font-bold uppercase tracking-wide text-portal-purple-dark dark:text-gray-100 mb-3">
              Key hitters <span className="text-gray-400 font-normal normal-case">· how to get them out</span>
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {n.key_hitters.map(h => <HitterCard key={h.player_id || h.name} h={h} />)}
            </div>
          </Card>

          {/* Pitchers */}
          {n.starters.length > 0 && (
            <Card className="p-4">
              <h2 className="text-sm font-bold uppercase tracking-wide text-portal-purple-dark dark:text-gray-100 mb-3">
                Starters <span className="text-gray-400 font-normal normal-case">· how to hit them</span>
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {n.starters.map(p => <PitcherCard key={p.player_id || p.name} p={p} />)}
              </div>
            </Card>
          )}
          {n.relievers.length > 0 && (
            <Card className="p-4">
              <h2 className="text-sm font-bold uppercase tracking-wide text-portal-purple-dark dark:text-gray-100 mb-3">
                Bullpen <span className="text-gray-400 font-normal normal-case">· how to hit them</span>
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {n.relievers.map(p => <PitcherCard key={p.player_id || p.name} p={p} />)}
              </div>
            </Card>
          )}

          <p className="text-[11px] text-gray-400 px-1">
            Auto-generated from box score and play-by-play data. Tendencies, discipline, splits and batted-ball
            profiles only (no radar velocity or pitch types). Cross-check with video before game day.
          </p>
        </div>
      )}
    </div>
  )
}
