/**
 * Team Scouting page — /portal/team-scouting.
 *
 * Coach-facing scouting report for any team. Shows:
 *   - Team header + last-10 record
 *   - Auto-generated writeup (collapsible)
 *   - Four team-stats panels with conference percentile color-coding
 *   - Roster strengths/weaknesses summary (collapsible)
 *   - Compact hitters / starters / relievers tables
 *
 * All data comes from /api/v1/portal/team-scouting?team_id=X.
 */

import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { usePortalTeam } from '../context/PortalTeamContext'

const SEASON = 2026

// ────────────────────────────────────────────
// Formatting helpers
// ────────────────────────────────────────────

function fmtVal(v, format) {
  if (v == null || isNaN(v)) return '—'
  if (format === 'rate') return Number(v).toFixed(3).replace(/^0/, '')
  if (format === 'pct')  return `${(Number(v) * 100).toFixed(1)}%`
  if (format === 'era')  return Number(v).toFixed(2)
  if (format === 'int')  return `${Math.round(Number(v))}`
  return String(v)
}

function fmt3(v) {
  if (v == null || isNaN(v)) return '—'
  return Number(v).toFixed(3).replace(/^0/, '')
}
function fmtPct(v) {
  if (v == null || isNaN(v)) return '—'
  return `${(Number(v) * 100).toFixed(1)}%`
}
function fmtEra(v) {
  if (v == null || isNaN(v)) return '—'
  return Number(v).toFixed(2)
}

// Color bucket → tailwind classes
const COLOR_TEXT = {
  elite:   'text-emerald-700 font-semibold',
  good:    'text-emerald-600',
  avg:     'text-gray-700',
  poor:    'text-rose-500',
  bad:     'text-rose-700 font-semibold',
  neutral: 'text-gray-500',
}

const COLOR_BAR_FILL = {
  elite:   'bg-emerald-500',
  good:    'bg-emerald-300',
  avg:     'bg-gray-300',
  poor:    'bg-rose-300',
  bad:     'bg-rose-500',
  neutral: 'bg-gray-200',
}

function pctileFor(player, key) {
  return player?.percentiles?.[key]
}
function colorForPctile(p) {
  if (p == null) return 'neutral'
  if (p >= 90) return 'elite'
  if (p >= 70) return 'good'
  if (p >= 30) return 'avg'
  if (p >= 10) return 'poor'
  return 'bad'
}


// ────────────────────────────────────────────
// Page
// ────────────────────────────────────────────

export default function TeamScouting() {
  const { team: portalTeam } = usePortalTeam()
  const [selectedId, setSelectedId] = useState(null)
  const { data: teams } = useApi('/teams', {})

  useEffect(() => {
    if (selectedId == null && portalTeam?.id) setSelectedId(portalTeam.id)
  }, [portalTeam?.id, selectedId])

  const { data, loading, error } = useApi(
    '/portal/team-scouting',
    selectedId ? { team_id: selectedId, season: SEASON } : {},
    [selectedId],
  )

  const teamOptions = useMemo(() => {
    if (!teams) return []
    return [...teams]
      .filter(t => t.is_active)
      .sort((a, b) => (a.short_name || a.name).localeCompare(b.short_name || b.name))
  }, [teams])

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-5 py-5 space-y-4">
      <Card>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-sm font-semibold text-portal-purple-dark">Scout team:</label>
          <select
            value={selectedId ?? ''}
            onChange={(e) => setSelectedId(Number(e.target.value))}
            className="px-3 py-2 rounded-lg border border-gray-300 text-sm
                       focus:outline-none focus:ring-2 focus:ring-nw-teal min-w-[260px]"
          >
            <option value="">Pick a team...</option>
            {teamOptions.map(t => (
              <option key={t.id} value={t.id}>
                {t.short_name || t.name}
                {t.conference_abbrev ? ` (${t.conference_abbrev})` : ''}
              </option>
            ))}
          </select>
        </div>
      </Card>

      {error && (
        <Card title="Couldn't load scouting report">
          <p className="text-sm text-red-700">{error}</p>
        </Card>
      )}

      {loading && !data && (
        <Card>
          <p className="text-sm text-gray-500 italic">Loading scouting report...</p>
        </Card>
      )}

      {data && !data.error && (
        <>
          <TeamHeader team={data.team} recent={data.recent} />
          <WriteupCard text={data.writeup} />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <StatPanel title="Offense" subtitle="Conference percentiles" rows={data.panels.offense} />
            <StatPanel title="Pitching" subtitle="Conference percentiles" rows={data.panels.pitching} />
            <StatPanel title="Plate Discipline" subtitle="From per-pitch PBP data" rows={data.panels.plate_discipline} />
            <StatPanel title="Batted Ball" subtitle="From per-PA PBP data" rows={data.panels.batted_ball} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <TeamSplitsPanel
              title="Hitter Splits"
              subtitle="Team aggregates by pitcher hand and base state"
              splits={data.team_hitter_splits}
              statSpecs={HITTER_SPLIT_STATS}
            />
            <TeamSplitsPanel
              title="Pitcher Splits"
              subtitle="Team aggregates by batter hand and base state"
              splits={data.team_pitcher_splits}
              statSpecs={PITCHER_SPLIT_STATS}
            />
          </div>

          <RosterStrengthsSummary
            hitters={data.hitters}
            starters={data.starters}
            relievers={data.relievers}
          />

          <PlayerTable
            title="Hitters"
            subtitle="Min 30 PA · cells colored by conference percentile"
            kind="hitter"
            rows={data.hitters}
          />
          <PlayerTable
            title="Starting Pitchers"
            subtitle="Min 15 IP, ≥ 3.5 IP/G"
            kind="pitcher"
            rows={data.starters}
          />
          <PlayerTable
            title="Bullpen / Relievers"
            subtitle="Min 5 IP, < 3.5 IP/G"
            kind="pitcher"
            rows={data.relievers}
          />
        </>
      )}
    </div>
  )
}


/* ============================================================
 * Team header
 * ============================================================ */

function TeamHeader({ team, recent }) {
  if (!team) return null
  return (
    <section className="bg-portal-purple text-portal-cream rounded-xl px-5 py-4 shadow">
      <div className="flex items-center gap-4 flex-wrap">
        {team.logo_url && (
          <img
            src={team.logo_url}
            alt={`${team.name} logo`}
            className="w-14 h-14 object-contain bg-white rounded-md p-1"
          />
        )}
        <div className="flex-1 min-w-[200px]">
          <h1 className="text-2xl font-semibold tracking-tight">
            {team.name}
          </h1>
          <p className="text-sm opacity-90">
            {team.conference_name} ({team.division_level})
            {team.city ? ` · ${team.city}` : ''}{team.state ? `, ${team.state}` : ''}
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3 text-center">
          <Stat label="Overall" value={`${team.wins ?? 0}-${team.losses ?? 0}${team.ties ? `-${team.ties}` : ''}`} />
          <Stat label="Conference" value={`${team.conference_wins ?? 0}-${team.conference_losses ?? 0}`} />
          <Stat label="Last 10" value={recent?.record || '—'} />
        </div>
      </div>
    </section>
  )
}

function Stat({ label, value }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider opacity-70">{label}</div>
      <div className="text-lg font-bold tabular-nums">{value}</div>
    </div>
  )
}


/* ============================================================
 * Writeup card
 * ============================================================ */

function WriteupCard({ text }) {
  const [open, setOpen] = useState(true)
  if (!text) return null
  return (
    <section className="bg-white border border-gray-200 rounded-xl shadow-sm">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-gray-50 rounded-t-xl"
      >
        <div>
          <h2 className="text-base font-semibold text-portal-purple-dark">Scouting Writeup</h2>
          <p className="text-xs text-gray-500">Auto-generated from conference percentiles</p>
        </div>
        <Chevron open={open} />
      </button>
      {open && (
        <div className="px-4 pb-4 border-t border-gray-100 pt-3 text-sm text-gray-800 leading-relaxed whitespace-pre-line">
          {text}
        </div>
      )}
    </section>
  )
}


/* ============================================================
 * Team stats panel
 * ============================================================ */

function StatPanel({ title, subtitle, rows }) {
  if (!rows || rows.length === 0) return null
  return (
    <Card title={title} subtitle={subtitle}>
      <div className="space-y-1.5">
        {rows.map(row => (
          <StatPanelRow key={row.key} row={row} />
        ))}
      </div>
    </Card>
  )
}

function StatPanelRow({ row }) {
  const colorText = COLOR_TEXT[row.color] || COLOR_TEXT.avg
  const barFill = COLOR_BAR_FILL[row.color] || COLOR_BAR_FILL.avg
  const valueStr = fmtVal(row.value, row.format)
  const rankStr = row.rank ? `${row.rank} of ${row.total}` : '—'
  const pctStr = row.percentile != null ? `${Math.round(row.percentile)}` : '—'
  const pctBarPct = row.percentile != null ? Math.max(0, Math.min(100, row.percentile)) : 0

  return (
    <div className="grid grid-cols-[80px_1fr_60px_70px] items-center gap-2 text-sm py-1">
      <div className="text-gray-600 text-xs font-semibold uppercase tracking-wider">{row.label}</div>
      <div className="relative">
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
          {row.percentile != null && (
            <div
              className={`h-full ${barFill} transition-all`}
              style={{ width: `${pctBarPct}%` }}
            />
          )}
        </div>
      </div>
      <div className={`text-right font-mono text-sm ${colorText}`}>{valueStr}</div>
      <div className="text-right text-[11px] text-gray-500 tabular-nums" title={`Rank ${rankStr} in conference`}>
        {row.percentile == null ? '—' : `${pctStr}%ile · ${row.rank}/${row.total}`}
      </div>
    </div>
  )
}


/* ============================================================
 * Team splits panel — displays vs LHP/RHP/RISP (or LHH/RHH/RISP) as columns
 * ============================================================ */

const HITTER_SPLIT_STATS = [
  { key: 'woba',         label: 'wOBA',     fmt: fmt3 },
  { key: 'iso',          label: 'ISO',      fmt: fmt3 },
  { key: 'contact_pct',  label: 'Contact%', fmt: fmtPct },
  { key: 'k_pct',        label: 'K%',       fmt: fmtPct },
  { key: 'bb_pct',       label: 'BB%',      fmt: fmtPct },
]

const PITCHER_SPLIT_STATS = [
  { key: 'fip',         label: 'FIP',     fmt: fmtEra },
  { key: 'k_pct',       label: 'K%',      fmt: fmtPct },
  { key: 'bb_pct',      label: 'BB%',     fmt: fmtPct },
  { key: 'whiff_pct',   label: 'Whiff%',  fmt: fmtPct },
]

function TeamSplitsPanel({ title, subtitle, splits, statSpecs }) {
  if (!splits || splits.length === 0) return null
  return (
    <Card title={title} subtitle={subtitle}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b border-gray-200">
              <Th className="w-[120px]">Stat</Th>
              {splits.map(s => (
                <Th key={s.label} className="text-right">{s.label}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {statSpecs.map(spec => (
              <tr key={spec.key} className="border-b border-gray-100 last:border-0">
                <td className="py-2 text-gray-600 text-xs font-semibold uppercase tracking-wider">
                  {spec.label}
                </td>
                {splits.map(s => {
                  const v = s.stats?.[spec.key]
                  return (
                    <td key={s.label} className="py-2 text-right font-mono text-sm text-gray-800">
                      {v == null ? '—' : spec.fmt(v)}
                    </td>
                  )
                })}
              </tr>
            ))}
            <tr className="text-[11px] text-gray-400">
              <td className="pt-2">Sample</td>
              {splits.map(s => (
                <td key={s.label} className="pt-2 text-right tabular-nums">
                  {s.stats?.pa != null ? `${s.stats.pa} PA` : (s.stats?.bf != null ? `${s.stats.bf} BF` : '—')}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  )
}


/* ============================================================
 * Roster strengths/weaknesses summary
 * ============================================================ */

function RosterStrengthsSummary({ hitters, starters, relievers }) {
  const [open, setOpen] = useState(false)
  const all = [
    ...(hitters || []).map(p => ({ ...p, role: 'H' })),
    ...(starters || []).map(p => ({ ...p, role: 'SP' })),
    ...(relievers || []).map(p => ({ ...p, role: 'RP' })),
  ].filter(p => (p.strengths?.length || 0) + (p.weaknesses?.length || 0) > 0)
  if (!all.length) return null
  return (
    <section className="bg-white border border-gray-200 rounded-xl shadow-sm">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-gray-50 rounded-t-xl"
      >
        <div>
          <h2 className="text-base font-semibold text-portal-purple-dark">Player Strengths & Weaknesses</h2>
          <p className="text-xs text-gray-500">{all.length} players · top-2 / bottom-2 percentile flags per player</p>
        </div>
        <Chevron open={open} />
      </button>
      {open && (
        <div className="px-4 pb-4 border-t border-gray-100 pt-3 space-y-2">
          {all.map(p => (
            <div key={`${p.role}-${p.player_id}`} className="text-sm leading-snug">
              <Link to={`/player/${p.player_id}`} className="font-semibold text-portal-purple hover:underline">
                {p.first_name} {p.last_name}
              </Link>
              <span className="ml-1.5 inline-block px-1 text-[10px] font-bold uppercase tracking-wider rounded bg-gray-100 text-gray-700">
                {p.role}
              </span>
              {p.position && (
                <span className="ml-1.5 text-[11px] text-gray-500">{p.position}</span>
              )}
              <div className="text-xs mt-0.5 text-gray-700">
                {p.strengths?.length > 0 && (
                  <span className="text-emerald-700">
                    Strong: {p.strengths.map(s => `${s.label} (${Math.round(s.percentile)}th)`).join(', ')}
                  </span>
                )}
                {p.strengths?.length > 0 && p.weaknesses?.length > 0 && <span className="mx-1.5 text-gray-300">·</span>}
                {p.weaknesses?.length > 0 && (
                  <span className="text-rose-700">
                    Weak: {p.weaknesses.map(s => `${s.label} (${Math.round(s.percentile)}th)`).join(', ')}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}


/* ============================================================
 * Player table
 * ============================================================ */

const HITTER_COLS = [
  { key: 'plate_appearances', label: 'PA',      muted: true },
  { key: 'batting_avg',  label: 'AVG',          fmt: fmt3 },
  { key: 'on_base_pct',  label: 'OBP',          fmt: fmt3, pctileKey: 'on_base_pct' },
  { key: 'slugging_pct', label: 'SLG',          fmt: fmt3, pctileKey: 'slugging_pct' },
  { key: 'iso',          label: 'ISO',          fmt: fmt3, pctileKey: 'iso' },
  { key: 'woba',         label: 'wOBA',         fmt: fmt3, pctileKey: 'woba' },
  { key: 'wrc_plus',     label: 'wRC+',         fmt: v => v == null ? '—' : Math.round(v), pctileKey: 'wrc_plus' },
  { key: 'bb_pct',       label: 'BB%',          fmt: fmtPct, pctileKey: 'bb_pct' },
  { key: 'k_pct',        label: 'K%',           fmt: fmtPct, pctileKey: 'k_pct' },
  { key: 'contact_pct',  label: 'Contact%',     fmt: fmtPct, pctileKey: 'contact_pct' },
  { key: 'swing_pct',    label: 'Swing%',       fmt: fmtPct, muted: true },
  { key: 'whiff_pct',    label: 'Whiff%',       fmt: fmtPct, muted: true },
  { key: 'air_pull_pct', label: 'AIRPULL%',     fmt: fmtPct, pctileKey: 'air_pull_pct' },
  { key: 'gb_pct',       label: 'GB%',          fmt: fmtPct, muted: true },
  { key: 'fb_pct',       label: 'FB%',          fmt: fmtPct, muted: true },
  { key: 'ld_pct',       label: 'LD%',          fmt: fmtPct, muted: true },
  { key: 'hr_per_pa',    label: 'HR/PA',        fmt: fmtPct, pctileKey: 'hr_per_pa' },
  { key: 'home_runs',    label: 'HR' },
  { key: 'stolen_bases', label: 'SB',           muted: true },
]

const PITCHER_COLS = [
  { key: 'innings_pitched', label: 'IP',        fmt: v => v == null ? '—' : Number(v).toFixed(1) },
  { key: 'games',           label: 'G',         muted: true },
  { key: 'era',             label: 'ERA',       fmt: fmtEra, pctileKey: 'era' },
  { key: 'fip',             label: 'FIP',       fmt: fmtEra, pctileKey: 'fip' },
  { key: 'whip',            label: 'WHIP',      fmt: fmtEra, pctileKey: 'whip' },
  { key: 'k_pct',           label: 'K%',        fmt: fmtPct, pctileKey: 'k_pct' },
  { key: 'bb_pct',          label: 'BB%',       fmt: fmtPct, pctileKey: 'bb_pct' },
  { key: 'strike_pct',      label: 'Strike%',   fmt: fmtPct, muted: true },
  { key: 'whiff_pct',       label: 'Whiff%',    fmt: fmtPct, pctileKey: 'whiff_pct' },
  { key: 'fps_pct',         label: 'FPS%',      fmt: fmtPct, pctileKey: 'fps_pct' },
  { key: 'putaway_pct',     label: 'Putaway%',  fmt: fmtPct, pctileKey: 'putaway_pct' },
  { key: 'hr_per_9',        label: 'HR/9',      fmt: fmtEra, pctileKey: 'hr_per_9' },
  { key: 'opp_air_pull_pct',label: 'opp AIRPULL%', fmt: fmtPct, muted: true },
  { key: 'opp_gb_pct',      label: 'opp GB%',   fmt: fmtPct, muted: true },
  { key: 'opp_fb_pct',      label: 'opp FB%',   fmt: fmtPct, muted: true },
  { key: 'babip_against',   label: 'BABIP',     fmt: fmt3,   pctileKey: 'babip_against' },
]

// Per-filter column sets. When a split filter is active, we show a SLIM
// table — just the split stats — because the split aggregates we computed
// don't include every column (HR, SB, etc. only make sense at season scope).
const HITTER_SPLIT_COLS = [
  { key: 'pa',           label: 'PA',       fmt: v => v ?? '—', muted: true },
  { key: 'batting_avg',  label: 'AVG',      fmt: fmt3 },
  { key: 'slugging_pct', label: 'SLG',      fmt: fmt3 },
  { key: 'iso',          label: 'ISO',      fmt: fmt3 },
  { key: 'woba',         label: 'wOBA',     fmt: fmt3 },
  { key: 'k_pct',        label: 'K%',       fmt: fmtPct },
  { key: 'bb_pct',       label: 'BB%',      fmt: fmtPct },
  { key: 'contact_pct',  label: 'Contact%', fmt: fmtPct },
]
const PITCHER_SPLIT_COLS = [
  { key: 'bf',              label: 'BF',     fmt: v => v ?? '—', muted: true },
  { key: 'innings_pitched', label: 'IP',     fmt: v => v == null ? '—' : Number(v).toFixed(1) },
  { key: 'fip',             label: 'FIP',    fmt: fmtEra },
  { key: 'k_pct',           label: 'K%',     fmt: fmtPct },
  { key: 'bb_pct',          label: 'BB%',    fmt: fmtPct },
  { key: 'whiff_pct',       label: 'Whiff%', fmt: fmtPct },
]

const HITTER_FILTERS = [
  { key: 'season', label: 'Season',    splitKey: null },
  { key: 'vs_rhp', label: 'vs RHP',    splitKey: 'vs_rhp' },
  { key: 'vs_lhp', label: 'vs LHP',    splitKey: 'vs_lhp' },
  { key: 'risp',   label: 'w/ RISP',   splitKey: 'risp' },
]
const PITCHER_FILTERS = [
  { key: 'season', label: 'Season',    splitKey: null },
  { key: 'vs_rhh', label: 'vs RHH',    splitKey: 'vs_rhh' },
  { key: 'vs_lhh', label: 'vs LHH',    splitKey: 'vs_lhh' },
  { key: 'risp',   label: 'w/ RISP',   splitKey: 'risp' },
]

function PlayerTable({ title, subtitle, kind, rows }) {
  const filterOptions = kind === 'hitter' ? HITTER_FILTERS : PITCHER_FILTERS
  const [filterKey, setFilterKey] = useState('season')
  const activeFilter = filterOptions.find(f => f.key === filterKey) || filterOptions[0]

  if (!rows || rows.length === 0) {
    return (
      <Card title={title} subtitle={subtitle}>
        <p className="text-sm text-gray-500 italic">No qualifying players.</p>
      </Card>
    )
  }

  // When a split is active, swap to the slim split column set and
  // pull row values from each player's `splits[splitKey]` block.
  const isSplit = !!activeFilter.splitKey
  const cols = isSplit
    ? (kind === 'hitter' ? HITTER_SPLIT_COLS : PITCHER_SPLIT_COLS)
    : (kind === 'hitter' ? HITTER_COLS : PITCHER_COLS)

  return (
    <Card title={title} subtitle={subtitle}>
      <FilterTabs options={filterOptions} value={filterKey} onChange={setFilterKey} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b border-gray-200">
              <Th className="w-[200px] sticky left-0 bg-white z-10">Player</Th>
              <Th className="w-12">B/T</Th>
              <Th className="w-12">Yr</Th>
              {cols.map(c => (
                <Th key={c.key} className="text-right whitespace-nowrap">{c.label}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(p => (
              <PlayerRow
                key={p.player_id}
                player={p}
                cols={cols}
                kind={kind}
                splitKey={activeFilter.splitKey}
              />
            ))}
          </tbody>
        </table>
      </div>
      {isSplit && (
        <p className="text-[11px] text-gray-400 italic mt-2">
          Split values are unfiltered conference-pool — color-coding is paused while a split is active.
        </p>
      )}
    </Card>
  )
}

function FilterTabs({ options, value, onChange }) {
  return (
    <div className="flex flex-wrap gap-1.5 mb-3">
      {options.map(o => {
        const active = o.key === value
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            className={`px-2.5 py-1 text-xs font-semibold rounded border transition-colors ${
              active
                ? 'bg-portal-purple text-portal-cream border-portal-purple'
                : 'bg-white text-portal-purple-dark border-gray-300 hover:bg-gray-50'
            }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function PlayerRow({ player, cols, kind, splitKey }) {
  // When a split is active, source row values from player.splits[splitKey].
  // We still keep position/bats/throws/year from the player root.
  const valueSource = splitKey ? (player.splits?.[splitKey] || {}) : player
  return (
    <tr className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
      <td className="py-2 sticky left-0 bg-white z-10">
        <Link to={`/player/${player.player_id}`} className="text-portal-purple hover:underline font-medium">
          {player.first_name} {player.last_name}
        </Link>
        {player.position && (
          <span className="ml-1.5 text-[10px] text-gray-500">{player.position}</span>
        )}
      </td>
      <td className="py-2 text-gray-600 text-xs">
        {kind === 'hitter' ? (player.bats || '?') : (player.throws || '?')}
      </td>
      <td className="py-2 text-gray-600 text-xs">{player.year_in_school || '—'}</td>
      {cols.map(c => {
        const val = valueSource[c.key]
        const display = c.fmt ? c.fmt(val) : (val ?? '—')
        // Percentile coloring is only valid on the season view since the
        // baseline pool is the season-wide conference pool.
        const pctile = (!splitKey && c.pctileKey) ? pctileFor(player, c.pctileKey) : null
        const colorClass = c.muted
          ? 'text-gray-400'
          : (pctile != null ? COLOR_TEXT[colorForPctile(pctile)] : 'text-gray-800')
        return (
          <td
            key={c.key}
            className={`py-2 text-right font-mono ${colorClass}`}
            title={pctile != null ? `${Math.round(pctile)}th percentile in conference` : undefined}
          >
            {display}
          </td>
        )
      })}
    </tr>
  )
}


/* ============================================================
 * Card + Th + Chevron
 * ============================================================ */

function Card({ title, subtitle, children }) {
  return (
    <section className="bg-white border border-gray-200 rounded-xl shadow-sm p-4">
      {title && (
        <header className="mb-3">
          <h2 className="text-base font-semibold text-portal-purple-dark">{title}</h2>
          {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
        </header>
      )}
      {children}
    </section>
  )
}

function Th({ children, className = '' }) {
  return (
    <th className={`py-2 text-xs font-semibold uppercase tracking-wider text-gray-500 ${className}`}>
      {children}
    </th>
  )
}

function Chevron({ open }) {
  return (
    <span className={`inline-block transition-transform text-gray-400 ${open ? 'rotate-180' : ''}`}>▾</span>
  )
}
