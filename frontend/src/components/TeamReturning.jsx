/**
 * Returning Production tab (Team Profile V2). Player-level roster carryover:
 * best bat / top arm back, biggest production loss, impact returning hitters &
 * pitchers (blended impact score, not WAR-only), and production to replace.
 * Returning status = class year + the player_returning_overrides table.
 * Data: /api/v1/teams/{id}/returning?season=
 */
import { Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import DraftRiskChip from './DraftRiskChip'

const r3 = (v) => (v == null ? '-' : Number(v).toFixed(3).replace(/^0/, ''))
const r2 = (v) => (v == null ? '-' : Number(v).toFixed(2))

function Card({ title, children, accent }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden mb-4 sm:mb-6">
      {title && (
        <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-900/40">
          <div className={`text-sm font-bold uppercase tracking-wide ${accent || 'text-nw-teal dark:text-gray-100'}`}>{title}</div>
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  )
}

function PlayerName({ p }) {
  if (p.player_id) {
    return <Link to={`/player/${p.player_id}`} className="font-semibold text-gray-900 dark:text-gray-100 hover:text-nw-teal hover:underline">{p.name}</Link>
  }
  return <span className="font-semibold text-gray-900 dark:text-gray-100">{p.name}</span>
}

function HeadlineCard({ label, p, line, tone }) {
  const ring = tone === 'loss'
    ? 'border-rose-200 dark:border-rose-800' : 'border-emerald-200 dark:border-emerald-800'
  return (
    <div className={`rounded-xl border ${ring} bg-white dark:bg-gray-800 p-4 shadow-sm`}>
      <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 dark:text-gray-500">{label}</div>
      {p ? (
        <>
          <div className="mt-1 text-lg leading-tight flex items-center gap-2 flex-wrap"><PlayerName p={p} /><DraftRiskChip playerId={p.player_id} /></div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{p.yr} · {p.pos}{tone === 'loss' && p.status ? ` · ${p.status}` : ''}</div>
          <div className="text-sm text-gray-700 dark:text-gray-300 mt-1.5">{line}</div>
        </>
      ) : <div className="mt-2 text-sm text-gray-400">—</div>}
    </div>
  )
}

function RetBar({ label, pct }) {
  const v = Math.max(0, Math.min(100, pct ?? 0))
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">{label}</span>
        <span className="text-sm font-bold text-gray-800 dark:text-gray-100 tabular-nums">{v.toFixed(0)}%</span>
      </div>
      <div className="h-2 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
        <div className="h-full rounded-full bg-nw-teal-light" style={{ width: `${v}%` }} />
      </div>
    </div>
  )
}

function BalanceBar({ label, ret, dep }) {
  const tot = (ret || 0) + (dep || 0) || 1
  const rp = (ret / tot) * 100
  return (
    <div>
      <div className="flex justify-between text-[11px] mb-1">
        <span className="font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">{label}</span>
        <span className="text-gray-400 tabular-nums">{Math.round(rp)}% back</span>
      </div>
      <div className="h-2.5 rounded-full overflow-hidden flex bg-gray-100 dark:bg-gray-700">
        <div className="h-full bg-nw-teal-light" style={{ width: `${rp}%` }} title={`${Math.round(ret)} returning`} />
        <div className="h-full bg-rose-300 dark:bg-rose-800/70" style={{ width: `${100 - rp}%` }} title={`${Math.round(dep)} departing`} />
      </div>
    </div>
  )
}

function ImpactBadge({ v }) {
  return <span className="text-[11px] font-bold tabular-nums w-11 shrink-0 text-center py-0.5 rounded bg-teal-50 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300">{Number(v).toFixed(1)}</span>
}

// Column header that lines up with HitterRow / PitcherRow (incl. the Impact badge).
function StatHeader({ cols }) {
  return (
    <div className="hidden sm:flex items-center gap-2 pb-1.5 mb-1 border-b border-gray-100 dark:border-gray-700 text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wide">
      <span className="flex-1">Player</span>
      <div className="flex items-center gap-2.5 shrink-0">
        {cols.map((c) => <span key={c.label} className={`${c.w} text-right`}>{c.label}</span>)}
      </div>
      <span className="w-11 text-center" title="Blended impact score (playing time + production). Higher = a bigger piece returning.">Impact</span>
    </div>
  )
}

function ImpactNote() {
  return (
    <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-3 leading-snug">
      <span className="font-semibold">Impact</span> blends playing time and production (oWAR, OPS, wRC+, discipline, speed for bats; IP, pWAR, FIP/SIERA, K-BB for arms). Higher = a bigger piece coming back.
    </p>
  )
}

function HitterRow({ p }) {
  return (
    <div className="flex items-start gap-2 py-2.5 border-b border-gray-50 dark:border-gray-700/50 last:border-0">
      <div className="min-w-0 flex-1">
        <div><PlayerName p={p} /><span className="text-[11px] text-gray-400 ml-1.5">{p.yr} · {p.pos}</span><DraftRiskChip playerId={p.player_id} className="ml-1.5" /></div>
        {p.note && <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 leading-snug">{p.note}</div>}
      </div>
      <div className="hidden sm:flex items-center gap-2.5 text-[11px] text-gray-600 dark:text-gray-300 tabular-nums pt-0.5 shrink-0">
        <span title="OPS" className="w-11 text-right whitespace-nowrap">{r3(p.ops)}</span>
        <span title="wRC+" className="w-8 text-right whitespace-nowrap">{p.wrc_plus != null ? Math.round(p.wrc_plus) : '-'}</span>
        <span title="HR" className="w-12 text-right whitespace-nowrap">{p.hr} HR</span>
        <span title="SB" className="w-11 text-right whitespace-nowrap">{p.sb} SB</span>
      </div>
      <ImpactBadge v={p.impact} />
    </div>
  )
}

function PitcherRow({ p }) {
  return (
    <div className="flex items-start gap-2 py-2.5 border-b border-gray-50 dark:border-gray-700/50 last:border-0">
      <div className="min-w-0 flex-1">
        <div><PlayerName p={p} /><span className="text-[11px] text-gray-400 ml-1.5">{p.yr}</span><DraftRiskChip playerId={p.player_id} className="ml-1.5" /></div>
        {p.note && <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 leading-snug">{p.note}</div>}
      </div>
      <div className="hidden sm:flex items-center gap-2.5 text-[11px] text-gray-600 dark:text-gray-300 tabular-nums pt-0.5 shrink-0">
        <span title="IP" className="w-14 text-right whitespace-nowrap">{p.ip} IP</span>
        <span title="ERA" className="w-16 text-right whitespace-nowrap">{r2(p.era)} ERA</span>
        <span title="FIP" className="w-16 text-right whitespace-nowrap">{r2(p.fip)} FIP</span>
        <span title="K%" className="w-14 text-right whitespace-nowrap">{p.k_pct}% K</span>
      </div>
      <ImpactBadge v={p.impact} />
    </div>
  )
}

export default function TeamReturning({ teamId, season }) {
  const { data, loading, error } = useApi(`/teams/${teamId}/returning`, { season }, [teamId, season])

  if (loading) return <div className="py-10 text-center text-sm text-gray-400 animate-pulse">Reading the roster…</div>
  if (error || !data || data.error) return <div className="py-10 text-center text-sm text-gray-400">Returning production is unavailable for this season.</div>

  const bb = data.best_bat, ta = data.top_arm, bl = data.biggest_loss

  return (
    <div>
      {/* Headline cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 mb-4 sm:mb-6">
        <HeadlineCard label="Best Bat Back" p={bb} tone="back"
          line={bb && `${r3(bb.ops)} OPS · ${bb.hr} HR · ${bb.sb} SB`} />
        <HeadlineCard label="Top Arm Back" p={ta} tone="back"
          line={ta && `${ta.ip} IP · ${r2(ta.era)} ERA · ${ta.k_pct}% K`} />
        <HeadlineCard label="Biggest Production Loss" p={bl} tone="loss"
          line={bl && (bl.kind === 'pit' ? `${bl.ip} IP · ${r2(bl.era)} ERA` : `${r3(bl.ops)} OPS · ${bl.hr} HR`)} />
      </div>

      {/* Returning % read */}
      <Card title="Roster Carryover">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <RetBar label="Plate Apps" pct={data.returning?.ret_pa_pct} />
          <RetBar label="Innings" pct={data.returning?.ret_ip_pct} />
          <RetBar label="oWAR" pct={data.returning?.ret_owar_pct} />
          <RetBar label="pWAR" pct={data.returning?.ret_pwar_pct} />
        </div>
        {data.roster_read && <p className="text-xs text-gray-500 dark:text-gray-400 mt-3">{data.roster_read}</p>}
      </Card>

      {/* Roster balance chart + priorities */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        {data.balance && (
          <Card title="Roster Balance">
            <div className="space-y-3">
              {data.balance.hitters?.map((b) => <BalanceBar key={b.group} label={b.label} ret={b.ret_pa} dep={b.dep_pa} />)}
              <BalanceBar label="Pitching (IP)" ret={data.balance.pitching?.ret_ip} dep={data.balance.pitching?.dep_ip} />
            </div>
            <div className="flex gap-4 mt-3 text-[10px] text-gray-400">
              <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-nw-teal-light" />Returning</span>
              <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-rose-300 dark:bg-rose-800/70" />Departing</span>
            </div>
          </Card>
        )}
        {data.priorities?.length > 0 && (
          <Card title="Roster Priorities">
            <ul className="space-y-2">
              {data.priorities.map((p, i) => (
                <li key={i} className="flex gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <span className="text-rose-500 font-bold shrink-0">!</span><span>{p}</span></li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        <Card title="Impact Returning Hitters">
          {data.returning_hitters?.length ? (
            <>
              <StatHeader cols={[{ label: 'OPS', w: 'w-11' }, { label: 'wRC+', w: 'w-8' }, { label: 'HR', w: 'w-12' }, { label: 'SB', w: 'w-11' }]} />
              {data.returning_hitters.map((p) => <HitterRow key={p.player_id} p={p} />)}
              <ImpactNote />
            </>
          ) : <div className="text-sm text-gray-400">No qualifying returning hitters.</div>}
        </Card>
        <Card title="Impact Returning Pitchers">
          {data.returning_pitchers?.length ? (
            <>
              <StatHeader cols={[{ label: 'IP', w: 'w-14' }, { label: 'ERA', w: 'w-16' }, { label: 'FIP', w: 'w-16' }, { label: 'K%', w: 'w-14' }]} />
              {data.returning_pitchers.map((p) => <PitcherRow key={p.player_id} p={p} />)}
              <ImpactNote />
            </>
          ) : <div className="text-sm text-gray-400">No qualifying returning pitchers.</div>}
        </Card>
      </div>

      {/* Production to replace */}
      <Card title="Production to Replace" accent="text-rose-600 dark:text-rose-400">
        {data.departures?.length ? (
          <div className="divide-y divide-gray-50 dark:divide-gray-700/50">
            {data.departures.map((p) => (
              <div key={p.player_id} className="flex items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <PlayerName p={p} />
                  <span className="text-[11px] text-gray-400 ml-1.5">{p.yr} · {p.pos}</span>
                </div>
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300">{p.status}</span>
                <span className="hidden sm:inline text-[11px] text-gray-500 tabular-nums w-36 text-right whitespace-nowrap shrink-0">
                  {p.kind === 'pit' ? `${p.ip} IP · ${r2(p.era)} ERA` : `${p.pa} PA · ${r3(p.ops)} OPS`}
                </span>
                <ImpactBadge v={p.impact} />
              </div>
            ))}
          </div>
        ) : <div className="text-sm text-gray-400">No notable departures detected.</div>}
        <p className="text-[11px] text-gray-400 mt-3">Returning status is based on class year, transfer-portal membership, and manual overrides.</p>
      </Card>
    </div>
  )
}
