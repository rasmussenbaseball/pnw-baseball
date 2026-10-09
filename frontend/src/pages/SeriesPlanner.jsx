/**
 * Series Planner — /portal/series-planner.
 *
 * The flagship advance-scouting page (replaces the old Advance Report). Given
 * the coach's own team and an opponent, it renders a full pre-series game plan:
 * identity, priorities, our advantages, opponent Big 3 hitters, pitcher attack
 * plan, count tendencies, dugout calls, and defensive alignments.
 *
 * Ported from intern Trevor Kazahaya's Series Planner. Data comes live from
 * /api/v1/portal/series-planner (own_team_id + opp_team_id), which runs the
 * rule logic on the daily-batch team records so any coach sees their own side.
 */

import { useState, useEffect, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { usePortalTeam } from '../context/PortalTeamContext'
import { CURRENT_SEASON } from '../lib/seasons'

const SEASON = CURRENT_SEASON

const TABS = [
  ['board', 'Series Board'],
  ['hitters', 'Hitters'],
  ['pitching', 'Pitching Plan'],
  ['states', 'Game States'],
  ['trackman', 'TrackMan'],
]

// ── formatters ──
const fmtRate = v => v == null ? '—' : Number(v).toFixed(3).replace(/^0\./, '.')
const fmtPct = v => v == null ? '—' : `${Math.round(Number(v) * 100)}%`
const fmtNum = (v, d = 2) => v == null ? '—' : Number(v).toFixed(d)

// ── shared bits ──
function Card({ children, className = '' }) {
  return <section className={`bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 ${className}`}>{children}</section>
}
function SectionTitle({ n, children, hint }) {
  return (
    <div className="flex items-baseline gap-2 mb-2.5">
      {n && <span className="text-[10px] font-bold text-portal-purple/50 dark:text-portal-accent/60 tabular-nums">{n}</span>}
      <h3 className="text-sm font-bold uppercase tracking-wide text-portal-purple-dark dark:text-gray-100">{children}</h3>
      {hint && <span className="text-[11px] text-gray-400">{hint}</span>}
    </div>
  )
}
// A 0-100 score bar (higher = stronger phase).
function ScoreBar({ score, tone = 'purple' }) {
  const pct = Math.max(0, Math.min(100, Number(score) || 0))
  const bg = tone === 'edge' ? 'bg-emerald-500' : tone === 'weak' ? 'bg-rose-400' : 'bg-portal-purple'
  return (
    <div className="h-2 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
      <div className={`h-full rounded-full ${bg}`} style={{ width: `${pct}%` }} />
    </div>
  )
}
const CONF_STYLE = {
  High: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  Medium: 'bg-amber-100 text-amber-800 border-amber-300',
  Low: 'bg-slate-100 text-slate-600 border-slate-300',
}
function ConfChip({ level }) {
  if (!level) return null
  return <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${CONF_STYLE[level] || CONF_STYLE.Low}`}>{level}</span>
}
function HandBadge({ h }) {
  if (!h) return null
  return <span className="inline-block text-[10px] font-bold px-1.5 py-0.5 rounded bg-nw-teal/10 text-nw-teal">{h}</span>
}
function TeamLogo({ team, size = 'w-10 h-10' }) {
  const initial = (team?.short_name || team?.name || '?').slice(0, 1)
  return team?.logo_url
    ? <img src={team.logo_url} alt="" className={`${size} object-contain`} onError={e => { e.target.style.display = 'none' }} />
    : <span className={`${size} rounded-full bg-portal-purple/10 text-portal-purple font-bold flex items-center justify-center`}>{initial}</span>
}

// ── TAB: Series Board ──
function BoardTab({ plan, own }) {
  const b = plan.brief
  const oppName = plan.team.short_name
  return (
    <div className="space-y-4">
      {/* Game plan headline + plan points */}
      <Card className="p-4">
        <SectionTitle n="01">Series Game Plan</SectionTitle>
        <p className="text-sm text-gray-700 dark:text-gray-200 mb-1">{b.identity_sentence}</p>
        <p className="text-sm text-amber-700 dark:text-amber-400 font-medium">{b.primary_concern}</p>
        <p className="text-sm text-emerald-700 dark:text-emerald-400 font-medium mb-3">{b.best_path}</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          {(b.plan_points || []).map((p, i) => (
            <div key={i} className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
              <div className="text-[10px] font-bold uppercase tracking-wider text-portal-purple/70 dark:text-portal-accent">{p.label}</div>
              <div className="text-2xl font-extrabold text-portal-purple-dark dark:text-gray-100 tabular-nums leading-tight">{p.number}</div>
              <div className="text-sm font-bold text-gray-800 dark:text-gray-100">{p.title}</div>
              <div className="text-[11px] text-gray-500 dark:text-gray-400 leading-snug mt-0.5">{p.detail}</div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Opponent identity + priorities */}
        <Card className="p-4">
          <SectionTitle n="02">Opponent Identity</SectionTitle>
          <div className="flex flex-wrap gap-1.5 mb-3">
            {(plan.identity || []).map((t, i) => (
              <span key={i} className="text-[11px] font-semibold px-2 py-1 rounded-full bg-portal-purple/10 text-portal-purple dark:bg-portal-purple/25 dark:text-portal-accent" title={t.detail}>
                {t.label}
              </span>
            ))}
          </div>
          <SectionTitle n="03">Series Priorities</SectionTitle>
          <ul className="space-y-1.5">
            {(b.keys || []).map((k, i) => (
              <li key={i} className="flex gap-2 items-start text-sm">
                <span className="mt-0.5 text-portal-purple font-bold">{i + 1}.</span>
                <span className="text-gray-700 dark:text-gray-200 leading-snug">{k}</span>
              </li>
            ))}
          </ul>
        </Card>

        {/* Strengths vs weaknesses */}
        <Card className="p-4">
          <SectionTitle n="04" hint={`${oppName} phase grades vs league`}>Strengths &amp; Soft Spots</SectionTitle>
          <div className="space-y-2">
            {(plan.strengths || []).slice(0, 4).map((s, i) => (
              <PhaseRow key={`s${i}`} label={s.label} detail={s.detail} score={s.score} />
            ))}
            <div className="border-t border-dashed border-gray-200 dark:border-gray-700 my-1" />
            {(plan.weaknesses || []).slice(0, 3).map((s, i) => (
              <PhaseRow key={`w${i}`} label={s.label} detail={s.detail} score={s.score} weak />
            ))}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Our advantages */}
        <Card className="p-4">
          <SectionTitle n="05" hint={`where ${own.team.short_name} is better`}>Our Advantages</SectionTitle>
          {(plan.matchup_edges || []).length === 0 || plan.matchup_edges[0]?.side === 'neutral' ? (
            <p className="text-sm text-gray-500 italic">{plan.matchup_edges?.[0]?.detail || 'No clear statistical edge in the main phases.'}</p>
          ) : (
            <div className="space-y-2.5">
              {plan.matchup_edges.map((e, i) => (
                <div key={i} className="rounded-lg bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 p-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-emerald-800 dark:text-emerald-300">{e.label}</span>
                  </div>
                  <div className="text-[11px] text-emerald-700 dark:text-emerald-400 mt-0.5">{e.detail}</div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Opportunities */}
        <Card className="p-4">
          <SectionTitle n="06">Where To Attack</SectionTitle>
          <div className="space-y-2.5">
            {(plan.opportunities || []).map((o, i) => (
              <div key={i} className="rounded-lg border border-gray-200 dark:border-gray-700 p-2.5">
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <span className="text-sm font-bold text-gray-800 dark:text-gray-100">{o.title}</span>
                  <ConfChip level={o.confidence} />
                </div>
                <div className="text-[11px] text-gray-500 dark:text-gray-400 leading-snug">{o.body}</div>
                {o.metric && <div className="text-[10px] text-portal-purple/70 dark:text-portal-accent mt-1 font-semibold uppercase tracking-wide">{o.metric}</div>}
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
function PhaseRow({ label, detail, score, weak }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className={`font-semibold ${weak ? 'text-rose-700 dark:text-rose-400' : 'text-gray-800 dark:text-gray-100'}`}>{label}</span>
        <span className="text-[11px] text-gray-400 tabular-nums">{detail}</span>
      </div>
      <ScoreBar score={score} tone={weak ? 'weak' : 'purple'} />
    </div>
  )
}

// ── TAB: Hitters ──
function StatBar({ label, value, pct, fmt }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 text-[10px] uppercase text-gray-400 font-semibold">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
        <div className="h-full bg-nw-teal rounded-full" style={{ width: `${Math.max(3, Math.min(100, pct))}%` }} />
      </div>
      <span className="w-12 text-right text-[11px] font-semibold tabular-nums text-gray-700 dark:text-gray-200">{fmt}</span>
    </div>
  )
}
function HittersTab({ plan }) {
  const hitters = plan.big_three || plan.hitter_threats || []
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      {hitters.map((h, i) => {
        const s = h.stats || {}
        return (
          <Card key={i} className="p-3.5">
            <div className="flex items-center gap-2 mb-1">
              {h.player_id
                ? <Link to={`/players/${h.player_id}`} className="font-bold text-portal-purple-dark dark:text-gray-100 hover:underline truncate">{h.name}</Link>
                : <span className="font-bold text-portal-purple-dark dark:text-gray-100 truncate">{h.name}</span>}
              <span className="text-xs text-gray-500">{h.position}</span>
              <HandBadge h={h.hand} />
            </div>
            <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-2">{h.reason}</div>
            <div className="space-y-1 mb-2.5">
              <StatBar label="OPS" value={s.ops} pct={((s.ops || 0) / 1.2) * 100} fmt={fmtRate(s.ops)} />
              <StatBar label="wRC+" value={s.wrc_plus} pct={((s.wrc_plus || 0) / 200) * 100} fmt={s.wrc_plus != null ? Math.round(s.wrc_plus) : '—'} />
              <StatBar label="ISO" value={s.iso} pct={((s.iso || 0) / 0.35) * 100} fmt={fmtRate(s.iso)} />
              <StatBar label="K%" value={s.k_pct} pct={((s.k_pct || 0) / 0.35) * 100} fmt={fmtPct(s.k_pct)} />
            </div>
            <p className="text-[12px] text-gray-700 dark:text-gray-200 leading-snug border-t border-gray-100 dark:border-gray-700 pt-2">{h.plan}</p>
          </Card>
        )
      })}
    </div>
  )
}

// ── TAB: Pitching ──
function PitchersTab({ plan }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {(plan.pitcher_attack || []).map((p, i) => {
        const s = p.stats || {}
        return (
          <Card key={i} className="p-3.5">
            <div className="flex items-center justify-between gap-2 mb-1">
              <div className="flex items-center gap-2 min-w-0">
                {p.player_id
                  ? <Link to={`/players/${p.player_id}`} className="font-bold text-portal-purple-dark dark:text-gray-100 hover:underline truncate">{p.name}</Link>
                  : <span className="font-bold text-portal-purple-dark dark:text-gray-100 truncate">{p.name}</span>}
              </div>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-portal-purple/10 text-portal-purple dark:bg-portal-purple/25 dark:text-portal-accent shrink-0">{p.role}</span>
            </div>
            <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-2">{p.reason}</div>
            <div className="grid grid-cols-4 gap-2 mb-2.5 text-center">
              {[['ERA', fmtNum(s.era)], ['WHIP', fmtNum(s.whip)], ['K%', fmtPct(s.k_pct)], ['BB%', fmtPct(s.bb_pct)]].map(([l, v]) => (
                <div key={l} className="rounded bg-gray-50 dark:bg-gray-700/40 py-1">
                  <div className="text-[9px] uppercase text-gray-400 font-bold">{l}</div>
                  <div className="text-sm font-bold tabular-nums text-gray-800 dark:text-gray-100">{v}</div>
                </div>
              ))}
            </div>
            <p className="text-[12px] text-gray-700 dark:text-gray-200 leading-snug border-t border-gray-100 dark:border-gray-700 pt-2">{p.plan}</p>
          </Card>
        )
      })}
    </div>
  )
}

// ── TAB: Game States ──
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
            <tr key={r.label} className={`text-right border-t border-gray-100 dark:border-gray-700 ${/2 Strikes/.test(r.label) ? 'font-semibold' : ''}`}>
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
function StatesTab({ plan, counts }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-4">
          <SectionTitle hint="how they hit by count">Their Bats · Count Tendencies</SectionTitle>
          <CountTable rows={counts?.offense} />
          {!counts?.offense?.length && <p className="text-sm text-gray-400 italic">Not enough play-by-play data.</p>}
        </Card>
        <Card className="p-4">
          <SectionTitle hint="how they pitch by count">Their Arms · Count Tendencies</SectionTitle>
          <CountTable rows={counts?.pitching} />
          {!counts?.pitching?.length && <p className="text-sm text-gray-400 italic">Not enough play-by-play data.</p>}
        </Card>
      </div>
      <Card className="p-4">
        <SectionTitle>Dugout Calls</SectionTitle>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
          {(plan.decisions || []).map((d, i) => (
            <div key={i} className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
              <div className="flex items-start justify-between gap-2 mb-1">
                <span className="text-sm font-bold text-gray-800 dark:text-gray-100">{d.question}</span>
                <ConfChip level={d.confidence} />
              </div>
              <div className="text-sm font-semibold text-portal-purple dark:text-portal-accent mb-0.5">{d.answer}</div>
              <div className="text-[11px] text-gray-500 dark:text-gray-400 leading-snug">{d.why}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

// ── TAB: TrackMan scouting (the coach's own game files on this opponent) ──
const TM_H_COLS = [
  ['P', 'pitches', 0], ['PA', 'pa', 0], ['Chase%', 'chase_pct', 1], ['Z-Ct%', 'zone_contact_pct', 1], ['K%', 'k_pct', 1], ['BB%', 'bb_pct', 1],
  ['EV', 'avg_ev', 1], ['HH%', 'hh_pct', 1], ['GB%', 'gb_pct', 1], ['xwOBA', 'xwoba', 3], ['RV', 'rv', 1],
]
const TM_P_COLS = [
  ['P', 'pitches', 0], ['FB', 'fb_velo', 1], ['Max', 'fb_max', 1], ['Stuff', 'stuff', 0], ['Loc+', 'loc', 0], ['Zone%', 'zone_pct', 1],
  ['Whiff%', 'whiff_pct', 1], ['Chase%', 'chase_pct', 1], ['K%', 'k_pct', 1], ['BB%', 'bb_pct', 1], ['xwOBAcon', 'xwobacon', 3], ['Tempo', 'tempo', 1],
]
const tmFmt = (v, d) => v == null ? '—' : d === 3 ? Number(v).toFixed(3).replace(/^0\./, '.') : Number(v).toFixed(d)

function TrackmanScoutTab({ oppId, oppName }) {
  const { data, loading, error } = useApi(oppId ? '/trackman/opponent' : null, { team_id: oppId }, [oppId])  // every season: opponent books accumulate
  if (loading && !data) return <Card className="p-8"><p className="text-sm text-gray-400 animate-pulse">Reading your TrackMan files…</p></Card>
  if (error) {
    return (
      <Card className="p-5">
        <SectionTitle>TrackMan scouting</SectionTitle>
        <p className="text-sm text-gray-600 dark:text-gray-300">This panel reads the game CSVs you uploaded to the <Link to="/portal/trackman" className="text-portal-purple underline">TrackMan Suite</Link>. Sign in with the account that owns those uploads to see what they say about {oppName}.</p>
      </Card>
    )
  }
  if (!data) return null
  if (!data.codes?.length) {
    return (
      <Card className="p-5">
        <SectionTitle>TrackMan scouting</SectionTitle>
        <p className="text-sm text-gray-600 dark:text-gray-300">No TrackMan sessions against {oppName} in your uploads yet. Upload the game files from a series with them in the <Link to="/portal/trackman" className="text-portal-purple underline">TrackMan Suite</Link> and this tab fills in: every hitter's chase and contact profile, hot and cold zones, and every arm's arsenal with whiff rates.</p>
      </Card>
    )
  }
  return (
    <div className="space-y-3">
      <Card className="p-4">
        <SectionTitle hint={`${data.sessions.length} tracked session${data.sessions.length === 1 ? '' : 's'} · codes ${data.codes.join(', ')}`}>What your TrackMan files say about {oppName}</SectionTitle>
        <div className="flex flex-wrap gap-1.5">
          {data.sessions.map(s => (
            <span key={s.id} className="text-[11px] rounded-full px-2.5 py-1 ring-1 ring-gray-200 dark:ring-gray-700 text-gray-500 dark:text-gray-400 tabular-nums">
              {s.date} · {s.type}{s.type !== 'intrasquad' ? ` · ${s.away} @ ${s.home}` : ''}
            </span>
          ))}
        </div>
      </Card>

      <Card className="p-4 overflow-x-auto">
        <SectionTitle hint="live sessions, 15+ pitches seen · attack notes are rule-based from the board">Their hitters ({data.hitters.length})</SectionTitle>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
              <th className="py-1 pr-2">Hitter</th>
              {TM_H_COLS.map(([l]) => <th key={l} className="py-1 px-1.5 text-right whitespace-nowrap">{l}</th>)}
              <th className="py-1 pl-2">How to attack</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
            {data.hitters.map(h => (
              <tr key={h.batter} className="align-top">
                <td className="py-1.5 pr-2 font-semibold whitespace-nowrap">{h.batter}<span className="ml-1 text-[10px] font-bold text-gray-400">{h.side || ''}</span></td>
                {TM_H_COLS.map(([l, k, d]) => <td key={l} className="py-1.5 px-1.5 text-right tabular-nums">{k === 'rv' && h[k] > 0 ? '+' : ''}{tmFmt(h[k], d)}</td>)}
                <td className="py-1.5 pl-2 text-[11.5px] text-gray-600 dark:text-gray-300 leading-snug min-w-[220px]">{(h.attack || []).join(' · ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card className="p-4 overflow-x-auto">
        <SectionTitle hint="live sessions, 15+ pitches">Their arms ({data.pitchers.length})</SectionTitle>
        <div className="space-y-3">
          {data.pitchers.map(p => {
            const t = p.totals || {}, ln = p.line || {}
            const row = { ...t, ...ln, pitches: p.pitches }
            return (
              <div key={p.pitcher} className="border-t border-gray-100 dark:border-gray-700 pt-2 first:border-0 first:pt-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="font-bold">{p.pitcher}</span>
                  <span className="text-[10px] font-bold text-gray-400">{p.throws === 'Left' ? 'LHP' : p.throws === 'Right' ? 'RHP' : ''}</span>
                  <span className="text-[11.5px] text-gray-600 dark:text-gray-300">{(p.attack || []).join(' · ')}</span>
                </div>
                <div className="grid grid-cols-6 sm:grid-cols-12 gap-x-2 gap-y-1 mt-1">
                  {TM_P_COLS.map(([l, k, d]) => (
                    <div key={l}><div className="text-[9px] uppercase tracking-wide text-gray-400">{l}</div><div className="text-[12px] font-semibold tabular-nums">{tmFmt(row[k], d)}</div></div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {p.arsenal.map(a => (
                    <span key={a.pitch_type} className="text-[10.5px] rounded-full px-2 py-0.5 bg-gray-50 dark:bg-gray-900/40 ring-1 ring-gray-200 dark:ring-gray-700 tabular-nums">
                      <b>{a.pitch_type}</b> {a.usage_pct}% · {a.velo ?? '—'} mph · {a.ivb != null ? `${a.ivb}"/${a.hb}"` : ''} · whiff {a.whiff_pct ?? '—'}% · zone {a.zone_pct ?? '—'}%{a.stuff != null ? ` · Stuff ${a.stuff}` : ''}
                    </span>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </Card>
    </div>
  )
}

// ── page ──
export default function SeriesPlanner() {
  const { team: portalTeam } = usePortalTeam()
  const [searchParams] = useSearchParams()
  const [ownId, setOwnId] = useState(null)
  // ?team_id= kept as a fallback so old Advance Report deep links still land.
  const [oppId, setOppId] = useState(Number(searchParams.get('opp_team_id') || searchParams.get('team_id')) || null)
  const [tab, setTab] = useState('board')

  const { data: teamsData } = useApi('/portal/series-planner/teams', {})
  const teams = teamsData?.teams || []

  // Seed own team from the coach's portal team once teams load.
  useEffect(() => {
    if (ownId == null && portalTeam?.id) setOwnId(portalTeam.id)
  }, [portalTeam?.id, ownId])
  // Default opponent to the first team that isn't our own.
  useEffect(() => {
    if (oppId == null && teams.length && ownId != null) {
      const first = teams.find(t => t.id !== ownId)
      if (first) setOppId(first.id)
    }
  }, [teams, ownId, oppId])

  const ready = ownId != null && oppId != null
  const { data, loading, error } = useApi(
    ready ? '/portal/series-planner' : null,
    ready ? { own_team_id: ownId, opp_team_id: oppId, season: SEASON } : {},
    [ownId, oppId],
  )

  const grouped = useMemo(() => {
    const g = {}
    for (const t of teams) {
      const k = t.conference || 'Other'
      ;(g[k] = g[k] || []).push(t)
    }
    return g
  }, [teams])

  const TeamSelect = ({ value, onChange, label }) => (
    <label className="flex items-center gap-2">
      <span className="text-xs font-semibold text-gray-500 dark:text-gray-400">{label}</span>
      <select value={value ?? ''} onChange={e => onChange(Number(e.target.value))}
        className="px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-nw-teal min-w-[200px]">
        <option value="">Pick…</option>
        {Object.keys(grouped).sort().map(conf => (
          <optgroup key={conf} label={conf}>
            {grouped[conf].map(t => <option key={t.id} value={t.id}>{t.short_name || t.name}</option>)}
          </optgroup>
        ))}
      </select>
    </label>
  )

  const plan = data?.plan
  const own = data?.own_team

  return (
    <div className="max-w-6xl mx-auto px-3 sm:px-5 py-5 space-y-4">
      {/* Controls */}
      <Card className="p-4 print:hidden">
        <div className="flex items-center gap-3 flex-wrap">
          <TeamSelect value={ownId} onChange={setOwnId} label="Our team" />
          <span className="text-gray-300 font-bold">vs</span>
          <TeamSelect value={oppId} onChange={setOppId} label="Opponent" />
          {data && !data.error && (
            <div className="ml-auto flex items-center gap-3">
              <Link to={`/portal/team-scouting?team_id=${oppId}`} className="text-sm text-nw-teal hover:underline">Full stat report →</Link>
            </div>
          )}
        </div>
        {teamsData?.generated_at && (
          <div className="text-[10px] text-gray-400 mt-2">Data generated {teamsData.generated_at}. Rule-based (no AI).</div>
        )}
      </Card>

      {error && <Card className="p-4"><p className="text-sm text-red-700">{error}</p></Card>}
      {data?.error && <Card className="p-4"><p className="text-sm text-amber-700">{data.message || 'No data available.'}</p></Card>}
      {loading && !data && <Card className="p-8"><p className="text-sm text-gray-400 animate-pulse">Building the series plan…</p></Card>}

      {plan && own && (
        <>
          {/* Matchup header */}
          <Card className="overflow-hidden">
            <div className="bg-gradient-to-r from-portal-purple to-portal-purple-light text-portal-cream px-5 py-4 flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                <TeamLogo team={own.team} />
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-portal-cream/70">Our Team</div>
                  <div className="text-lg font-extrabold leading-tight">{own.team.short_name}</div>
                  <div className="text-[11px] text-portal-cream/70">{own.team.conference} · {own.team.division}</div>
                </div>
              </div>
              <span className="text-portal-accent font-bold text-sm">VS</span>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <div className="text-[10px] uppercase tracking-widest text-portal-cream/70">Opponent</div>
                  <div className="text-lg font-extrabold leading-tight">{plan.team.short_name}</div>
                  <div className="text-[11px] text-portal-cream/70">{plan.record?.wins}-{plan.record?.losses} · {plan.team.conference}</div>
                </div>
                <TeamLogo team={plan.team} />
              </div>
            </div>
          </Card>

          {/* Tabs */}
          <div className="flex gap-1.5 flex-wrap print:hidden">
            {TABS.map(([id, label]) => (
              <button key={id} onClick={() => setTab(id)}
                className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors ${tab === id ? 'bg-portal-purple text-portal-cream' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:border-portal-purple'}`}>
                {label}
              </button>
            ))}
          </div>

          {tab === 'board' && <BoardTab plan={plan} own={own} />}
          {tab === 'hitters' && <HittersTab plan={plan} />}
          {tab === 'pitching' && <PitchersTab plan={plan} />}
          {tab === 'states' && <StatesTab plan={plan} counts={data.count_tendencies} />}
          {tab === 'trackman' && <TrackmanScoutTab oppId={oppId} oppName={plan.team.short_name} />}
        </>
      )}
    </div>
  )
}
