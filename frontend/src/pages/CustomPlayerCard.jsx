/**
 * Custom Player Card builder — /portal/custom-card.
 *
 * Pick a player, then add / reorder / resize blocks (percentile bars, spray
 * charts, stat tables, splits, etc.) onto a single letter-size card. The whole
 * card auto-scales so everything always fits on ONE page — add more blocks and
 * the content shrinks. Export as a standard-size PDF or PNG.
 *
 * Reuses the existing player-card panels (exported from PlayerCardPDF.jsx) so
 * every block is the same visual we already ship on the fixed player card.
 */

import { useState, useRef, useLayoutEffect } from 'react'
import {
  usePlayer, usePlayerPitchLevelStats, usePlayerPitchLevelStatsPitcher, usePlayerSearch,
} from '../hooks/useApi'
import { usePortalTeam } from '../context/PortalTeamContext'
import { CURRENT_SEASON } from '../lib/seasons'
import ReportActions from '../components/ReportActions'
import {
  CardHeader, PercentilePanel, SprayPanel, DisciplinePanel, BattedBallPanel,
  SplitsPanel, CountStatesPanel, SeasonStatsTable, SummerBallTable,
  RecentKsPanel, VsTeamPanel,
} from './PlayerCardPDF'

const SEASON = CURRENT_SEASON
const PAGE_W = 816   // letter width @96dpi
const PAGE_H = 1056  // letter height @96dpi
const USABLE_H = 1030

// Block registry. `w` = default width. `render(ctx, cfg)` builds the panel.
const BLOCKS = {
  header:      { label: 'Header',           w: 'full', render: c => <CardHeader player={c.player} side={c.side} season={SEASON} /> },
  percentiles: { label: 'Percentile Bars',  w: 'half', render: c => <PercentilePanel side={c.side} battingPercentiles={c.data?.batting_percentiles} pitchingPercentiles={c.data?.pitching_percentiles} /> },
  spray:       { label: 'Spray Chart',      w: 'half', spray: true, render: (c, cfg) => <SprayPanel side={c.side} hitterPbp={c.hitterPbp} pitcherPbp={c.pitcherPbp} player={c.player} filter={cfg.filter || 'all'} /> },
  discipline:  { label: 'Plate Discipline', w: 'half', render: c => <DisciplinePanel side={c.side} hitterPbp={c.hitterPbp} pitcherPbp={c.pitcherPbp} /> },
  batted:      { label: 'Batted Ball',      w: 'half', render: c => <BattedBallPanel side={c.side} hitterPbp={c.hitterPbp} pitcherPbp={c.pitcherPbp} /> },
  splits:      { label: 'Splits',           w: 'half', render: c => <SplitsPanel side={c.side} hitterPbp={c.hitterPbp} pitcherPbp={c.pitcherPbp} /> },
  counts:      { label: 'Count States',     w: 'half', render: c => <CountStatesPanel side={c.side} hitterPbp={c.hitterPbp} pitcherPbp={c.pitcherPbp} /> },
  season:      { label: 'Season Stats',     w: 'full', render: c => <SeasonStatsTable side={c.side} battingStats={c.battingStats} pitchingStats={c.pitchingStats} /> },
  summer:      { label: 'Summer Ball',      w: 'full', render: c => <SummerBallTable side={c.side} summerBatting={c.summerBatting} summerPitching={c.summerPitching} /> },
  vsteam:      { label: 'vs Your Team',     w: 'half', render: c => <VsTeamPanel playerId={c.playerId} side={c.side} portalTeam={c.portalTeam} /> },
  recentk:     { label: 'Recent Ks',        w: 'half', render: c => <RecentKsPanel playerId={c.playerId} side={c.side} portalTeam={c.portalTeam} /> },
}
const PALETTE = Object.keys(BLOCKS)
const DEFAULT = ['header', 'percentiles', 'spray', 'discipline', 'batted', 'splits', 'counts', 'season']
  .map((type, i) => ({ uid: `d${i}`, type, w: BLOCKS[type].w, filter: type === 'spray' ? 'all' : undefined }))

const SPRAY_FILTERS_HIT = [['all', 'All'], ['vs_rhp', 'vs RHP'], ['vs_lhp', 'vs LHP'], ['xbh', 'XBH'], ['hr', 'HR']]
const SPRAY_FILTERS_PIT = [['all', 'All'], ['vs_rhb', 'vs RHB'], ['vs_lhb', 'vs LHB'], ['xbh', 'XBH'], ['hr', 'HR']]

let _uid = 100
const nextUid = () => `b${_uid++}`

export default function CustomPlayerCard() {
  const { team: portalTeam } = usePortalTeam()
  const [query, setQuery] = useState('')
  const [playerId, setPlayerId] = useState(null)
  const [sideParam, setSideParam] = useState(null)
  const [blocks, setBlocks] = useState(DEFAULT)

  const { data: results } = usePlayerSearch(query.length >= 2 ? query : '')
  const { data } = usePlayer(playerId)
  const { data: hitterPbp } = usePlayerPitchLevelStats(playerId, SEASON)
  const { data: pitcherPbp } = usePlayerPitchLevelStatsPitcher(playerId, SEASON)

  const pageRef = useRef(null)
  const contentRef = useRef(null)
  const [scale, setScale] = useState(1)

  // Auto-fit: shrink the content so the whole card stays on one page.
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
  }, [blocks, sideParam, playerId, data, hitterPbp, pitcherPbp])

  const player = data?.player
  const battingStats = Array.isArray(data?.batting_stats) ? data.batting_stats : []
  const pitchingStats = Array.isArray(data?.pitching_stats) ? data.pitching_stats : []
  const hasBatting = battingStats.length > 0
  const hasPitching = pitchingStats.length > 0
  const totBatWar = battingStats.reduce((s, r) => s + (r.offensive_war || 0), 0)
  const totPitWar = pitchingStats.reduce((s, r) => s + (r.pitching_war || 0), 0)
  const defaultSide = (hasBatting && hasPitching) ? (totPitWar > totBatWar ? 'pitching' : 'batting') : (hasPitching ? 'pitching' : 'batting')
  const side = sideParam || defaultSide

  const ctx = {
    player, side, data, hitterPbp, pitcherPbp, playerId, portalTeam,
    battingStats, pitchingStats,
    summerBatting: Array.isArray(data?.summer_batting) ? data.summer_batting : [],
    summerPitching: Array.isArray(data?.summer_pitching) ? data.summer_pitching : [],
  }
  const sprayFilters = side === 'pitching' ? SPRAY_FILTERS_PIT : SPRAY_FILTERS_HIT

  const addBlock = type => setBlocks(b => [...b, { uid: nextUid(), type, w: BLOCKS[type].w, filter: type === 'spray' ? 'all' : undefined }])
  const removeBlock = uid => setBlocks(b => b.filter(x => x.uid !== uid))
  const move = (i, d) => setBlocks(b => { const n = [...b]; const j = i + d; if (j < 0 || j >= n.length) return b;[n[i], n[j]] = [n[j], n[i]]; return n })
  const setW = (uid, w) => setBlocks(b => b.map(x => x.uid === uid ? { ...x, w } : x))
  const setFilter = (uid, filter) => setBlocks(b => b.map(x => x.uid === uid ? { ...x, filter } : x))

  return (
    <div className="max-w-full mx-auto px-3 sm:px-5 py-5">
      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-5 items-start">
        {/* ── Builder controls ── */}
        <div className="space-y-3 lg:sticky lg:top-3">
          <h1 className="text-lg font-bold text-portal-purple-dark dark:text-gray-100">Custom Player Card</h1>

          {/* Player search */}
          <div className="relative">
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search a player..."
              className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-nw-teal" />
            {query.length >= 2 && results?.length > 0 && !playerId && (
              <div className="absolute z-20 mt-1 w-full max-h-60 overflow-auto bg-white dark:bg-gray-800 border border-gray-200 rounded-lg shadow-lg">
                {results.slice(0, 12).map(p => (
                  <button key={p.id} onClick={() => { setPlayerId(p.id); setQuery(`${p.first_name} ${p.last_name}`); setSideParam(null) }}
                    className="block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-700">
                    {p.first_name} {p.last_name} <span className="text-xs text-gray-400">{p.team_short || p.team_name} · {p.position}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {playerId && (
            <button onClick={() => { setPlayerId(null); setQuery('') }} className="text-xs text-nw-teal hover:underline">Change player</button>
          )}

          {/* Side toggle */}
          {playerId && hasBatting && hasPitching && (
            <div className="inline-flex rounded-lg overflow-hidden border border-gray-300">
              {['batting', 'pitching'].map(s => (
                <button key={s} onClick={() => setSideParam(s)}
                  className={`px-3 py-1.5 text-sm font-medium capitalize ${side === s ? 'bg-portal-purple text-portal-cream' : 'bg-white dark:bg-gray-700 text-gray-600'}`}>{s}</button>
              ))}
            </div>
          )}

          {/* Palette */}
          <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3">
            <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500 mb-1.5">Add a block</div>
            <div className="flex flex-wrap gap-1.5">
              {PALETTE.map(type => (
                <button key={type} onClick={() => addBlock(type)}
                  className="px-2 py-1 text-xs rounded border border-gray-300 hover:bg-nw-teal/10 hover:border-nw-teal text-gray-700 dark:text-gray-300">
                  + {BLOCKS[type].label}
                </button>
              ))}
            </div>
          </div>

          {/* Selected blocks */}
          <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3">
            <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500 mb-1.5">Card layout ({blocks.length})</div>
            <div className="space-y-1.5">
              {blocks.map((b, i) => (
                <div key={b.uid} className="flex items-center gap-1.5 text-xs bg-gray-50 dark:bg-gray-700/40 rounded px-2 py-1">
                  <span className="flex-1 font-medium text-gray-700 dark:text-gray-200 truncate">{BLOCKS[b.type].label}</span>
                  {BLOCKS[b.type].spray && (
                    <select value={b.filter} onChange={e => setFilter(b.uid, e.target.value)}
                      className="text-[11px] border border-gray-300 rounded px-1 py-0.5">
                      {sprayFilters.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  )}
                  <button onClick={() => setW(b.uid, b.w === 'full' ? 'half' : 'full')}
                    className="px-1.5 py-0.5 rounded border border-gray-300 text-[10px] hover:bg-gray-100" title="Toggle width">
                    {b.w === 'full' ? 'Full' : 'Half'}
                  </button>
                  <button onClick={() => move(i, -1)} className="px-1 text-gray-500 hover:text-nw-teal" title="Up">▲</button>
                  <button onClick={() => move(i, 1)} className="px-1 text-gray-500 hover:text-nw-teal" title="Down">▼</button>
                  <button onClick={() => removeBlock(b.uid)} className="px-1 text-gray-400 hover:text-rose-600" title="Remove">✕</button>
                </div>
              ))}
              {!blocks.length && <div className="text-xs text-gray-400 italic">Add blocks from the palette above.</div>}
            </div>
          </div>

          {player && <ReportActions targetRef={pageRef} pdfFromCanvas
            filename={`card_${(player.last_name || 'player')}_${player.first_name || ''}_${side}`.replace(/\s+/g, '')} />}
        </div>

        {/* ── Live card (fixed one-page size, auto-fit) ── */}
        <div className="overflow-auto">
          <div ref={pageRef} className="custom-card-page bg-white mx-auto shadow border border-gray-200"
            style={{ width: `${PAGE_W}px`, height: `${PAGE_H}px`, overflow: 'hidden', position: 'relative' }}>
            {!playerId ? (
              <div className="p-8 text-gray-400 italic text-sm">Search and pick a player to start building a card.</div>
            ) : !player ? (
              <div className="p-8 text-gray-400 italic text-sm animate-pulse">Loading player…</div>
            ) : (
              <div ref={contentRef} style={{ width: `${PAGE_W}px`, transform: `scale(${scale})`, transformOrigin: 'top left', padding: '12px' }}>
                <div className="grid grid-cols-2 gap-2 items-start">
                  {blocks.map(b => (
                    <div key={b.uid} className={b.w === 'full' ? 'col-span-2' : 'col-span-1'}>
                      {BLOCKS[b.type].render(ctx, b)}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <p className="text-[11px] text-gray-400 mt-2 text-center">Card auto-scales to one letter page. The more blocks you add, the smaller everything gets.</p>
        </div>
      </div>
    </div>
  )
}
