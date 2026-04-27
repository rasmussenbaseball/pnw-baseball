// WpaByGameChart — rolling cumulative-WPA line chart for the player
// profile. X axis is chronological game order (date), Y axis is the
// running cumulative WPA total from the start of the season.
//
// Color regions: above zero (positive contribution) shaded green,
// below zero (cost his team wins) shaded red. Reference line at y=0.
//
// Hover tooltip shows the game's date, opponent, that game's WPA
// delta, and the running cumulative through that point.
//
// For two-way players we render the batter and pitcher series
// stacked — distinct colors, separate cards.

import { useMemo } from 'react'
import {
  ResponsiveContainer, ComposedChart, Area, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from 'recharts'
import { usePlayerWpaByGame } from '../hooks/useApi'

const SEASON = 2026


export default function WpaByGameChart({ playerId, position }) {
  const { data, loading } = usePlayerWpaByGame(playerId, SEASON)
  if (loading || !data) return null

  const isPitcher = (position || '').toUpperCase() === 'P'
  // Show pitcher chart first if the player is primarily a pitcher,
  // batter first otherwise. Two-way players show both.
  const sides = isPitcher
    ? [
        { key: 'pitcher', label: 'WPA on the mound', series: data.pitcher,
          unit: 'BF', color: '#0f766e' /* teal-700 */ },
        { key: 'batter',  label: 'WPA at the plate', series: data.batter,
          unit: 'PA', color: '#b45309' /* amber-700 */ },
      ]
    : [
        { key: 'batter',  label: 'WPA at the plate', series: data.batter,
          unit: 'PA', color: '#b45309' /* amber-700 */ },
        { key: 'pitcher', label: 'WPA on the mound', series: data.pitcher,
          unit: 'BF', color: '#0f766e' /* teal-700 */ },
      ]
  const visible = sides.filter(s => (s.series?.length || 0) > 0)
  if (visible.length === 0) return null

  return (
    <div className="space-y-4">
      {visible.map(s => (
        <SeriesCard key={s.key} label={s.label} series={s.series}
                    unit={s.unit} color={s.color} />
      ))}
    </div>
  )
}


function SeriesCard({ label, series, unit, color }) {
  // Recharts wants array of objects with consistent keys.
  // Pre-compute display fields so the tooltip is clean.
  const data = useMemo(() => series.map((g, i) => ({
    idx: i + 1,
    date: g.date,
    dateShort: formatShortDate(g.date),
    opp: g.opp_short || '?',
    is_home: g.is_home,
    result: g.result,
    won: g.won,
    wpa: g.wpa,
    cumulative: g.cumulative,
    // Split cumulative into two stacked areas — positive band and
    // negative band — so we can color them separately. Recharts
    // doesn't support per-point fill, so we plot two areas with
    // baseline = 0.
    posCum: g.cumulative > 0 ? g.cumulative : 0,
    negCum: g.cumulative < 0 ? g.cumulative : 0,
  })), [series])

  if (data.length === 0) return null

  const first = series[0]
  const last = series[series.length - 1]
  const total = last.cumulative
  const sign = total >= 0 ? '+' : ''
  const totalColor = total >= 0.5 ? 'text-emerald-700' :
                      total <= -0.5 ? 'text-rose-700' : 'text-gray-700'

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-gray-50 border-b border-gray-100 flex items-baseline justify-between">
        <div>
          <div className="text-xs font-bold text-gray-900 uppercase">{label}</div>
          <div className="text-[10px] text-gray-500">
            {data.length} games · {first.date?.slice(5)} → {last.date?.slice(5)}
          </div>
        </div>
        <div className="flex items-baseline gap-2">
          <span className={`text-2xl font-bold tabular-nums ${totalColor}`}>
            {sign}{total.toFixed(2)}
          </span>
          <span className="text-[10px] text-gray-500">season total</span>
        </div>
      </div>
      <div className="p-2" style={{ height: 220 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
            <XAxis
              dataKey="idx"
              tick={{ fontSize: 10, fill: '#9ca3af' }}
              axisLine={{ stroke: '#e5e7eb' }}
              tickLine={false}
              label={{ value: 'Game #', position: 'insideBottom', offset: -2,
                       style: { fontSize: 10, fill: '#9ca3af' } }}
            />
            <YAxis
              tick={{ fontSize: 10, fill: '#9ca3af' }}
              axisLine={{ stroke: '#e5e7eb' }}
              tickLine={false}
              tickFormatter={v => v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1)}
            />
            <ReferenceLine y={0} stroke="#9ca3af" strokeDasharray="2 2" />
            {/* Positive area — green */}
            <Area
              type="monotone"
              dataKey="posCum"
              stroke="none"
              fill="#10b981"
              fillOpacity={0.18}
              isAnimationActive={false}
            />
            {/* Negative area — rose */}
            <Area
              type="monotone"
              dataKey="negCum"
              stroke="none"
              fill="#f43f5e"
              fillOpacity={0.18}
              isAnimationActive={false}
            />
            {/* The cumulative line itself, in the side's accent color */}
            <Line
              type="monotone"
              dataKey="cumulative"
              stroke={color}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Tooltip content={<WpaTooltip unit={unit} />} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}


// Custom tooltip — date, opponent, this game's WPA, cumulative.
function WpaTooltip({ active, payload, unit }) {
  if (!active || !payload || payload.length === 0) return null
  const p = payload[0].payload
  const wpaSign = p.wpa >= 0 ? '+' : ''
  const cumSign = p.cumulative >= 0 ? '+' : ''
  const wpaColor = p.wpa >= 0.05 ? 'text-emerald-700' :
                   p.wpa <= -0.05 ? 'text-rose-700' : 'text-gray-700'
  return (
    <div className="bg-white border border-gray-200 rounded shadow-md p-2 text-[11px]">
      <div className="text-gray-900 font-semibold mb-0.5">
        {p.is_home ? 'vs' : '@'} {p.opp}
      </div>
      <div className="text-gray-500 mb-1">
        {p.dateShort}
        {p.result && <span className="ml-2 font-medium text-gray-700">{p.result}</span>}
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-gray-500">This game:</span>
        <span className={`font-bold tabular-nums ${wpaColor}`}>
          {wpaSign}{p.wpa.toFixed(2)}
        </span>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-gray-500">Cumulative:</span>
        <span className="font-bold tabular-nums text-gray-900">
          {cumSign}{p.cumulative.toFixed(2)}
        </span>
      </div>
    </div>
  )
}


function formatShortDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
