// TrackManCard — PRIVATE (dev-tier only) TrackMan pitch-shape panel.
//
// Renders a horizontal-vs-vertical-break movement plot plus a per-pitch-type
// table (velo, spin, break, release, in-zone/whiff/chase) for one player.
// Source data is averaged per pitch type (no pitch-level), ingested from
// TrackMan session-report PDFs into trackman_pitches.
//
// Used on BOTH profiles:
//   • summer-only players  -> endpoint="/summer/players/<summerId>/trackman"
//   • linked college players (unified /player page) -> "/players/<springId>/trackman"
// The component fetches nothing and renders nothing unless the viewer is dev.

import { useTier } from '../../hooks/useTier'
import { useApi } from '../../hooks/useApi'
import { usePlayerProfileTheme, SectionCard } from './shared'

// Pitch-type color + short code, roughly matching TrackMan's own palette.
const PITCH_META = {
  'Four Seam':     { c: '#e8556e', code: 'FF' },
  'Sinker':        { c: '#f0a05a', code: 'SI' },
  'Cutter':        { c: '#9b7d4e', code: 'FC' },
  'Slider':        { c: '#e0c84a', code: 'SL' },
  'Sweeper':       { c: '#b07bd0', code: 'SW' },
  'Curveball':     { c: '#5d99c6', code: 'CU' },
  'Knuckle Curve': { c: '#3f6fa0', code: 'KC' },
  'Changeup':      { c: '#8cb84f', code: 'CH' },
  'Splitter':      { c: '#4aa6a6', code: 'FS' },
  'Knuckleball':   { c: '#7a8a99', code: 'KN' },
  'Undefined':     { c: '#9aa0a8', code: '?' },
}
const meta = (pt) => PITCH_META[pt] || { c: '#9aa0a8', code: pt?.slice(0, 2) || '?' }

const f1 = (v) => (v == null ? '—' : Number(v).toFixed(1))
const f2 = (v) => (v == null ? '—' : Number(v).toFixed(2))
const pct = (v) => (v == null ? '—' : `${Number(v).toFixed(1)}%`)
const spin = (v) => (v == null ? '—' : Math.round(Number(v)).toLocaleString())

// ── Horizontal-break (x) vs induced-vertical-break (y) scatter ──
function MovementPlot({ pitches, T }) {
  const SIZE = 300, M = 26, R = 25 // domain ±25 inches
  const half = (SIZE - 2 * M) / 2
  const cx = SIZE / 2, cy = SIZE / 2
  const sx = (hb) => cx + Math.max(-R, Math.min(R, hb)) / R * half
  const sy = (ivb) => cy - Math.max(-R, Math.min(R, ivb)) / R * half
  const plot = pitches.filter(p => p.pitch_type !== 'Undefined' && p.ivb != null && p.hb != null)
  const maxC = Math.max(1, ...plot.map(p => p.pitch_count || 0))
  const rad = (c) => 5 + 8 * Math.sqrt((c || 0) / maxC)

  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="w-full" style={{ maxWidth: 320 }}>
      {/* gridlines */}
      {[-20, -10, 10, 20].map(v => (
        <g key={v}>
          <line x1={sx(v)} y1={M} x2={sx(v)} y2={SIZE - M} stroke={T.border} strokeWidth="1" strokeDasharray="2 3" />
          <line x1={M} y1={sy(v)} x2={SIZE - M} y2={sy(v)} stroke={T.border} strokeWidth="1" strokeDasharray="2 3" />
        </g>
      ))}
      {/* zero axes */}
      <line x1={cx} y1={M} x2={cx} y2={SIZE - M} stroke={T.borderStrong} strokeWidth="1.5" />
      <line x1={M} y1={cy} x2={SIZE - M} y2={cy} stroke={T.borderStrong} strokeWidth="1.5" />
      {/* axis labels */}
      <text x={SIZE - M + 2} y={cy - 4} fontSize="9" fill={T.textMuted} textAnchor="end">HB →</text>
      <text x={cx + 4} y={M + 8} fontSize="9" fill={T.textMuted}>↑ IVB</text>
      {/* dots */}
      {plot.map((p, i) => {
        const m = meta(p.pitch_type)
        return (
          <g key={i}>
            <circle cx={sx(p.hb)} cy={sy(p.ivb)} r={rad(p.pitch_count)} fill={m.c} fillOpacity="0.78"
                    stroke="#fff" strokeWidth="1.2" />
            <text x={sx(p.hb)} y={sy(p.ivb) + 3} fontSize="8" fontWeight="700" fill="#fff"
                  textAnchor="middle" style={{ pointerEvents: 'none' }}>{m.code}</text>
          </g>
        )
      })}
    </svg>
  )
}

const COLS = [
  ['Pitch', 'l'], ['Usage', 'r'], ['Velo', 'r'], ['Spin', 'r'], ['IVB', 'r'], ['HB', 'r'],
  ['Tilt', 'r'], ['Ext', 'r'], ['RelHt', 'r'], ['RelSide', 'r'], ['Zone%', 'r'], ['Whiff%', 'r'], ['Chase%', 'r'],
]

export default function TrackManCard({ endpoint }) {
  const { tier } = useTier()
  const isDev = tier === 'dev'
  const { data } = useApi(isDev && endpoint ? endpoint : null)
  const T = usePlayerProfileTheme()

  if (!isDev || !data?.has_data || !data.pitches?.length) return null
  const pitches = data.pitches

  return (
    <SectionCard
      title="TrackMan"
      right={
        <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded"
              style={{ background: '#fde68a', color: '#92400e' }} title="Private — visible to dev tier only">
          🔒 Dev only
        </span>
      }
    >
      <div className="flex items-center justify-between mb-3 text-[11px]" style={{ color: T.textMuted }}>
        <span>Pitch shapes · {data.season}{data.total_pitches ? ` · ${data.total_pitches} pitches` : ''}</span>
        <span>averages</span>
      </div>

      <div className="flex flex-col lg:flex-row gap-5">
        {/* movement plot */}
        <div className="flex-shrink-0 flex flex-col items-center">
          <div className="text-[11px] font-semibold mb-1" style={{ color: T.text }}>Movement (catcher view)</div>
          <MovementPlot pitches={pitches} T={T} />
        </div>

        {/* per-pitch table */}
        <div className="flex-1 overflow-x-auto">
          <table className="w-full text-[11px] tabular-nums" style={{ minWidth: 560 }}>
            <thead>
              <tr style={{ color: T.textMuted, borderBottom: `1px solid ${T.border}` }}>
                {COLS.map(([label, align]) => (
                  <th key={label} className={`py-1.5 px-1.5 font-semibold ${align === 'l' ? 'text-left' : 'text-right'}`}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pitches.map((p, i) => {
                const m = meta(p.pitch_type)
                return (
                  <tr key={i} style={{ borderBottom: `1px solid ${T.rowBorder}`, color: T.text }}>
                    <td className="py-1.5 px-1.5 text-left whitespace-nowrap">
                      <span className="inline-block w-2.5 h-2.5 rounded-full mr-1.5 align-middle" style={{ background: m.c }} />
                      {p.pitch_type}
                    </td>
                    <td className="py-1.5 px-1.5 text-right">{pct(p.usage_pct)}</td>
                    <td className="py-1.5 px-1.5 text-right font-semibold">{f1(p.velo)}</td>
                    <td className="py-1.5 px-1.5 text-right">{spin(p.spin)}</td>
                    <td className="py-1.5 px-1.5 text-right">{f1(p.ivb)}</td>
                    <td className="py-1.5 px-1.5 text-right">{f1(p.hb)}</td>
                    <td className="py-1.5 px-1.5 text-right">{p.tilt || '—'}</td>
                    <td className="py-1.5 px-1.5 text-right">{f2(p.extension)}</td>
                    <td className="py-1.5 px-1.5 text-right">{f2(p.rel_height)}</td>
                    <td className="py-1.5 px-1.5 text-right">{f2(p.rel_side)}</td>
                    <td className="py-1.5 px-1.5 text-right">{pct(p.in_zone_pct)}</td>
                    <td className="py-1.5 px-1.5 text-right">{pct(p.whiff_pct)}</td>
                    <td className="py-1.5 px-1.5 text-right">{pct(p.chase_pct)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </SectionCard>
  )
}
