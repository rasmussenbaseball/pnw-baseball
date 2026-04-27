/**
 * Lineup Helper — Coaching & Scouting Portal page.
 *
 * Auto mode: optimal vs-RHP and vs-LHP lineups for the user's primary team,
 * with bench rankings. Pulls from /api/v1/coaching/lineup-helper.
 *
 * Methodology lives in backend/app/stats/split_stats.py and lineup_engine.py.
 * In short: time-weighted recency-decay (6-week half-life) on every PA,
 * sample-regressed splits (600 PA prior on wOBA, 60 on K%, 120 on BB%),
 * and modern sabermetric slot weights from The Book.
 */

import { Fragment, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { usePortalTeam } from '../context/PortalTeamContext'

const SEASON = 2026

const SLOT_DESCRIPTIONS = {
  1: 'Leadoff: contact and OBP, low K%',
  2: 'One of your three best hitters; OBP plus pop',
  3: 'Hits a lot of 2-out RISP — your worst of top 5',
  4: 'Cleanup: best power bat',
  5: 'Second power bat, drives in 3/4 holes',
  6: 'Mid-order continuation',
  7: 'Continuation, descending order',
  8: 'Defensive specialists, weaker bats',
  9: 'Second leadoff: real OBP guy, not the worst hitter',
}


export default function LineupHelper() {
  const { team } = usePortalTeam()

  const { data, loading, error } = useApi(
    '/coaching/lineup-helper',
    team?.id ? { team_id: team.id, season: SEASON } : {},
    [team?.id],
  )

  // Mode: 'auto' (optimized starters) or 'build' (user-picked 9)
  const [mode, setMode] = useState('auto')

  // Per-side custom lineups produced by user swaps (auto mode only).
  const [customRhp, setCustomRhp] = useState(null)
  const [customLhp, setCustomLhp] = useState(null)
  const [swapping, setSwapping] = useState(false)
  const [swapError, setSwapError] = useState(null)

  // Reset customizations when team changes
  const teamId = team?.id
  useEffect(() => {
    setCustomRhp(null)
    setCustomLhp(null)
    setSwapError(null)
  }, [teamId])

  // The block we actually display for each side (custom overrides auto).
  const rhpBlock = customRhp || data?.vs_RHP
  const lhpBlock = customLhp || data?.vs_LHP

  /**
   * Replace a starter with a bench player and re-optimize the order via
   * POST /coaching/lineup-helper/override. Affects only the side specified.
   */
  const performSwap = async ({ vsHand, slotPosition, newPlayerId }) => {
    if (!teamId) return
    const block = vsHand === 'R' ? rhpBlock : lhpBlock
    if (!block?.starters?.length) return
    setSwapping(true)
    setSwapError(null)
    // Build the new 9 starters: replace the player at `slotPosition` with newPlayerId
    const newAssignments = block.starters.map(s => ({
      player_id: s.assigned_position === slotPosition ? newPlayerId : s.player_id,
      position: s.assigned_position,
    }))
    try {
      const body = {
        team_id: teamId,
        season: SEASON,
        [vsHand === 'R' ? 'vs_RHP' : 'vs_LHP']: newAssignments,
      }
      const resp = await fetch('/api/v1/coaching/lineup-helper/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({}))
        throw new Error(detail.detail || `${resp.status} ${resp.statusText}`)
      }
      const result = await resp.json()
      if (vsHand === 'R') setCustomRhp(result.vs_RHP)
      else setCustomLhp(result.vs_LHP)
    } catch (e) {
      setSwapError(e.message)
    } finally {
      setSwapping(false)
    }
  }

  const resetSide = (vsHand) => {
    if (vsHand === 'R') setCustomRhp(null)
    else setCustomLhp(null)
    setSwapError(null)
  }

  if (!team) {
    return (
      <div className="max-w-7xl mx-auto px-3 sm:px-5 py-5">
        <Card title="Lineup Helper">
          <p className="text-sm text-gray-700">
            Pick a team in the header to see your optimized lineup.
          </p>
        </Card>
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-5 py-5 space-y-4">
      <Hero team={team} data={data} loading={loading || swapping} />

      <ModeTabs mode={mode} setMode={setMode} />

      {error && mode === 'auto' && (
        <Card title="Couldn't load lineup">
          <p className="text-sm text-red-700">{error}</p>
        </Card>
      )}

      {swapError && mode === 'auto' && (
        <Card title="Swap failed">
          <p className="text-sm text-red-700">{swapError}</p>
        </Card>
      )}

      {mode === 'auto' && loading && !data && <LoadingState />}

      {mode === 'auto' && data && !data.error && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <LineupColumn
            vsHand="R"
            block={rhpBlock}
            customized={!!customRhp}
            onSwap={performSwap}
            onReset={() => resetSide('R')}
            swapping={swapping}
          />
          <LineupColumn
            vsHand="L"
            block={lhpBlock}
            customized={!!customLhp}
            onSwap={performSwap}
            onReset={() => resetSide('L')}
            swapping={swapping}
          />
        </div>
      )}

      {mode === 'build' && <BuildView teamId={team.id} season={SEASON} />}

      {mode === 'auto' && data && data.error && (
        <Card title="Not enough data yet">
          <p className="text-sm text-gray-700">{data.error}</p>
          <p className="text-xs text-gray-500 mt-2">
            We need 9 hitters with at least 30 plate appearances each. Use
            "Build from scratch" instead if you want full control over the lineup.
          </p>
        </Card>
      )}

      <MethodologyCard />
    </div>
  )
}


/* ============================================================
 * Hero / header
 * ============================================================ */

function Hero({ team, data, loading }) {
  return (
    <section className="bg-portal-purple text-portal-cream rounded-xl px-5 py-4 shadow">
      <div className="flex items-center gap-4">
        {team?.logo_url && (
          <img
            src={team.logo_url}
            alt={`${team.name} logo`}
            className="w-12 h-12 object-contain bg-white rounded-md p-1"
          />
        )}
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Lineup Helper
          </h1>
          <p className="text-sm opacity-90">
            Optimal {SEASON} batting orders for{' '}
            <span className="font-semibold">{team?.short_name || team?.name}</span>
            {data && !data.error && data.eligible_count
              ? ` — ${data.eligible_count} eligible hitters`
              : ''}
          </p>
        </div>
        {loading && (
          <div className="text-xs opacity-70 italic">Optimizing...</div>
        )}
        {data?.as_of_date && !loading && (
          <div className="text-xs opacity-70">
            As of {data.as_of_date}
          </div>
        )}
      </div>
    </section>
  )
}


/* ============================================================
 * Lineup column (one per pitcher hand)
 * ============================================================ */

function LineupColumn({ vsHand, block, customized, onSwap, onReset, swapping }) {
  const label = vsHand === 'R' ? 'vs Right-Handed Pitching' : 'vs Left-Handed Pitching'
  const subtitle = vsHand === 'R'
    ? 'Most opponents will throw a RHP'
    : 'Use this when starting pitcher is a lefty'

  if (!block || block.error) {
    return (
      <Card title={label} subtitle={subtitle}>
        <p className="text-sm text-gray-700">
          {block?.error || 'No lineup available.'}
        </p>
      </Card>
    )
  }

  const titleNode = (
    <div className="flex items-center gap-2 flex-wrap">
      <span>{label}</span>
      {customized && (
        <span className="px-1.5 py-0.5 rounded bg-portal-accent/20 text-portal-accent text-[10px] font-bold uppercase tracking-wider">
          Custom
        </span>
      )}
      {customized && (
        <button
          type="button"
          onClick={onReset}
          className="text-[11px] text-portal-purple hover:underline"
        >
          Reset to optimal
        </button>
      )}
    </div>
  )

  return (
    <div className="space-y-4">
      <Card title={titleNode} subtitle={subtitle}>
        <LineupTable
          starters={block.starters}
          bench={block.bench || []}
          vsHand={vsHand}
          onSwap={onSwap}
          swapping={swapping}
        />
      </Card>
      <Card title="Top 5 bench options" subtitle="Ranked by best-slot fit">
        <BenchTable bench={block.bench || []} />
      </Card>
    </div>
  )
}


/* ============================================================
 * Lineup table
 * ============================================================ */

function LineupTable({ starters, bench = [], vsHand, onSwap, swapping }) {
  const [expanded, setExpanded] = useState(() => new Set())
  const [swapTarget, setSwapTarget] = useState(null)  // player_id whose row's swap menu is open
  const toggle = (pid) => setExpanded(prev => {
    const next = new Set(prev)
    next.has(pid) ? next.delete(pid) : next.add(pid)
    return next
  })

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left border-b border-gray-200">
            <Th className="w-10">#</Th>
            <Th>Player</Th>
            <Th className="w-12">Pos</Th>
            <Th className="w-8">B</Th>
            <Th className="w-16 text-right">wOBA</Th>
            <Th className="w-12 text-right">K%</Th>
            <Th className="w-12 text-right">BB%</Th>
            <Th className="w-12 text-right">PA</Th>
            <Th className="w-16 text-right">Actions</Th>
          </tr>
        </thead>
        <tbody>
          {starters.map((s) => {
            const isOpen = expanded.has(s.player_id)
            const isSwapping = swapTarget === s.player_id
            // Bench players who could replace this starter at this position
            const eligibleSubs = bench.filter(
              b => b.eligible_positions?.includes(s.assigned_position)
            )
            return (
              <Fragment key={`${s.slot}-${s.player_id}`}>
                <tr className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-2 cursor-pointer" onClick={() => toggle(s.player_id)}>
                    <span
                      className="inline-flex items-center justify-center w-7 h-7 rounded-full
                                 bg-portal-purple text-portal-cream text-xs font-bold"
                      title={SLOT_DESCRIPTIONS[s.slot]}
                    >
                      {s.slot}
                    </span>
                  </td>
                  <td className="py-2 cursor-pointer" onClick={() => toggle(s.player_id)}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link
                        to={`/players/${s.player_id}`}
                        className="text-portal-purple hover:underline font-medium"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {s.first_name} {s.last_name}
                      </Link>
                      <FormBadge form={s.recent_form} />
                    </div>
                  </td>
                  <td className="py-2 cursor-pointer" onClick={() => toggle(s.player_id)}>
                    <span className="inline-block px-1.5 py-0.5 rounded
                                     bg-gray-100 text-gray-800 text-xs font-mono">
                      {s.assigned_position}
                    </span>
                  </td>
                  <td className="py-2 text-gray-600 cursor-pointer" onClick={() => toggle(s.player_id)}>
                    {s.bats || '?'}
                  </td>
                  <td className="py-2 text-right font-mono cursor-pointer" onClick={() => toggle(s.player_id)}>
                    {fmt3(s.wOBA)}
                  </td>
                  <td className="py-2 text-right font-mono cursor-pointer" onClick={() => toggle(s.player_id)}>
                    {fmtPct(s.K_pct)}
                  </td>
                  <td className="py-2 text-right font-mono cursor-pointer" onClick={() => toggle(s.player_id)}>
                    {fmtPct(s.BB_pct)}
                  </td>
                  <td className="py-2 text-right text-gray-500 cursor-pointer" onClick={() => toggle(s.player_id)}>
                    {s.raw_pa}
                  </td>
                  <td className="py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          setSwapTarget(isSwapping ? null : s.player_id)
                        }}
                        disabled={swapping || eligibleSubs.length === 0}
                        title={eligibleSubs.length === 0
                          ? 'No bench players eligible at this position'
                          : 'Swap this player'}
                        className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider
                                   border border-portal-purple/40 rounded text-portal-purple
                                   hover:bg-portal-purple hover:text-white transition-colors
                                   disabled:opacity-30 disabled:hover:bg-transparent
                                   disabled:hover:text-portal-purple disabled:cursor-not-allowed"
                      >
                        Swap
                      </button>
                      <button
                        type="button"
                        onClick={() => toggle(s.player_id)}
                        className="text-gray-400 hover:text-gray-700 px-1"
                      >
                        <Chevron open={isOpen} />
                      </button>
                    </div>
                  </td>
                </tr>
                {isSwapping && (
                  <tr className="border-b border-gray-100 bg-portal-purple/5">
                    <td colSpan={9} className="px-3 py-3">
                      <SwapMenu
                        currentStarter={s}
                        eligibleSubs={eligibleSubs}
                        onPick={(newPid) => {
                          onSwap({
                            vsHand,
                            slotPosition: s.assigned_position,
                            newPlayerId: newPid,
                          })
                          setSwapTarget(null)
                        }}
                        onCancel={() => setSwapTarget(null)}
                      />
                    </td>
                  </tr>
                )}
                {isOpen && (
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <td colSpan={9} className="px-3 py-3">
                      <PlayerDetailPanel
                        entry={s}
                        reasoning={s.slot_reasoning}
                        reasoningLabel="Why this slot"
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}


/* ============================================================
 * Swap menu — bench candidates eligible at this position
 * ============================================================ */

function SwapMenu({ currentStarter, eligibleSubs, onPick, onCancel }) {
  if (!eligibleSubs.length) {
    return (
      <div className="flex items-center justify-between text-sm">
        <span className="text-gray-700">
          No bench players are eligible at <strong>{currentStarter.assigned_position}</strong>.
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-portal-purple hover:underline"
        >
          Close
        </button>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-600">
          Replace <strong>{currentStarter.first_name} {currentStarter.last_name}</strong>
          {' '}at <strong>{currentStarter.assigned_position}</strong> with:
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-portal-purple hover:underline"
        >
          Cancel
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {eligibleSubs.map(sub => (
          <button
            key={sub.player_id}
            type="button"
            onClick={() => onPick(sub.player_id)}
            className="text-left px-3 py-2 bg-white border border-gray-200 rounded-md
                       hover:border-portal-purple hover:bg-portal-purple/5 transition-colors"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-portal-purple-dark">
                {sub.first_name} {sub.last_name}
              </span>
              <span className="text-xs font-mono text-gray-500">
                {fmt3(sub.wOBA)} wOBA
              </span>
            </div>
            <div className="text-[11px] text-gray-500 mt-0.5">
              {sub.bats || '?'} · {sub.raw_pa} PA · best fit slot {sub.best_slot}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}


/* ============================================================
 * Bench table
 * ============================================================ */

function BenchTable({ bench }) {
  const [expanded, setExpanded] = useState(() => new Set())
  const toggle = (pid) => setExpanded(prev => {
    const next = new Set(prev)
    next.has(pid) ? next.delete(pid) : next.add(pid)
    return next
  })

  if (!bench.length) {
    return <p className="text-sm text-gray-500 italic">No bench depth.</p>
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left border-b border-gray-200">
            <Th className="w-8">#</Th>
            <Th>Player</Th>
            <Th className="w-16">Best Pos</Th>
            <Th className="w-8">B</Th>
            <Th className="w-16 text-right">wOBA</Th>
            <Th className="w-12 text-right">PA</Th>
            <Th className="w-16 text-right">Best Slot</Th>
            <Th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {bench.map((b, idx) => {
            const isOpen = expanded.has(b.player_id)
            return (
              <Fragment key={b.player_id}>
                <tr className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer"
                    onClick={() => toggle(b.player_id)}>
                  <td className="py-2 text-gray-500">{idx + 1}</td>
                  <td className="py-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link
                        to={`/players/${b.player_id}`}
                        className="text-portal-purple hover:underline font-medium"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {b.first_name} {b.last_name}
                      </Link>
                      <FormBadge form={b.recent_form} />
                    </div>
                  </td>
                  <td className="py-2">
                    <span className="inline-block px-1.5 py-0.5 rounded
                                     bg-gray-100 text-gray-800 text-xs font-mono">
                      {b.best_position}
                    </span>
                  </td>
                  <td className="py-2 text-gray-600">{b.bats || '?'}</td>
                  <td className="py-2 text-right font-mono">{fmt3(b.wOBA)}</td>
                  <td className="py-2 text-right text-gray-500">{b.raw_pa}</td>
                  <td className="py-2 text-right text-gray-600">#{b.best_slot}</td>
                  <td className="py-2 text-right">
                    <Chevron open={isOpen} />
                  </td>
                </tr>
                {isOpen && (
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <td colSpan={8} className="px-3 py-3">
                      <PlayerDetailPanel
                        entry={b}
                        reasoning={b.bench_reasoning}
                        reasoningLabel="Why on the bench"
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}


/* ============================================================
 * Expand chevron
 * ============================================================ */

function Chevron({ open }) {
  return (
    <span className={`inline-block transition-transform text-gray-400 ${open ? 'rotate-180' : ''}`}>
      ▾
    </span>
  )
}


/* ============================================================
 * Player detail panel — shown when a row is expanded
 * ============================================================ */

function PlayerDetailPanel({ entry, reasoning, reasoningLabel }) {
  const pbp = entry.pbp_stats || {}
  const speedInputs = entry.speed_inputs || {}
  const form = entry.recent_form

  return (
    <div className="space-y-3">
      {reasoning && (
        <div className="text-sm">
          <span className="font-semibold text-portal-purple-dark">{reasoningLabel}: </span>
          <span className="text-gray-700">{reasoning}</span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatGroup title="On-base & Power" subtitle="Used by the engine">
          <StatRow label="OBP" value={fmt3(entry.OBP)} highlight />
          <StatRow label="SLG" value={fmt3(entry.SLG)} highlight />
          <StatRow label="ISO" value={fmt3(entry.ISO)} highlight />
          <StatRow label="wOBA" value={fmt3(entry.wOBA)} muted />
          <StatRow label="HR%" value={fmtPct(pbp.hr_pct)} muted />
          <StatRow label="AIRPULL%" value={fmtPct(pbp.air_pull_pct)} muted />
        </StatGroup>

        <StatGroup title="Plate Discipline" subtitle="Used by the engine">
          <StatRow label="K%" value={fmtPct(entry.K_pct)} highlight />
          <StatRow label="BB%" value={fmtPct(entry.BB_pct)} highlight />
          <StatRow label="Contact%" value={fmtPct(entry.Contact_pct)} highlight />
          <StatRow label="Swing%" value={fmtPct(pbp.swing_pct)} muted />
          <StatRow label="Whiff%" value={fmtPct(pbp.whiff_pct)} muted />
        </StatGroup>

        <StatGroup title="Batted Ball" subtitle="GB% used by the engine">
          <StatRow label="GB%" value={fmtPct(entry.GB_pct)} highlight />
          <StatRow label="LD%" value={fmtPct(pbp.ld_pct)} muted />
          <StatRow label="FB%" value={fmtPct(pbp.fb_pct)} muted />
          <StatRow label="PU%" value={fmtPct(pbp.pu_pct)} muted />
          <StatRow label="Batted balls" value={pbp.bb_total ?? '—'} muted />
        </StatGroup>

        <StatGroup title="Speed (team-relative)" subtitle="Used by the engine">
          <StatRow label="Speed z-score" value={fmt2(entry.speed_z)} highlight />
          <StatRow label="SB" value={speedInputs.sb ?? '—'} muted />
          <StatRow label="CS" value={speedInputs.cs ?? '—'} muted />
          <StatRow label="Singles" value={speedInputs.singles ?? '—'} muted />
          <StatRow label="BB" value={speedInputs.walks ?? '—'} muted />
          <StatRow label="HBP" value={speedInputs.hbp ?? '—'} muted />
        </StatGroup>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 border-t border-gray-200">
        <div className="text-xs text-gray-600 pt-2">
          <span className="font-semibold">Recent form (last {form?.days || 14} days): </span>
          {form?.status === 'unknown' || !form?.recent_wOBA
            ? <span className="italic">not enough recent PAs</span>
            : (
              <span>
                {fmt3(form.recent_wOBA)} wOBA in {form.recent_pa} PA
                {' '}({form.delta_vs_season >= 0 ? '+' : ''}{form.delta_vs_season.toFixed(3)} vs season)
              </span>
            )}
        </div>
        <div className="text-xs text-gray-600 pt-2">
          <span className="font-semibold">Eligible positions: </span>
          {entry.eligible_positions?.length
            ? entry.eligible_positions.join(', ')
            : <span className="italic">DH only</span>}
        </div>
      </div>
    </div>
  )
}


function StatGroup({ title, subtitle, children }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-2.5">
      <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
        {title}
      </h4>
      {subtitle && (
        <div className="text-[9px] text-portal-purple/70 mb-1.5 italic">{subtitle}</div>
      )}
      <div className="space-y-1 mt-1">{children}</div>
    </div>
  )
}


function StatRow({ label, value, highlight = false, muted = false }) {
  const labelClass = muted ? 'text-gray-400' : 'text-gray-600'
  const valueClass = muted
    ? 'text-gray-400'
    : highlight
      ? 'text-portal-purple-dark font-semibold'
      : 'text-gray-900'
  return (
    <div className="flex justify-between items-baseline text-xs">
      <span className={labelClass}>{label}</span>
      <span className={`font-mono ${valueClass}`}>{value ?? '—'}</span>
    </div>
  )
}


/* ============================================================
 * Hot/Cold form badge
 * ============================================================ */

function FormBadge({ form }) {
  if (!form) return null
  const { status, recent_wOBA, delta_vs_season, recent_pa, days } = form
  if (status === 'unknown' || status === 'neutral') return null

  const isHot = status === 'hot'
  const className = isHot
    ? 'bg-orange-100 text-orange-800 border-orange-300'
    : 'bg-blue-100 text-blue-800 border-blue-300'
  const label = isHot ? 'HOT' : 'COLD'
  const sign = delta_vs_season >= 0 ? '+' : ''
  const tooltip =
    `Last ${days} days: ${recent_wOBA.toFixed(3).replace(/^0/, '')} wOBA in ${recent_pa} PA ` +
    `(${sign}${delta_vs_season.toFixed(3)} vs season).`

  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-bold tracking-wider ${className}`}
      title={tooltip}
    >
      {label}
    </span>
  )
}


/* ============================================================
 * Mode tabs (Optimized vs Build from scratch)
 * ============================================================ */

function ModeTabs({ mode, setMode }) {
  const tabClass = (active) =>
    `px-4 py-2 text-sm font-semibold rounded-md transition-colors ${
      active
        ? 'bg-portal-purple text-portal-cream'
        : 'bg-white text-portal-purple-dark border border-gray-200 hover:bg-gray-50'
    }`
  return (
    <div className="flex gap-2">
      <button type="button" className={tabClass(mode === 'auto')} onClick={() => setMode('auto')}>
        Optimized lineup
      </button>
      <button type="button" className={tabClass(mode === 'build')} onClick={() => setMode('build')}>
        Build from scratch
      </button>
    </div>
  )
}


/* ============================================================
 * Build mode — user picks 9 players + positions, we order them
 * ============================================================ */

const BUILD_POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH']

function BuildView({ teamId, season }) {
  const { data: roster, loading: rosterLoading } = useApi(
    `/teams/${teamId}/roster`,
    {},
    [teamId],
  )

  const [vsHand, setVsHand] = useState('R')
  // 9 rows; positions default to standard order, players empty.
  const [assignments, setAssignments] = useState(
    BUILD_POSITIONS.map(pos => ({ player_id: null, position: pos }))
  )
  const [building, setBuilding] = useState(false)
  const [buildError, setBuildError] = useState(null)
  const [result, setResult] = useState(null)

  // Reset when team changes
  useEffect(() => {
    setAssignments(BUILD_POSITIONS.map(pos => ({ player_id: null, position: pos })))
    setResult(null)
    setBuildError(null)
  }, [teamId])

  const updateRow = (idx, patch) => {
    setAssignments(prev => prev.map((a, i) => (i === idx ? { ...a, ...patch } : a)))
  }

  const usedPlayerIds = new Set(assignments.filter(a => a.player_id).map(a => a.player_id))
  const usedPositions = assignments.map(a => a.position)
  const allFilled = assignments.every(a => a.player_id && a.position)
  const positionsValid = new Set(usedPositions).size === 9
  const submitDisabled = !allFilled || !positionsValid || building

  const submit = async () => {
    setBuilding(true)
    setBuildError(null)
    try {
      const resp = await fetch('/api/v1/coaching/lineup-helper/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          team_id: teamId,
          season,
          vs_hand: vsHand,
          assignments,
        }),
      })
      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({}))
        throw new Error(detail.detail || `${resp.status} ${resp.statusText}`)
      }
      const data = await resp.json()
      setResult(data)
    } catch (e) {
      setBuildError(e.message)
      setResult(null)
    } finally {
      setBuilding(false)
    }
  }

  const block = result
    ? (vsHand === 'R' ? result.vs_RHP
       : vsHand === 'L' ? result.vs_LHP
       : result.vs_unknown)
    : null

  return (
    <div className="space-y-4">
      <Card
        title="Build your own 9"
        subtitle="Pick any player at any position. We'll find the optimal batting order."
      >
        <div className="space-y-3">
          {/* vs hand selector */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-portal-purple-dark">Optimize for:</span>
            <VsHandRadio value={vsHand} setValue={setVsHand} />
          </div>

          {/* 9 player rows */}
          <div className="border-t border-gray-200 pt-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {assignments.map((a, idx) => (
                <BuildRow
                  key={idx}
                  rowIdx={idx}
                  assignment={a}
                  roster={roster || []}
                  usedPlayerIds={usedPlayerIds}
                  usedPositions={usedPositions}
                  rosterLoading={rosterLoading}
                  onChange={(patch) => updateRow(idx, patch)}
                />
              ))}
            </div>
          </div>

          {!positionsValid && allFilled && (
            <p className="text-xs text-red-700">
              Each position must be used exactly once. Check the position dropdowns.
            </p>
          )}

          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={submit}
              disabled={submitDisabled}
              className="px-4 py-2 rounded-md bg-portal-purple text-portal-cream font-semibold
                         text-sm hover:bg-portal-purple-dark disabled:opacity-40
                         disabled:cursor-not-allowed transition-colors"
            >
              {building ? 'Optimizing...' : 'Build optimal order'}
            </button>
            {!allFilled && (
              <span className="text-xs text-gray-500">
                Fill all 9 spots to continue.
              </span>
            )}
          </div>
        </div>
      </Card>

      {buildError && (
        <Card title="Build failed">
          <p className="text-sm text-red-700">{buildError}</p>
        </Card>
      )}

      {block && (
        <Card
          title={`Optimal order — ${vsHandLabel(vsHand)}`}
          subtitle={`Total slot score: ${block.total_score?.toFixed(2) ?? '—'}`}
        >
          <LineupTable
            starters={block.starters}
            bench={[]}
            vsHand={vsHand}
            onSwap={null}
            swapping={false}
          />
        </Card>
      )}
    </div>
  )
}


function VsHandRadio({ value, setValue }) {
  const options = [
    { v: 'R', label: 'vs RHP' },
    { v: 'L', label: 'vs LHP' },
    { v: 'unknown', label: 'vs Unknown (overall splits)' },
  ]
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(o => (
        <button
          key={o.v}
          type="button"
          onClick={() => setValue(o.v)}
          className={`px-3 py-1 text-xs font-semibold rounded border transition-colors ${
            value === o.v
              ? 'bg-portal-purple text-portal-cream border-portal-purple'
              : 'bg-white text-portal-purple-dark border-gray-300 hover:bg-gray-50'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}


function BuildRow({ rowIdx, assignment, roster, usedPlayerIds, usedPositions, rosterLoading, onChange }) {
  const sortedRoster = [...roster].sort((a, b) =>
    (a.last_name || '').localeCompare(b.last_name || '')
  )
  return (
    <div className="flex items-center gap-2 p-2 bg-gray-50 rounded-md border border-gray-200">
      <span className="w-6 text-center text-xs font-bold text-gray-400">{rowIdx + 1}</span>
      <select
        value={assignment.player_id ?? ''}
        onChange={(e) => onChange({ player_id: e.target.value ? Number(e.target.value) : null })}
        className="flex-1 text-sm bg-white border border-gray-300 rounded px-2 py-1
                   focus:outline-none focus:ring-1 focus:ring-portal-purple"
      >
        <option value="">{rosterLoading ? 'Loading roster...' : 'Pick player...'}</option>
        {sortedRoster.map(p => (
          <option
            key={p.id}
            value={p.id}
            disabled={usedPlayerIds.has(p.id) && p.id !== assignment.player_id}
          >
            {p.last_name}, {p.first_name}
            {p.jersey_number ? ` (#${p.jersey_number})` : ''}
          </option>
        ))}
      </select>
      <select
        value={assignment.position ?? ''}
        onChange={(e) => onChange({ position: e.target.value || null })}
        className="text-sm bg-white border border-gray-300 rounded px-2 py-1 w-20
                   focus:outline-none focus:ring-1 focus:ring-portal-purple"
      >
        {BUILD_POSITIONS.map(p => (
          <option
            key={p}
            value={p}
            disabled={usedPositions.includes(p) && p !== assignment.position}
          >
            {p}
          </option>
        ))}
      </select>
    </div>
  )
}


function vsHandLabel(vsHand) {
  if (vsHand === 'R') return 'vs RHP'
  if (vsHand === 'L') return 'vs LHP'
  return 'vs Unknown (overall splits)'
}


/* ============================================================
 * Methodology / About card
 * ============================================================ */

function MethodologyCard() {
  return (
    <Card title="How this works" subtitle="The math behind the picks">
      <div className="text-sm text-gray-700 space-y-2 leading-relaxed">
        <p>
          The engine picks and orders the lineup using a 7-stat fitness score
          calibrated from The Book (Tango, Lichtman, Dolphin) and follow-on
          research by Lichtman, Carleton, and Petriello. The headline rule:
          your best on-base hitter goes in the 2-hole, not the cleanup spot.
          Putting the best hitter at #4 instead of #2 costs roughly 4 to 7
          runs over a college season. That is the single largest lever in
          lineup construction.
        </p>
        <p>
          Each slot weights stats differently. Slots 1 and 2 weight OBP most
          heavily. Slot 4 weights ISO (clean power, no contamination from
          singles). Slots 2 and 8 add a contact-rate bonus. Slots 2 and 3
          carry a ground-ball penalty above 45% to discourage double-play
          risk. Slots 1, 2, and 9 add a within-team speed-z bonus from
          (SB minus 0.5 times CS) divided by times-on-first-base.
        </p>
        <p>
          Sample regression: every rate stat is regressed toward the player's
          season baseline using the stat's stabilization PA count from
          Carleton's reliability work. K% pulls in 60 PAs, BB% in 120, ISO in
          160, SLG in 320, OBP in 460, wOBA in 600, Contact% in 100, GB% in
          110. A 5-PA vs-LHP sample with a 0% K rate gets pulled hard back to
          the player's season K%, and slot picks no longer get fooled by
          tiny-sample noise.
        </p>
        <p>
          Recency: every PA is weighted with a 6-week exponential decay. A
          game from this week counts twice as much as a game from six weeks
          ago. Recent at-bats genuinely move the engine.
        </p>
        <p>
          Position eligibility: a player can start at any position where they
          have 8 or more starts this season. DH is open to anyone. The HOT
          and COLD badges compare last-14-days wOBA to season wOBA, with a
          50-point threshold and a 12-PA minimum.
        </p>
        <p>
          The dropdown for each player shows every stat the engine actually
          uses (highlighted), plus the supporting context stats (muted). Hover
          a slot number to see the role of that slot.
        </p>
      </div>
    </Card>
  )
}


/* ============================================================
 * Card wrapper
 * ============================================================ */

function Card({ title, subtitle, children }) {
  return (
    <section className="bg-white border border-gray-200 rounded-xl shadow-sm p-4">
      {title && (
        <header className="mb-3">
          <h2 className="text-base font-semibold text-portal-purple-dark">
            {title}
          </h2>
          {subtitle && (
            <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>
          )}
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


/* ============================================================
 * Loading skeleton
 * ============================================================ */

function LoadingState() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {[0, 1].map(i => (
        <div key={i} className="space-y-4">
          <Card>
            <div className="space-y-2">
              {[...Array(9)].map((_, j) => (
                <div key={j} className="h-8 bg-gray-100 animate-pulse rounded" />
              ))}
            </div>
          </Card>
        </div>
      ))}
    </div>
  )
}


/* ============================================================
 * Formatting helpers
 * ============================================================ */

function fmt3(n) {
  if (n === null || n === undefined || isNaN(n)) return '—'
  return n.toFixed(3).replace(/^0/, '')
}

function fmt2(n) {
  if (n === null || n === undefined || isNaN(n)) return '—'
  const sign = n >= 0 ? '+' : ''
  return `${sign}${n.toFixed(2)}`
}

function fmtPct(n) {
  if (n === null || n === undefined || isNaN(n)) return '—'
  return `${(n * 100).toFixed(1)}%`
}
