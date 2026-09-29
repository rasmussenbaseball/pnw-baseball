// 2027 projection card for the player profile pages, placed under the PBP data.
//
// Everyone sees the full projected line, the 10th-90th percentile range of
// outcomes, and a short scouting writeup of WHY the model lands where it does.
// Players the model can't project (too few stats) show "no projection available".
//
// Powered by the "College Marcel" projection model.

import { useApi } from '../hooks/useApi'
import { usePlayerProfileTheme, pctColor } from './playerProfile/shared'

// ── formatters ──
const f3 = (v) => v == null ? '—' : (v >= 1 ? Number(v).toFixed(3) : Number(v).toFixed(3).replace(/^0/, ''))
const fPct = (v) => v == null ? '—' : `${(v * 100).toFixed(1)}%`
const f2 = (v) => v == null ? '—' : Number(v).toFixed(2)
const f1 = (v) => v == null ? '—' : Number(v).toFixed(1)
const fInt = (v) => v == null ? '—' : Math.round(v).toString()

const CONF_COLOR = { High: '#16a34a', Med: '#ca8a04', Low: '#dc2626' }

function Pill({ children, color, T }) {
  return (
    <span className="text-[9.5px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
      style={{ background: (color || T.textLight) + '22', color: color || T.textLight }}>
      {children}
    </span>
  )
}

function StatTile({ label, value, T }) {
  return (
    <div className="text-center rounded px-1.5 py-1.5" style={{ background: T.bg || 'transparent', border: `1px solid ${T.border}` }}>
      <div className="text-[8.5px] font-bold uppercase tracking-wide" style={{ color: T.textLight }}>{label}</div>
      <div className="text-[13px] font-extrabold tabular-nums" style={{ color: T.text }}>{value}</div>
    </div>
  )
}

function HeaderBar({ T, season, proj }) {
  return (
    <h2 className="font-bold text-[15px] mb-3 pb-1.5 border-b-2 flex items-center gap-2 flex-wrap" style={{ color: T.text, borderColor: T.text }}>
      <span>{season} Projection</span>
      {proj?.class && <Pill T={T}>{proj.class}{proj.level ? ` · ${proj.level}` : ''}</Pill>}
      {proj?.confidence && <Pill T={T} color={CONF_COLOR[proj.confidence]}>{proj.confidence} confidence</Pill>}
      {proj?.breakout && <Pill T={T} color="#7c3aed">★ Breakout</Pill>}
      <span className="ml-auto text-[10px] font-semibold tracking-widest" style={{ color: T.textLight }}>COLLEGE MARCEL</span>
    </h2>
  )
}

export default function PlayerProjectionCard({ playerId, side = 'hitter' }) {
  const T = usePlayerProfileTheme()
  const sideKey = side === 'pitcher' ? 'pit' : 'bat'
  const { data, loading } = useApi(
    playerId ? `/players/${playerId}/projection` : null,
    { side: sideKey }, [playerId, sideKey],
  )

  if (loading && !data) return null            // stay quiet until we know
  if (!data) return null
  const season = data.season || 2027

  // No projection for this player (insufficient stats).
  if (!data.available) {
    return (
      <div className="rounded-md p-5 mb-4" style={{ background: T.card, border: `1px solid ${T.border}` }}>
        <HeaderBar T={T} season={season} proj={null} />
        <div className="text-[12px] py-2 text-center" style={{ color: T.textMuted }}>
          No {season} projection available for this player.
        </div>
      </div>
    )
  }

  // ── UNLOCKED: full projected line + range + writeup ──
  const p = data.projection || {}
  const h = p.headline || {}
  const isBat = sideKey === 'bat'
  const headlineFmt = isBat ? f3 : f2
  const rangeFmt = isBat ? f3 : f2
  const rates = p.rates || {}
  const rateOrder = isBat ? ['AVG', 'OBP', 'SLG', 'ISO', 'K%', 'BB%'] : ['FIP', 'WHIP', 'K%', 'BB%', 'HR/9', 'Opp AVG']
  const rateFmt = (k, v) => {
    if (v == null) return '—'
    if (k === 'K%' || k === 'BB%') return fPct(v)
    if (k === 'HR/9') return f2(v)
    return f3(v)  // AVG/OBP/SLG/ISO/FIP-ish/WHIP/OppAVG → 3-decimal-ish; FIP/WHIP read fine as .XX too
  }
  // FIP/WHIP look better with 2 decimals ≥ 1
  const rateFmt2 = (k, v) => {
    if (v == null) return '—'
    if (k === 'K%' || k === 'BB%') return fPct(v)
    if (k === 'FIP' || k === 'WHIP' || k === 'HR/9') return f2(v)
    if (k === 'Opp AVG') return f3(v)
    return f3(v)
  }

  return (
    <div className="rounded-md p-5 mb-4" style={{ background: T.card, border: `1px solid ${T.border}` }}>
      <HeaderBar T={T} season={season} proj={p} />

      {/* Headline projected value + range of outcomes */}
      <div className="flex items-end gap-4 mb-3 flex-wrap">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: T.textLight }}>Projected {h.key}</div>
          <div className="text-[30px] font-black leading-none tabular-nums" style={{ color: T.accent }}>{headlineFmt(h.value)}</div>
        </div>
        {(h.lo != null && h.hi != null) && (
          <div className="pb-1">
            <div className="text-[9.5px] font-bold uppercase tracking-wider" style={{ color: T.textLight }}>Range of outcomes</div>
            <div className="text-[13px] font-semibold tabular-nums" style={{ color: T.text }}>
              {rangeFmt(h.lo)} <span style={{ color: T.textLight }}>–</span> {rangeFmt(h.hi)}
              <span className="text-[10px] font-normal ml-1" style={{ color: T.textLight }}>10th–90th pct</span>
            </div>
          </div>
        )}
        <div className="pb-1 ml-auto text-right">
          <div className="text-[9.5px] font-bold uppercase tracking-wider" style={{ color: T.textLight }}>{isBat ? 'Proj PA' : 'Proj IP'} · WAR</div>
          <div className="text-[13px] font-semibold tabular-nums" style={{ color: T.text }}>
            {isBat ? fInt(p.pa) : f1(p.ip)} <span style={{ color: T.textLight }}>·</span> {f1(p.war)}
          </div>
        </div>
      </div>

      {/* Rate grid */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5 mb-3">
        {rateOrder.map((k) => <StatTile key={k} label={k} value={rateFmt2(k, rates[k])} T={T} />)}
      </div>

      {/* Counting line */}
      <div className="text-[11.5px] mb-3 tabular-nums" style={{ color: T.textMuted }}>
        {isBat
          ? `${fInt(p.counting?.HR)} HR · ${fInt(p.counting?.RBI)} RBI · ${fInt(p.counting?.R)} R · ${fInt(p.counting?.H)} H · ${fInt(p.counting?.BB)} BB · ${fInt(p.counting?.SO)} SO`
          : `${f1(p.counting?.IP)} IP · ${fInt(p.counting?.HR)} HR allowed`}
      </div>

      {/* Writeup */}
      {data.writeup && (
        <div className="rounded p-3 text-[12px] leading-relaxed" style={{ background: T.bg || 'transparent', border: `1px solid ${T.border}`, color: T.text }}>
          <div className="text-[9.5px] font-bold uppercase tracking-widest mb-1" style={{ color: T.textLight }}>Why this projection</div>
          {data.writeup}
        </div>
      )}

      <div className="text-[10px] mt-2.5" style={{ color: T.textLight }}>
        A model estimate of next-season talent, not a guarantee. The range reflects the spread of likely outcomes.
      </div>
    </div>
  )
}
