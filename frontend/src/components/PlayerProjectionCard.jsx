// 2027 projection card for the player profile pages, placed under the PBP data.
//
// Tiered: premium+ (and the author's preview tier) see the full projected line,
// the 10th-90th percentile range of outcomes, and a short scouting writeup of
// WHY the model lands where it does. Free / anonymous viewers get a one-stat
// teaser (projected AVG for hitters, ERA for pitchers) with the rest blurred
// behind a subscribe CTA. Players the model can't project (too few stats) show
// "no projection available".
//
// Gating is frontend-side via useTier() so the paywall preview is live now even
// in pre-launch soft mode (matches RequireTier/article behavior); the backend
// also trims the payload by tier once TIER_GATING_ENABLED flips on.
//
// Powered by the "College Marcel" projection model.

import { Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { useTier } from '../hooks/useTier'
import { tierMeets } from '../lib/tiers'
import { usePlayerProfileTheme, pctColor } from './playerProfile/shared'

const REQUIRED_TIER = 'premium'

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
  const { tier, loading: tierLoading } = useTier()
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

  const unlocked = !tierLoading && tierMeets(tier, REQUIRED_TIER)
  const previewVal = data.preview?.value
  const previewLabel = data.preview?.key || (sideKey === 'bat' ? 'AVG' : 'ERA')
  const previewText = sideKey === 'bat' ? f3(previewVal) : f2(previewVal)

  // ── LOCKED: teaser stat + blurred grid + subscribe CTA ──
  if (!unlocked) {
    return (
      <div className="rounded-md p-5 mb-4" style={{ background: T.card, border: `1px solid ${T.border}` }}>
        <HeaderBar T={T} season={season} proj={{ class: data.class, level: data.level }} />
        <div className="flex items-baseline gap-2 mb-3">
          <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: T.textLight }}>Projected {previewLabel}</span>
          <span className="text-[26px] font-black leading-none tabular-nums" style={{ color: T.accent }}>{previewText}</span>
        </div>
        <div className="relative">
          {/* Blurred placeholder content sells what's behind the wall */}
          <div className="select-none pointer-events-none" style={{ filter: 'blur(6px)', opacity: 0.7 }} aria-hidden="true">
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5 mb-3">
              {(sideKey === 'bat'
                ? ['OBP', 'SLG', 'wOBA', 'HR', 'K%', 'BB%']
                : ['FIP', 'WHIP', 'K%', 'BB%', 'HR/9', 'IP']).map((l, i) => (
                <StatTile key={l} label={l} value={['.3XX', '.4XX', '.3XX', 'X.X', 'XX%', 'X.X'][i % 6]} T={T} />
              ))}
            </div>
            <div className="text-[12px] leading-relaxed" style={{ color: T.textMuted }}>
              Range of outcomes and a full scouting writeup explaining the projection live here for subscribers.
            </div>
          </div>
          {/* CTA overlay */}
          <div className="absolute inset-0 flex items-center justify-center p-2">
            <div className="text-center rounded-lg px-4 py-3 max-w-xs" style={{ background: T.card, border: `1px solid ${T.border}`, boxShadow: '0 6px 24px rgba(0,0,0,0.18)' }}>
              <div className="text-[12px] font-semibold mb-1" style={{ color: T.text }}>
                🔒 Unlock the full {season} projection
              </div>
              <div className="text-[11px] mb-2.5" style={{ color: T.textMuted }}>
                Every projected stat, the 10th–90th percentile range, and the scouting writeup.
              </div>
              <Link to="/pricing" className="inline-block text-[12px] font-bold px-3.5 py-1.5 rounded-md text-white"
                style={{ background: T.accent }}>
                Subscribe to unlock
              </Link>
            </div>
          </div>
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
