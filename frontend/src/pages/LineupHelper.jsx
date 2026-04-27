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

import { Fragment, useState } from 'react'
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
      <Hero team={team} data={data} loading={loading} />

      {error && (
        <Card title="Couldn't load lineup">
          <p className="text-sm text-red-700">{error}</p>
        </Card>
      )}

      {loading && !data && <LoadingState />}

      {data && !data.error && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <LineupColumn vsHand="R" block={data.vs_RHP} />
          <LineupColumn vsHand="L" block={data.vs_LHP} />
        </div>
      )}

      {data && data.error && (
        <Card title="Not enough data yet">
          <p className="text-sm text-gray-700">{data.error}</p>
          <p className="text-xs text-gray-500 mt-2">
            We need 9 hitters with at least 30 plate appearances each. Check back
            once your team has more games played.
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

function LineupColumn({ vsHand, block }) {
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

  return (
    <div className="space-y-4">
      <Card title={label} subtitle={subtitle}>
        <LineupTable starters={block.starters} />
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

function LineupTable({ starters }) {
  const [expanded, setExpanded] = useState(() => new Set())
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
            <Th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {starters.map((s) => {
            const isOpen = expanded.has(s.player_id)
            return (
              <Fragment key={`${s.slot}-${s.player_id}`}>
                <tr className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer"
                    onClick={() => toggle(s.player_id)}>
                  <td className="py-2">
                    <span
                      className="inline-flex items-center justify-center w-7 h-7 rounded-full
                                 bg-portal-purple text-portal-cream text-xs font-bold"
                      title={SLOT_DESCRIPTIONS[s.slot]}
                    >
                      {s.slot}
                    </span>
                  </td>
                  <td className="py-2">
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
                  <td className="py-2">
                    <span className="inline-block px-1.5 py-0.5 rounded
                                     bg-gray-100 text-gray-800 text-xs font-mono">
                      {s.assigned_position}
                    </span>
                  </td>
                  <td className="py-2 text-gray-600">{s.bats || '?'}</td>
                  <td className="py-2 text-right font-mono">{fmt3(s.wOBA)}</td>
                  <td className="py-2 text-right font-mono">{fmtPct(s.K_pct)}</td>
                  <td className="py-2 text-right font-mono">{fmtPct(s.BB_pct)}</td>
                  <td className="py-2 text-right text-gray-500">{s.raw_pa}</td>
                  <td className="py-2 text-right">
                    <Chevron open={isOpen} />
                  </td>
                </tr>
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
  const season = entry.season_view || {}
  const form = entry.recent_form

  return (
    <div className="space-y-3">
      {reasoning && (
        <div className="text-sm">
          <span className="font-semibold text-portal-purple-dark">{reasoningLabel}: </span>
          <span className="text-gray-700">{reasoning}</span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatGroup title="Plate Discipline">
          <StatRow label="K%" value={fmtPct(entry.K_pct)} />
          <StatRow label="BB%" value={fmtPct(entry.BB_pct)} />
          <StatRow label="Contact%" value={fmtPct(pbp.contact_pct)} />
          <StatRow label="Swing%" value={fmtPct(pbp.swing_pct)} />
          <StatRow label="Whiff%" value={fmtPct(pbp.whiff_pct)} />
        </StatGroup>

        <StatGroup title="Power & Output">
          <StatRow label="wOBA" value={fmt3(entry.wOBA)} />
          <StatRow label="OBP" value={fmt3(entry.OBP)} />
          <StatRow label="SLG" value={fmt3(entry.SLG)} />
          <StatRow label="ISO" value={fmt3(pbp.iso)} />
          <StatRow label="HR%" value={fmtPct(pbp.hr_pct)} />
          <StatRow label="AIRPULL%" value={fmtPct(pbp.air_pull_pct)} />
        </StatGroup>

        <StatGroup title="Batted Ball">
          <StatRow label="GB%" value={fmtPct(pbp.gb_pct)} />
          <StatRow label="LD%" value={fmtPct(pbp.ld_pct)} />
          <StatRow label="FB%" value={fmtPct(pbp.fb_pct)} />
          <StatRow label="PU%" value={fmtPct(pbp.pu_pct)} />
          <StatRow label="Batted balls" value={pbp.bb_total ?? '—'} />
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


function StatGroup({ title, children }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-2.5">
      <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">
        {title}
      </h4>
      <div className="space-y-1">{children}</div>
    </div>
  )
}


function StatRow({ label, value }) {
  return (
    <div className="flex justify-between items-baseline text-xs">
      <span className="text-gray-600">{label}</span>
      <span className="font-mono text-gray-900">{value ?? '—'}</span>
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
 * Methodology / About card
 * ============================================================ */

function MethodologyCard() {
  return (
    <Card title="How this works" subtitle="The math behind the picks">
      <div className="text-sm text-gray-700 space-y-2 leading-relaxed">
        <p>
          The Lineup Helper picks the 9 starters and orders them based on
          modern sabermetric research, primarily The Book (Tango, Lichtman,
          and Dolphin). The headline rules: best three hitters at slots 1, 2,
          and 4. Slot 4 is the cleanup spot, slot 2 gets one of your top
          three, and slot 9 is treated as a "second leadoff" — a real OBP guy,
          not your worst bat.
        </p>
        <p>
          Stats are recency-weighted with a 6-week half-life, so a game from
          this week counts twice as much as a game from six weeks ago. Splits
          vs RHP and vs LHP are sample-regressed because most college players
          never reach the sample size where raw splits stabilize. A hitter
          with three hot vs-LHP at-bats won't get over-rewarded.
        </p>
        <p>
          Position eligibility: a player can be slotted at any position where
          they have eight or more starts this season. DH is open to anyone.
          The bench panel ranks the top five players who didn't make the
          starting nine, with each player tagged at their best position.
        </p>
        <p>
          The HOT and COLD badges compare the player's last 14 days of plate
          appearances to their season baseline. A 50-point or larger wOBA jump
          earns HOT. The same drop earns COLD. Players with fewer than 12 PAs
          in the window get no badge. The hot/cold signal is shown for context
          only — the optimizer itself uses the recency-weighted season profile,
          which already gives more weight to recent games.
        </p>
        <p>
          The italic reasoning under each starter explains the slot fit.
          Bench reasoning shows which starter beat them out at their best
          eligible position, and why.
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

function fmtPct(n) {
  if (n === null || n === undefined || isNaN(n)) return '—'
  return `${(n * 100).toFixed(1)}%`
}
