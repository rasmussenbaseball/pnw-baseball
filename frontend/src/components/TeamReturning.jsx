/**
 * Returning Production tab (Team Profile V2). Player-level roster carryover:
 * best bat / top arm back, biggest production loss, impact returning hitters &
 * pitchers (blended impact score, not WAR-only), and production to replace.
 * Returning status = class year + the player_returning_overrides table.
 * Data: /api/v1/teams/{id}/returning?season=
 */
import { Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'

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
          <div className="mt-1 text-lg leading-tight"><PlayerName p={p} /></div>
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

function ImpactBadge({ v }) {
  return <span className="text-[11px] font-bold tabular-nums px-2 py-0.5 rounded bg-teal-50 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300">{Number(v).toFixed(1)}</span>
}

function HitterRow({ p }) {
  return (
    <div className="flex items-center gap-2 py-2 border-b border-gray-50 dark:border-gray-700/50 last:border-0">
      <div className="min-w-0 flex-1">
        <PlayerName p={p} />
        <span className="text-[11px] text-gray-400 ml-1.5">{p.yr} · {p.pos}</span>
      </div>
      <div className="hidden sm:flex items-center gap-3 text-xs text-gray-600 dark:text-gray-300 tabular-nums">
        <span title="OPS" className="w-12 text-right">{r3(p.ops)}</span>
        <span title="wRC+" className="w-9 text-right">{p.wrc_plus != null ? Math.round(p.wrc_plus) : '-'}</span>
        <span title="HR" className="w-7 text-right">{p.hr} HR</span>
        <span title="SB" className="w-9 text-right">{p.sb} SB</span>
      </div>
      <ImpactBadge v={p.impact} />
    </div>
  )
}

function PitcherRow({ p }) {
  return (
    <div className="flex items-center gap-2 py-2 border-b border-gray-50 dark:border-gray-700/50 last:border-0">
      <div className="min-w-0 flex-1">
        <PlayerName p={p} />
        <span className="text-[11px] text-gray-400 ml-1.5">{p.yr}</span>
      </div>
      <div className="hidden sm:flex items-center gap-3 text-xs text-gray-600 dark:text-gray-300 tabular-nums">
        <span title="IP" className="w-12 text-right">{p.ip} IP</span>
        <span title="ERA" className="w-12 text-right">{r2(p.era)} ERA</span>
        <span title="FIP" className="w-12 text-right">{r2(p.fip)} FIP</span>
        <span title="K%" className="w-12 text-right">{p.k_pct}% K</span>
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
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        <Card title="Impact Returning Hitters">
          {data.returning_hitters?.length
            ? data.returning_hitters.map((p) => <HitterRow key={p.player_id} p={p} />)
            : <div className="text-sm text-gray-400">No qualifying returning hitters.</div>}
        </Card>
        <Card title="Impact Returning Pitchers">
          {data.returning_pitchers?.length
            ? data.returning_pitchers.map((p) => <PitcherRow key={p.player_id} p={p} />)
            : <div className="text-sm text-gray-400">No qualifying returning pitchers.</div>}
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
                <span className="hidden sm:inline text-xs text-gray-500 tabular-nums w-28 text-right">
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
