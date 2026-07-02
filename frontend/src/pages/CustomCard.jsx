/**
 * CustomCard — the reusable, render-only custom player card.
 *
 * Given a playerId, a block layout, and a side, it fetches the player's data,
 * builds the shared render context, lays the blocks out on a fixed letter-size
 * page (816×1056), and auto-scales the content so everything fits on ONE page.
 *
 * Both the builder (CustomPlayerCard.jsx, live preview) and the bulk generator
 * (BulkPlayerCards.jsx, one card per roster player) render this component, so a
 * template built in the builder prints identically in a 30-card batch.
 *
 * The block registry (BLOCKS) lives here too so every surface shares one source
 * of truth for what a "block" is.
 */

import { useState, useRef, useLayoutEffect, useEffect } from 'react'
import {
  usePlayer, usePlayerPitchLevelStats, usePlayerPitchLevelStatsPitcher,
} from '../hooks/useApi'
import { usePortalTeam } from '../context/PortalTeamContext'
import { CURRENT_SEASON } from '../lib/seasons'
import {
  CardHeader, PercentilePanel, SprayPanel, DisciplinePanel, BattedBallPanel,
  SplitsPanel, CountStatesPanel, SeasonStatsTable, SummerBallTable,
  RecentKsPanel, VsTeamPanel,
  ScoutTakePanel, GradesPanel, MeasurablesPanel,
  TendenciesPanel, TrendPanel, NotesLinesPanel,
  FieldingGridPanel, FieldingDiagramPanel, TTOPanel, CountDetailPanel,
  VsElitePanel, BenchPanel, PitchMixPanel,
} from './PlayerCardPDF'

export const SEASON = CURRENT_SEASON
export const PAGE_W = 816   // letter width @96dpi
export const PAGE_H = 1056  // letter height @96dpi
export const USABLE_H = 1030

// ── Block registry ──
// `w` = default width. `render(ctx, cfg)` builds the panel from the render
// context + this block's own config. `spray` marks blocks with a filter dropdown.
// `edit` names a config editor the builder shows (text / grades / measurables).
// `tag` groups blocks in the palette. `for` limits a block to one player type
// ('hitter' | 'pitcher' | 'both') so the palette only offers what makes sense.
export const BLOCKS = {
  header:      { label: 'Header',           w: 'full', tag: 'Core',   for: 'both', render: c => <CardHeader player={c.player} side={c.side} season={SEASON} /> },
  percentiles: { label: 'Percentile Bars',  w: 'half', tag: 'Stats',  for: 'both', render: c => <PercentilePanel side={c.side} battingPercentiles={c.data?.batting_percentiles} pitchingPercentiles={c.data?.pitching_percentiles} /> },
  spray:       { label: 'Spray Chart',      w: 'half', tag: 'Charts', for: 'both', spray: true, render: (c, cfg) => <SprayPanel side={c.side} hitterPbp={c.hitterPbp} pitcherPbp={c.pitcherPbp} player={c.player} filter={cfg.filter || 'all'} /> },
  discipline:  { label: 'Plate Discipline', w: 'quarter', tag: 'Stats',  for: 'both', render: c => <DisciplinePanel side={c.side} hitterPbp={c.hitterPbp} pitcherPbp={c.pitcherPbp} /> },
  batted:      { label: 'Batted Ball',      w: 'quarter', tag: 'Stats',  for: 'both', render: c => <BattedBallPanel side={c.side} hitterPbp={c.hitterPbp} pitcherPbp={c.pitcherPbp} /> },
  splits:      { label: 'Splits',           w: 'quarter', tag: 'Stats',  for: 'both', render: c => <SplitsPanel side={c.side} hitterPbp={c.hitterPbp} pitcherPbp={c.pitcherPbp} /> },
  counts:      { label: 'Count States',     w: 'quarter', tag: 'Stats',  for: 'both', render: c => <CountStatesPanel side={c.side} hitterPbp={c.hitterPbp} pitcherPbp={c.pitcherPbp} /> },
  countdetail: { label: 'Count States (detail)', w: 'half', tag: 'Stats', for: 'both', render: c => <CountDetailPanel side={c.side} playerId={c.playerId} /> },
  tto:         { label: 'Times Thru Order', w: 'half', tag: 'Stats',  for: 'pitcher', render: c => <TTOPanel playerId={c.playerId} /> },
  velite:      { label: 'vs Elite Pitching', w: 'quarter', tag: 'Stats', for: 'hitter', render: c => <VsElitePanel playerId={c.playerId} /> },
  bench:       { label: 'Off the Bench',    w: 'quarter', tag: 'Stats',  for: 'hitter', render: c => <BenchPanel playerId={c.playerId} /> },
  tendencies:  { label: 'How to Attack',    w: 'half', tag: 'Scouting', for: 'both', render: c => <TendenciesPanel side={c.side} data={c.data} hitterPbp={c.hitterPbp} pitcherPbp={c.pitcherPbp} /> },
  trend:       { label: 'Season Trend',     w: 'half', tag: 'Charts', for: 'both', render: c => <TrendPanel playerId={c.playerId} side={c.side} /> },
  fieldgrid:   { label: 'Ideal Fielding — Grid',  w: 'half', tag: 'Defense', for: 'hitter', render: c => <FieldingGridPanel playerId={c.playerId} /> },
  fielddiagram:{ label: 'Ideal Fielding — Field', w: 'half', tag: 'Defense', for: 'hitter', render: c => <FieldingDiagramPanel playerId={c.playerId} player={c.player} hitterPbp={c.hitterPbp} /> },
  season:      { label: 'Season Stats',     w: 'full', tag: 'Stats',  for: 'both', render: c => <SeasonStatsTable side={c.side} battingStats={c.battingStats} pitchingStats={c.pitchingStats} /> },
  summer:      { label: 'Summer Ball',      w: 'full', tag: 'Stats',  for: 'both', render: c => <SummerBallTable side={c.side} summerBatting={c.summerBatting} summerPitching={c.summerPitching} /> },
  vsteam:      { label: 'vs Your Team',     w: 'half', tag: 'Scouting', for: 'both', render: c => <VsTeamPanel playerId={c.playerId} side={c.side} portalTeam={c.portalTeam} /> },
  recentk:     { label: 'Recent Ks',        w: 'half', tag: 'Scouting', for: 'both', render: c => <RecentKsPanel playerId={c.playerId} side={c.side} portalTeam={c.portalTeam} /> },
  grades:      { label: 'Scouting Grades',  w: 'half', tag: 'Report', for: 'both', edit: 'grades', render: (c, cfg) => <GradesPanel side={c.side} cfg={cfg} /> },
  measurables: { label: 'Measurables',      w: 'half', tag: 'Report', for: 'both', edit: 'measurables', render: (c, cfg) => <MeasurablesPanel side={c.side} player={c.player} cfg={cfg} /> },
  pitchmix:    { label: 'Pitch Mix (blank)', w: 'quarter', tag: 'Report', for: 'both', edit: 'pitchmix', render: (c, cfg) => <PitchMixPanel cfg={cfg} /> },
  scouttake:   { label: "Scout's Take",     w: 'full', tag: 'Report', for: 'both', edit: 'text', render: (c, cfg) => <ScoutTakePanel cfg={cfg} /> },
  notes:       { label: 'Notes (blank)',    w: 'half', tag: 'Report', for: 'both', edit: 'notes', render: (c, cfg) => <NotesLinesPanel cfg={cfg} /> },
}
export const PALETTE = Object.keys(BLOCKS)

// Palette groupings for the picker UI.
export const PALETTE_GROUPS = ['Core', 'Stats', 'Charts', 'Defense', 'Scouting', 'Report']

// Grid is 4 columns wide. Map a block width to its column span.
export const WIDTHS = ['quarter', 'half', 'full']
export const WIDTH_SPAN = { quarter: 'col-span-1', half: 'col-span-2', full: 'col-span-4' }
export const WIDTH_LABEL = { quarter: '¼', half: '½', full: 'Full' }
export const nextWidth = w => WIDTHS[(WIDTHS.indexOf(w) + 1) % WIDTHS.length]

// Does a block belong on this side's card? 'both' always; otherwise match.
export function blockFitsSide(type, side) {
  const f = BLOCKS[type]?.for || 'both'
  if (f === 'both') return true
  return f === (side === 'pitching' ? 'pitcher' : 'hitter')
}

export const SPRAY_FILTERS_HIT = [['all', 'All'], ['vs_rhp', 'vs RHP'], ['vs_lhp', 'vs LHP'], ['xbh', 'XBH'], ['hr', 'HR']]
export const SPRAY_FILTERS_PIT = [['all', 'All'], ['vs_rhb', 'vs RHB'], ['vs_lhb', 'vs LHB'], ['xbh', 'XBH'], ['hr', 'HR']]

// Default 8-block layout used when the builder first loads. Widths chosen to
// fill the page: percentiles + spray share a row, the four stat blocks pack
// into a single quarter-width row, season line spans full.
export const DEFAULT_BLOCKS = [
  { type: 'header', w: 'full' },
  { type: 'percentiles', w: 'half' },
  { type: 'spray', w: 'half', filter: 'all' },
  { type: 'discipline', w: 'quarter' },
  { type: 'batted', w: 'quarter' },
  { type: 'splits', w: 'quarter' },
  { type: 'counts', w: 'quarter' },
  { type: 'season', w: 'full' },
]

let _uid = 100
export const nextUid = () => `b${_uid++}`
// Give a stored template's block list fresh uids for live editing.
export const withUids = (blocks) => (blocks || []).map(b => ({ uid: nextUid(), ...b }))

// Derive the default side (which stat line to show) from career WAR, matching
// the fixed player card. sideParam of 'batting'/'pitching' forces it.
export function resolveSide(data, sideParam) {
  if (sideParam === 'batting' || sideParam === 'pitching') return sideParam
  const bs = Array.isArray(data?.batting_stats) ? data.batting_stats : []
  const ps = Array.isArray(data?.pitching_stats) ? data.pitching_stats : []
  const hasBat = bs.length > 0, hasPit = ps.length > 0
  if (hasBat && hasPit) {
    const bw = bs.reduce((s, r) => s + (r.offensive_war || 0), 0)
    const pw = ps.reduce((s, r) => s + (r.pitching_war || 0), 0)
    return pw > bw ? 'pitching' : 'batting'
  }
  return hasPit ? 'pitching' : 'batting'
}


/**
 * The render-only card. Fetches its own data so it can be dropped into a bulk
 * loop (each instance independent). Reports {player, side, hasBatting,
 * hasPitching} back via onMeta so a parent builder can render its controls
 * without re-fetching.
 */
export function CustomCard({ playerId, blocks, sideParam, cardRef, onMeta, className = '' }) {
  const { team: portalTeam } = usePortalTeam()
  const { data } = usePlayer(playerId)
  const { data: hitterPbp } = usePlayerPitchLevelStats(playerId, SEASON)
  const { data: pitcherPbp } = usePlayerPitchLevelStatsPitcher(playerId, SEASON)

  const contentRef = useRef(null)
  const [scale, setScale] = useState(1)

  const player = data?.player
  const battingStats = Array.isArray(data?.batting_stats) ? data.batting_stats : []
  const pitchingStats = Array.isArray(data?.pitching_stats) ? data.pitching_stats : []
  const hasBatting = battingStats.length > 0
  const hasPitching = pitchingStats.length > 0
  const side = resolveSide(data, sideParam)

  // Auto-fit: shrink content so the whole card stays on one page. Transform
  // doesn't change scrollHeight, so measurement stays stable across scales.
  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return
    const measure = () => {
      const h = el.scrollHeight
      setScale(h > USABLE_H ? USABLE_H / h : 1)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [blocks, side, playerId, data, hitterPbp, pitcherPbp])

  // Report metadata up to a parent builder.
  useEffect(() => {
    if (onMeta) onMeta({ player, side, hasBatting, hasPitching })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player?.id, side, hasBatting, hasPitching])

  const ctx = {
    player, side, data, hitterPbp, pitcherPbp, playerId, portalTeam,
    battingStats, pitchingStats,
    summerBatting: Array.isArray(data?.summer_batting) ? data.summer_batting : [],
    summerPitching: Array.isArray(data?.summer_pitching) ? data.summer_pitching : [],
  }

  return (
    <div ref={cardRef} className={`custom-card-page bg-white mx-auto shadow border border-gray-200 ${className}`}
      style={{ width: `${PAGE_W}px`, height: `${PAGE_H}px`, overflow: 'hidden', position: 'relative' }}>
      {!player ? (
        <div className="p-8 text-gray-400 italic text-sm animate-pulse">Loading player…</div>
      ) : (
        <div ref={contentRef} style={{ width: `${PAGE_W}px`, transform: `scale(${scale})`, transformOrigin: 'top left', padding: '12px' }}>
          {/* items-stretch + [&>*]:h-full make every block in a row the same
              height (its panel fills the tallest cell), so blocks tile into
              clean bands instead of leaving ragged gaps under the short one. */}
          <div className="grid grid-cols-4 gap-2 items-stretch">
            {(blocks || []).filter(b => BLOCKS[b.type] && blockFitsSide(b.type, side)).map((b, i) => (
              <div key={b.uid || `${b.type}-${i}`} className={`${WIDTH_SPAN[b.w] || 'col-span-2'} [&>*]:h-full`}>
                {BLOCKS[b.type].render(ctx, b)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
