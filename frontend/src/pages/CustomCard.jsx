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
} from './PlayerCardPDF'

export const SEASON = CURRENT_SEASON
export const PAGE_W = 816   // letter width @96dpi
export const PAGE_H = 1056  // letter height @96dpi
export const USABLE_H = 1030

// ── Block registry ──
// `w` = default width. `render(ctx, cfg)` builds the panel from the render
// context + this block's own config. `spray` marks blocks with a filter dropdown.
// `edit` names a config editor the builder shows (text / grades / measurables).
// `tag` groups blocks in the palette.
export const BLOCKS = {
  header:      { label: 'Header',           w: 'full', tag: 'Core',   render: c => <CardHeader player={c.player} side={c.side} season={SEASON} /> },
  percentiles: { label: 'Percentile Bars',  w: 'half', tag: 'Stats',  render: c => <PercentilePanel side={c.side} battingPercentiles={c.data?.batting_percentiles} pitchingPercentiles={c.data?.pitching_percentiles} /> },
  spray:       { label: 'Spray Chart',      w: 'half', tag: 'Charts', spray: true, render: (c, cfg) => <SprayPanel side={c.side} hitterPbp={c.hitterPbp} pitcherPbp={c.pitcherPbp} player={c.player} filter={cfg.filter || 'all'} /> },
  discipline:  { label: 'Plate Discipline', w: 'half', tag: 'Stats',  render: c => <DisciplinePanel side={c.side} hitterPbp={c.hitterPbp} pitcherPbp={c.pitcherPbp} /> },
  batted:      { label: 'Batted Ball',      w: 'half', tag: 'Stats',  render: c => <BattedBallPanel side={c.side} hitterPbp={c.hitterPbp} pitcherPbp={c.pitcherPbp} /> },
  splits:      { label: 'Splits',           w: 'half', tag: 'Stats',  render: c => <SplitsPanel side={c.side} hitterPbp={c.hitterPbp} pitcherPbp={c.pitcherPbp} /> },
  counts:      { label: 'Count States',     w: 'half', tag: 'Stats',  render: c => <CountStatesPanel side={c.side} hitterPbp={c.hitterPbp} pitcherPbp={c.pitcherPbp} /> },
  tendencies:  { label: 'How to Attack',    w: 'half', tag: 'Scouting', render: c => <TendenciesPanel side={c.side} data={c.data} hitterPbp={c.hitterPbp} pitcherPbp={c.pitcherPbp} /> },
  trend:       { label: 'Season Trend',     w: 'half', tag: 'Charts', render: c => <TrendPanel playerId={c.playerId} side={c.side} /> },
  season:      { label: 'Season Stats',     w: 'full', tag: 'Stats',  render: c => <SeasonStatsTable side={c.side} battingStats={c.battingStats} pitchingStats={c.pitchingStats} /> },
  summer:      { label: 'Summer Ball',      w: 'full', tag: 'Stats',  render: c => <SummerBallTable side={c.side} summerBatting={c.summerBatting} summerPitching={c.summerPitching} /> },
  vsteam:      { label: 'vs Your Team',     w: 'half', tag: 'Scouting', render: c => <VsTeamPanel playerId={c.playerId} side={c.side} portalTeam={c.portalTeam} /> },
  recentk:     { label: 'Recent Ks',        w: 'half', tag: 'Scouting', render: c => <RecentKsPanel playerId={c.playerId} side={c.side} portalTeam={c.portalTeam} /> },
  grades:      { label: 'Scouting Grades',  w: 'half', tag: 'Report', edit: 'grades', render: (c, cfg) => <GradesPanel side={c.side} cfg={cfg} /> },
  measurables: { label: 'Measurables',      w: 'half', tag: 'Report', edit: 'measurables', render: (c, cfg) => <MeasurablesPanel side={c.side} player={c.player} cfg={cfg} /> },
  scouttake:   { label: "Scout's Take",     w: 'full', tag: 'Report', edit: 'text', render: (c, cfg) => <ScoutTakePanel cfg={cfg} /> },
  notes:       { label: 'Notes (blank)',    w: 'half', tag: 'Report', edit: 'notes', render: (c, cfg) => <NotesLinesPanel cfg={cfg} /> },
}
export const PALETTE = Object.keys(BLOCKS)

// Palette groupings for the picker UI.
export const PALETTE_GROUPS = ['Core', 'Stats', 'Charts', 'Scouting', 'Report']

export const SPRAY_FILTERS_HIT = [['all', 'All'], ['vs_rhp', 'vs RHP'], ['vs_lhp', 'vs LHP'], ['xbh', 'XBH'], ['hr', 'HR']]
export const SPRAY_FILTERS_PIT = [['all', 'All'], ['vs_rhb', 'vs RHB'], ['vs_lhb', 'vs LHB'], ['xbh', 'XBH'], ['hr', 'HR']]

// Default 8-block layout used when the builder first loads.
export const DEFAULT_BLOCKS = ['header', 'percentiles', 'spray', 'discipline', 'batted', 'splits', 'counts', 'season']
  .map(type => ({ type, w: BLOCKS[type].w, ...(type === 'spray' ? { filter: 'all' } : {}) }))

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
          <div className="grid grid-cols-2 gap-2 items-start">
            {(blocks || []).map((b, i) => (
              <div key={b.uid || `${b.type}-${i}`} className={b.w === 'full' ? 'col-span-2' : 'col-span-1'}>
                {BLOCKS[b.type] ? BLOCKS[b.type].render(ctx, b) : null}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
