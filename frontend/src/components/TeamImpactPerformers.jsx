/**
 * Impact Performers card for the team Season tab (Team Profile V2). Top hitters
 * and pitchers by the blended impact score, with a returns/departs flag.
 * Data: /api/v1/teams/{id}/impact-performers?season=
 */
import { Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import DraftRiskChip from './DraftRiskChip'

const r3 = (v) => (v == null ? '-' : Number(v).toFixed(3).replace(/^0/, ''))
const r2 = (v) => (v == null ? '-' : Number(v).toFixed(2))

function RetFlag({ returning }) {
  return returning
    ? <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-300">RET</span>
    : <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-rose-50 text-rose-600 dark:bg-rose-900/30 dark:text-rose-300">OUT</span>
}

function Row({ p, line }) {
  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-gray-50 dark:border-gray-700/50 last:border-0">
      <div className="min-w-0 flex-1">
        {p.player_id
          ? <Link to={`/player/${p.player_id}`} className="text-sm font-semibold text-gray-900 dark:text-gray-100 hover:text-nw-teal hover:underline">{p.name}</Link>
          : <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{p.name}</span>}
        <span className="text-[10px] text-gray-400 ml-1.5">{p.yr} · {p.pos}</span>
        <DraftRiskChip playerId={p.player_id} className="ml-1.5" />
        <div className="text-[11px] text-gray-500 dark:text-gray-400 tabular-nums truncate">{line}</div>
      </div>
      <RetFlag returning={p.returning} />
      <span className="text-[11px] font-bold tabular-nums px-2 py-0.5 rounded bg-teal-50 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300">{Number(p.impact).toFixed(1)}</span>
    </div>
  )
}

export default function TeamImpactPerformers({ teamId, season }) {
  const { data, loading, error } = useApi(`/teams/${teamId}/impact-performers`, { season }, [teamId, season])
  if (loading || error || !data) return null
  if (!data.hitters?.length && !data.pitchers?.length) return null

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden mb-4 sm:mb-6">
      <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-900/40 flex items-center justify-between">
        <div className="text-sm font-bold text-nw-teal dark:text-gray-100 uppercase tracking-wide">Impact Performers</div>
        <div className="text-[10px] text-gray-400 uppercase tracking-wide">RET = returns · OUT = departing</div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 lg:divide-x divide-gray-100 dark:divide-gray-700">
        <div className="p-4">
          <div className="text-[11px] font-bold uppercase tracking-wider text-gray-400 mb-1.5">Hitters</div>
          {data.hitters.map((p) => (
            <Row key={p.player_id} p={p} line={`${r3(p.ops)} OPS · ${p.hr} HR · ${p.sb} SB · ${p.wrc_plus != null ? Math.round(p.wrc_plus) + ' wRC+' : ''}`} />
          ))}
        </div>
        <div className="p-4">
          <div className="text-[11px] font-bold uppercase tracking-wider text-gray-400 mb-1.5">Pitchers</div>
          {data.pitchers.map((p) => (
            <Row key={p.player_id} p={p} line={`${p.ip} IP · ${r2(p.era)} ERA · ${r2(p.fip)} FIP · ${p.k_pct}% K`} />
          ))}
        </div>
      </div>
    </div>
  )
}
