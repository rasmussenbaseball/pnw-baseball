/**
 * Team Stats page — compares the user's team to the rest of the conference
 * and the rest of NAIA. Pulls:
 *   - Real stats from save.playerStats for the user's team
 *   - Synthesized stats for every other team (driven by ratings + games)
 *
 * Top tabs: My Team, Conference, NAIA.
 * National leaders section at the bottom for all-NAIA top-X tables.
 *
 * NOTE: synthesized stats are deterministic per (year, playerId, seed) so
 * the numbers are stable across re-renders. We rebuild them on demand when
 * the user opens the page rather than storing in the save — keeps save size
 * small and lets the synthesis evolve with rating changes.
 */

import { useMemo, useState } from 'react'
import { useSearchParams, Navigate, Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty } from '../../gm/engine/save'
import { ensureUnifiedCalendar } from '../../gm/engine/gameYear'
import { displayPosition } from '../../gm/engine/format'
import { synthesizeLeagueStats, synthesizeConferenceStats, aggregateTeamStats, synthesizeTeamStats } from '../../gm/engine/leagueStats'
import { leagueAverages, computeBatting, computePitching, fmtRate, fmt2, fmtWar } from '../../gm/engine/advancedStats'
import GMShell, { PixelCard } from '../../gm/components/GMShell'
import SortableHeader, { useTableSort } from '../../gm/components/SortableHeader'
import PixelHeadshot from '../../gm/components/PixelHeadshot'

const TABS = [
  { key: 'comparison', label: 'Team Comparison' },
  { key: 'national',   label: 'National Leaders' },
]

export default function TeamStats() {
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const tab = params.get('tab') || 'comparison'
  const userId = user?.id || 'guest'

  const save = useMemo(() => {
    const s = loadDynasty(userId, slot)
    if (s) ensureUnifiedCalendar(s)
    return s
  }, [userId, slot])
  if (!save) return <Navigate to="/gm" replace />

  const school = save.schools[save.userSchoolId]
  const team = save.teams[save.userSchoolId]
  const conf = save.conferences[school.conferenceId]
  const accent = school.colors?.[0] || '#fbbf24'
  const year = save.calendar?.year

  // Advanced stats (wOBA, wRC+, oWAR, FIP, xFIP, pWAR) gated behind the
  // Data Analytics Manager hire.
  const hasAnalyticsMgr = (team?.assistantCoachIds || []).some(id => {
    const c = save.coaches?.[id]
    return c?.role === 'DATA_ANALYTICS_MANAGER'
  })

  function setTab(t) {
    const next = new URLSearchParams(params)
    next.set('tab', t)
    setParams(next, { replace: true })
  }

  // Stats only make sense once the season has started + games are on the
  // books. Pre-season we'd be showing synthesized "what we'd expect" stats
  // which confuses the user (numbers that look real but aren't).
  const totalRegularGamesPlayed = (save.schedule || [])
    .filter(g => g.played && (g.type === 'CONFERENCE' || g.type === 'NON_CONFERENCE' || g.type === 'D1_MIDWEEK'))
    .length
  const seasonStarted = totalRegularGamesPlayed > 0

  // Synthesize league-wide stats once per render. Memoized off the player
  // count so we re-synthesize when rosters change but not on every keystroke.
  // Skip the expensive synth pass entirely when the season hasn't started.
  const seed = save.seed || save.rngSeed || 1
  const leagueStats = useMemo(
    () => seasonStarted ? synthesizeLeagueStats(save, year, seed) : {},
    [save, year, seed, seasonStarted],
  )

  if (!seasonStarted) {
    return (
      <GMShell schoolName={school.name} schoolColors={school.colors}>
        <div className="mb-4">
          <h1 className="font-pixel-display text-xl tracking-widest text-white mb-1">TEAM STATS</h1>
          <p className="font-pixel text-base text-[#a8a8c8]">{school.name} · {year} season</p>
        </div>
        <div className="bg-[#1a1a2e] border-2 border-[#3a3a5e] rounded-lg p-8 text-center">
          <div className="text-amber-300 font-pixel-display text-base tracking-widest mb-2 uppercase">
            Season hasn't started yet
          </div>
          <div className="text-[#a8a8c8] text-sm max-w-md mx-auto font-pixel leading-relaxed">
            Team / national / conference stats populate once you start playing
            regular-season games (Spring, Wk 27+). Fall scrimmages don't count
            toward stats — they're development reps only.
          </div>
        </div>
      </GMShell>
    )
  }

  return (
    <GMShell schoolName={school.name} schoolColors={school.colors}>
      <div className="mb-4">
        <h1 className="font-pixel-display text-xl tracking-widest text-white mb-1">TEAM STATS</h1>
        <p className="font-pixel text-base text-[#a8a8c8]">
          {school.name} · {year} season · vs {conf.name} · vs NAIA
        </p>
      </div>

      {!hasAnalyticsMgr && <TSAnalyticsGate slot={slot} />}

      <div className="flex gap-2 mb-4">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={
              'font-pixel-display text-[10px] tracking-widest px-3 py-2 border-4 transition ' +
              (tab === t.key ? 'text-[#1a1a2e]' : 'border-[#3a3a5e] text-[#e8e8e8] hover:text-white')
            }
            style={tab === t.key ? { backgroundColor: accent, borderColor: accent } : {}}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'comparison' && (
        <ComparisonView save={save} leagueStats={leagueStats} year={year} accent={accent} slot={slot} hasAnalyticsMgr={hasAnalyticsMgr} />
      )}
      {tab === 'national' && (
        <NationalLeadersView save={save} leagueStats={leagueStats} accent={accent} slot={slot} hasAnalyticsMgr={hasAnalyticsMgr} />
      )}
    </GMShell>
  )
}

// ─── Team comparison view ───────────────────────────────────────────────────

function ComparisonView({ save, leagueStats, year, accent, slot, hasAnalyticsMgr }) {
  const lg = useMemo(() => leagueAverages({ playerStats: leagueStats }), [leagueStats])
  const team = save.teams[save.userSchoolId]
  const school = save.schools[save.userSchoolId]
  const conf = save.conferences[school.conferenceId]
  const userRoster = team.rosterPlayerIds || []
  const userTotals = aggregateTeamStats(userRoster, leagueStats)

  // Conference totals — sum all conf teams' player rows, then average
  const confTotals = aggregateAllTeamsInIds(
    leagueStats, save, (conf?.schoolIds || []),
  )
  const naiaTotals = aggregateAllTeamsInIds(
    leagueStats, save, Object.keys(save.teams || {}),
  )
  const numConfTeams = conf?.schoolIds?.length || 1
  const numNaiaTeams = Object.keys(save.teams || {}).length || 1

  // Build per-team rows for the bottom sortable comparison table
  const teamRows = useMemo(() => {
    return Object.keys(save.teams || {}).map(tid => {
      const t = save.teams[tid]
      const s = save.schools[tid]
      const tt = aggregateTeamStats(t.rosterPlayerIds || [], leagueStats)
      const avg = safe(tt.h, tt.ab)
      const obp = safe(tt.h + tt.bb + tt.hbp, tt.ab + tt.bb + tt.hbp + tt.sf)
      const slg = safe(tb(tt), tt.ab)
      const ip = (tt.outs || 0) / 3
      const era = ip > 0 ? safe(tt.p_er * 9, ip) : 0
      const fip = ip > 0
        ? (13 * tt.p_hr + 3 * (tt.p_bb + tt.p_hbp) - 2 * tt.p_k) / ip + (lg?.fipConstant || 3.1)
        : 0
      return {
        teamId: tid,
        schoolName: s?.name || tid,
        confAbbr: save.conferences[s?.conferenceId]?.abbreviation || '',
        record: `${t.wins || 0}-${t.losses || 0}`,
        runDiff: t.runDiff || 0,
        avg, obp, slg, ops: obp + slg,
        hr: tt.hr,
        era, fip,
        k_per_9: ip > 0 ? safe(tt.p_k * 9, ip) : 0,
        whip: ip > 0 ? safe(tt.p_h + tt.p_bb, ip) : 0,
        isUser: tid === save.userSchoolId,
        isConf: (conf?.schoolIds || []).includes(tid),
      }
    })
  }, [save, leagueStats, lg, conf])

  return (
    <div className="space-y-4">
      <PixelCard accent={accent} title="HITTING — YOUR TEAM VS CONFERENCE VS NAIA">
        <ComparisonRow
          label="AVG"  user={safe(userTotals.h, userTotals.ab)}
          conf={safe(confTotals.h, confTotals.ab)}
          naia={safe(naiaTotals.h, naiaTotals.ab)}
          fmt={fmtRate}
        />
        <ComparisonRow
          label="OBP"  user={safe(userTotals.h + userTotals.bb + userTotals.hbp, userTotals.ab + userTotals.bb + userTotals.hbp + userTotals.sf)}
          conf={safe(confTotals.h + confTotals.bb + confTotals.hbp, confTotals.ab + confTotals.bb + confTotals.hbp + confTotals.sf)}
          naia={safe(naiaTotals.h + naiaTotals.bb + naiaTotals.hbp, naiaTotals.ab + naiaTotals.bb + naiaTotals.hbp + naiaTotals.sf)}
          fmt={fmtRate}
        />
        <ComparisonRow
          label="SLG" user={safe(tb(userTotals), userTotals.ab)}
          conf={safe(tb(confTotals), confTotals.ab)}
          naia={safe(tb(naiaTotals), naiaTotals.ab)}
          fmt={fmtRate}
        />
        <ComparisonRow
          label="HR" user={userTotals.hr}
          conf={Math.round(confTotals.hr / numConfTeams)}
          naia={Math.round(naiaTotals.hr / numNaiaTeams)}
          fmt={v => String(v)}
        />
        <ComparisonRow
          label="K%" user={safe(userTotals.k, userTotals.pa)}
          conf={safe(confTotals.k, confTotals.pa)}
          naia={safe(naiaTotals.k, naiaTotals.pa)}
          fmt={v => (v * 100).toFixed(1) + '%'}
        />
        <ComparisonRow
          label="BB%" user={safe(userTotals.bb, userTotals.pa)}
          conf={safe(confTotals.bb, confTotals.pa)}
          naia={safe(naiaTotals.bb, naiaTotals.pa)}
          fmt={v => (v * 100).toFixed(1) + '%'}
        />
      </PixelCard>

      <PixelCard accent={accent} title="PITCHING — YOUR TEAM VS CONFERENCE VS NAIA">
        <ComparisonRow
          label="ERA" user={era(userTotals)}
          conf={era(confTotals)}
          naia={era(naiaTotals)}
          fmt={fmt2} lowerIsBetter
        />
        <ComparisonRow
          label="WHIP" user={whip(userTotals)}
          conf={whip(confTotals)}
          naia={whip(naiaTotals)}
          fmt={fmt2} lowerIsBetter
        />
        <ComparisonRow
          label="K/9" user={k9(userTotals)}
          conf={k9(confTotals)}
          naia={k9(naiaTotals)}
          fmt={v => v.toFixed(1)}
        />
        <ComparisonRow
          label="BB/9" user={bb9(userTotals)}
          conf={bb9(confTotals)}
          naia={bb9(naiaTotals)}
          fmt={v => v.toFixed(1)} lowerIsBetter
        />
        <ComparisonRow
          label="HR/9" user={hr9(userTotals)}
          conf={hr9(confTotals)}
          naia={hr9(naiaTotals)}
          fmt={v => v.toFixed(1)} lowerIsBetter
        />
      </PixelCard>

      <PixelCard accent={accent} title="ALL TEAMS — SORTABLE">
        <div className="text-[#a8a8c8] text-sm mb-2">
          Click any column header to sort. Your team highlighted in green; conference opponents in cream.
        </div>
        <TeamComparisonTable rows={teamRows} slot={slot} hasAnalyticsMgr={hasAnalyticsMgr} />
      </PixelCard>
    </div>
  )
}

function ComparisonRow({ label, user, conf, naia, fmt, lowerIsBetter = false }) {
  const userBetterThanConf = lowerIsBetter ? user < conf : user > conf
  const userBetterThanNaia = lowerIsBetter ? user < naia : user > naia
  return (
    <div className="grid grid-cols-4 gap-2 py-1.5 border-b border-[#3a3a5e] last:border-0 text-sm font-pixel">
      <div className="text-[#a8a8c8] font-semibold">{label}</div>
      <div className={'font-mono tabular-nums text-right ' + (userBetterThanConf && userBetterThanNaia ? 'text-emerald-300 font-bold' : 'text-white')}>
        {fmt(user)}
      </div>
      <div className="text-right font-mono tabular-nums text-[#cbd5e1]">
        {fmt(conf)} <span className="text-[10px] text-[#a8a8c8] ml-1">conf</span>
      </div>
      <div className="text-right font-mono tabular-nums text-[#cbd5e1]">
        {fmt(naia)} <span className="text-[10px] text-[#a8a8c8] ml-1">NAIA</span>
      </div>
    </div>
  )
}

function TeamComparisonTable({ rows, slot, hasAnalyticsMgr }) {
  const hide = !hasAnalyticsMgr
  const extractors = useMemo(() => ({
    name:    r => r.schoolName.toLowerCase(),
    record:  r => parseInt(r.record, 10) || 0,
    runDiff: r => r.runDiff,
    avg:     r => r.avg,
    obp:     r => r.obp,
    slg:     r => r.slg,
    ops:     r => r.ops,
    hr:      r => r.hr,
    era:     r => -r.era,    // sort ascending = best
    fip:     r => -r.fip,
    whip:    r => -r.whip,
    k9:      r => r.k_per_9,
  }), [])
  const { sortKey, sortDir, toggleSort, sortRows } = useTableSort('ops', 'desc', extractors)
  const sorted = sortRows(rows)
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-base font-pixel">
        <thead>
          <tr className="text-left font-pixel-display text-[10px] tracking-widest">
            <SortableHeader k="name"    sortKey={sortKey} dir={sortDir} onSort={toggleSort} label="TEAM"    className="py-1 pr-2" />
            <SortableHeader k="record"  sortKey={sortKey} dir={sortDir} onSort={toggleSort} label="W-L"     className="pr-2" />
            <SortableHeader k="runDiff" sortKey={sortKey} dir={sortDir} onSort={toggleSort} label="RUN DIFF" className="pr-2" />
            <SortableHeader k="avg"     sortKey={sortKey} dir={sortDir} onSort={toggleSort} label="AVG"     className="pr-2" />
            <SortableHeader k="ops"     sortKey={sortKey} dir={sortDir} onSort={toggleSort} label="OPS"     className="pr-2" />
            <SortableHeader k="hr"      sortKey={sortKey} dir={sortDir} onSort={toggleSort} label="HR"      className="pr-2" />
            <SortableHeader k="era"     sortKey={sortKey} dir={sortDir} onSort={toggleSort} label="ERA"     className="pr-2" />
            {!hide && <SortableHeader k="fip"     sortKey={sortKey} dir={sortDir} onSort={toggleSort} label="FIP"     className="pr-2" />}
            {hide && <th className="pr-2 text-gray-500" title="Hire a Data Analytics Manager to unlock">FIP </th>}
            <SortableHeader k="whip"    sortKey={sortKey} dir={sortDir} onSort={toggleSort} label="WHIP"    className="pr-2" />
            <SortableHeader k="k9"      sortKey={sortKey} dir={sortDir} onSort={toggleSort} label="K/9"     className="pr-2" />
          </tr>
        </thead>
        <tbody>
          {sorted.map(r => (
            <tr key={r.teamId} className={
              'border-t border-[#3a3a5e] ' +
              (r.isUser ? 'bg-emerald-900/40 font-semibold' : r.isConf ? 'bg-[#3a3a5e]/30' : '')
            }>
              <td className="py-1 pr-2">
                <span className="text-white">{r.schoolName}</span>
                <span className="text-[10px] text-[#a8a8c8] ml-1.5">{r.confAbbr}</span>
              </td>
              <td className="pr-2 font-mono tabular-nums">{r.record}</td>
              <td className={'pr-2 font-mono tabular-nums ' + (r.runDiff > 0 ? 'text-emerald-300' : r.runDiff < 0 ? 'text-red-400' : '')}>
                {r.runDiff > 0 ? '+' : ''}{r.runDiff}
              </td>
              <td className="pr-2 font-mono tabular-nums">{fmtRate(r.avg)}</td>
              <td className="pr-2 font-mono tabular-nums">{fmtRate(r.ops)}</td>
              <td className="pr-2 font-mono tabular-nums">{r.hr}</td>
              <td className="pr-2 font-mono tabular-nums">{fmt2(r.era)}</td>
              <td className="pr-2 font-mono tabular-nums">{hide ? <span className="text-gray-500 italic">???</span> : fmt2(r.fip)}</td>
              <td className="pr-2 font-mono tabular-nums">{fmt2(r.whip)}</td>
              <td className="pr-2 font-mono tabular-nums">{r.k_per_9.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── National leaders view ──────────────────────────────────────────────────

function NationalLeadersView({ save, leagueStats, accent, slot, hasAnalyticsMgr }) {
  const lg = useMemo(() => leagueAverages({ playerStats: leagueStats }), [leagueStats])

  // Build flat lists of every qualifying player (hitter + pitcher), with the
  // school name + computed advanced stats. ~7,000 rows for a full league —
  // memoize so we don't redo every render.
  const { topHitters, topPitchers } = useMemo(() => {
    const hitters = []
    const pitchers = []
    for (const [key, row] of Object.entries(leagueStats)) {
      const isPitcher = key.startsWith('p_')
      const pid = row.playerId
      const player = save.players?.[pid]
      if (!player) continue
      // Look up the team via player.schoolId
      const teamId = player.schoolId
      const school = save.schools?.[teamId]
      if (!school) continue
      const enriched = {
        playerId: pid,
        playerName: `${player.firstName} ${player.lastName}`,
        position: isPitcher ? 'P' : player.primaryPosition,
        schoolName: school.name,
        confAbbr: save.conferences?.[school.conferenceId]?.abbreviation || '',
        teamId,
        stats: row,
      }
      if (isPitcher) {
        if ((row.ip || 0) < 30) continue
        enriched.adv = computePitching(row, lg)
        pitchers.push(enriched)
      } else {
        if ((row.pa || 0) < 80) continue
        enriched.adv = computeBatting(row, lg)
        hitters.push(enriched)
      }
    }
    return { topHitters: hitters, topPitchers: pitchers }
  }, [leagueStats, save.players, save.schools, save.conferences, lg])

  return (
    <div className="space-y-4">
      <LeaderCard
        title="NATIONAL HITTING LEADERS"
        rows={topHitters}
        accent={accent}
        slot={slot}
        hasAnalyticsMgr={hasAnalyticsMgr}
        columns={[
          { key: 'wOBA',    label: 'wOBA',    getValue: r => r.adv.wOBA,    fmt: fmtRate },
          { key: 'wRCplus', label: 'wRC+',    getValue: r => r.adv.wRCplus, fmt: v => String(v) },
          { key: 'oWAR',    label: 'WAR',     getValue: r => r.adv.oWAR,    fmt: fmtWar },
          { key: 'avg',     label: 'AVG',     getValue: r => r.adv.avg,     fmt: fmtRate },
          { key: 'hr',      label: 'HR',      getValue: r => r.stats.hr,    fmt: v => String(v) },
          { key: 'rbi',     label: 'RBI',     getValue: r => r.stats.rbi,   fmt: v => String(v) },
        ]}
        userTeamId={save.userSchoolId}
      />
      <LeaderCard
        title="NATIONAL PITCHING LEADERS"
        rows={topPitchers}
        accent={accent}
        slot={slot}
        hasAnalyticsMgr={hasAnalyticsMgr}
        columns={[
          { key: 'pWAR', label: 'WAR',  getValue: r => r.adv.pWAR, fmt: fmtWar },
          { key: 'fip',  label: 'FIP',  getValue: r => -r.adv.fip, fmt: () => '' },   // sort marker; display uses raw
          { key: 'era',  label: 'ERA',  getValue: r => -r.adv.era, fmt: () => '' },
          { key: 'k',    label: 'K',    getValue: r => r.stats.k,  fmt: v => String(v) },
          { key: 'ip',   label: 'IP',   getValue: r => r.adv.ip,   fmt: v => v.toFixed(1) },
        ]}
        isPitcher
        userTeamId={save.userSchoolId}
      />
    </div>
  )
}

function LeaderCard({ title, rows, accent, slot, columns, isPitcher, userTeamId, hasAnalyticsMgr }) {
  // Without analytics manager, sort by ERA (P) / AVG (H) instead of WAR.
  const sorted = [...rows].sort((a, b) => {
    if (hasAnalyticsMgr) {
      const av = isPitcher ? a.adv.pWAR : a.adv.oWAR
      const bv = isPitcher ? b.adv.pWAR : b.adv.oWAR
      return bv - av
    }
    if (isPitcher) return a.adv.era - b.adv.era
    return b.adv.avg - a.adv.avg
  }).slice(0, 15)
  if (sorted.length === 0) {
    return (
      <PixelCard accent={accent} title={title}>
        <div className="text-[#a8a8c8] italic">No qualifying players yet (need 80+ PA or 30+ IP).</div>
      </PixelCard>
    )
  }
  const hide = !hasAnalyticsMgr
  const lockTh = (label) => (
    <th className="pr-2 text-gray-500" title="Hire a Data Analytics Manager to unlock">{label} </th>
  )
  const lockTd = <td className="pr-2 font-mono tabular-nums text-gray-500 italic">???</td>
  return (
    <PixelCard accent={accent} title={title}>
      <div className="overflow-x-auto">
        <table className="w-full text-base font-pixel">
          <thead>
            <tr className="text-[#a8a8c8] text-left font-pixel-display text-[10px] tracking-widest">
              <th className="py-1 pr-2">#</th>
              <th className="pr-2">PLAYER</th>
              <th className="pr-2">SCHOOL</th>
              {isPitcher && <>
                {hide ? lockTh('WAR') : <th className="pr-2">WAR</th>}
                {hide ? lockTh('FIP') : <th className="pr-2">FIP</th>}
                <th className="pr-2">ERA</th>
                <th className="pr-2">K</th>
                <th className="pr-2">IP</th>
              </>}
              {!isPitcher && <>
                {hide ? lockTh('wOBA') : <th className="pr-2">wOBA</th>}
                {hide ? lockTh('wRC+') : <th className="pr-2">wRC+</th>}
                {hide ? lockTh('WAR') : <th className="pr-2">WAR</th>}
                <th className="pr-2">AVG</th>
                <th className="pr-2">HR</th>
                <th className="pr-2">RBI</th>
              </>}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={r.playerId} className={'border-t border-[#3a3a5e] ' + (r.teamId === userTeamId ? 'bg-emerald-900/40 font-semibold' : '')}>
                <td className="py-1 pr-2 text-[#a8a8c8]">{i + 1}</td>
                <td className="pr-2">
                  <Link to={`/gm/player/${r.playerId}?slot=${slot}`} className="flex items-center gap-2 hover:text-white text-white">
                    <PixelHeadshot playerId={r.playerId} size={20} />
                    <span>{r.playerName}</span>
                    <span className="text-[10px] text-[#a8a8c8]">{r.position}</span>
                  </Link>
                </td>
                <td className="pr-2 text-[#cbd5e1]">{r.schoolName} <span className="text-[10px] text-[#a8a8c8]">{r.confAbbr}</span></td>
                {isPitcher ? <>
                  {hide ? lockTd : <td className="pr-2 font-mono tabular-nums">{fmtWar(r.adv.pWAR)}</td>}
                  {hide ? lockTd : <td className="pr-2 font-mono tabular-nums">{fmt2(r.adv.fip)}</td>}
                  <td className="pr-2 font-mono tabular-nums">{fmt2(r.adv.era)}</td>
                  <td className="pr-2 font-mono tabular-nums">{r.stats.k}</td>
                  <td className="pr-2 font-mono tabular-nums">{r.adv.ip.toFixed(1)}</td>
                </> : <>
                  {hide ? lockTd : <td className="pr-2 font-mono tabular-nums">{fmtRate(r.adv.wOBA)}</td>}
                  {hide ? lockTd : <td className="pr-2 font-mono tabular-nums">{r.adv.wRCplus}</td>}
                  {hide ? lockTd : <td className="pr-2 font-mono tabular-nums">{fmtWar(r.adv.oWAR)}</td>}
                  <td className="pr-2 font-mono tabular-nums">{fmtRate(r.adv.avg)}</td>
                  <td className="pr-2 font-mono tabular-nums">{r.stats.hr}</td>
                  <td className="pr-2 font-mono tabular-nums">{r.stats.rbi}</td>
                </>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PixelCard>
  )
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function aggregateAllTeamsInIds(leagueStats, save, teamIds) {
  const out = { pa: 0, ab: 0, h: 0, d: 0, t: 0, hr: 0, bb: 0, k: 0, hbp: 0, sf: 0, rbi: 0,
                outs: 0, p_h: 0, p_bb: 0, p_k: 0, p_er: 0, p_hr: 0, p_hbp: 0, p_bf: 0 }
  for (const tid of teamIds) {
    const team = save.teams[tid]
    if (!team) continue
    const tt = aggregateTeamStats(team.rosterPlayerIds || [], leagueStats)
    for (const k of Object.keys(out)) out[k] += tt[k] || 0
  }
  return out
}

function safe(num, den) { return den > 0 ? num / den : 0 }
function tb(t)  { return (t.h - t.d - t.t - t.hr) + t.d * 2 + t.t * 3 + t.hr * 4 }
function era(t) { const ip = t.outs / 3; return ip > 0 ? (t.p_er * 9) / ip : 0 }
function whip(t){ const ip = t.outs / 3; return ip > 0 ? (t.p_h + t.p_bb) / ip : 0 }
function k9(t)  { const ip = t.outs / 3; return ip > 0 ? (t.p_k * 9) / ip : 0 }
function bb9(t) { const ip = t.outs / 3; return ip > 0 ? (t.p_bb * 9) / ip : 0 }
function hr9(t) { const ip = t.outs / 3; return ip > 0 ? (t.p_hr * 9) / ip : 0 }

// ─── Analytics Manager gate banner ──────────────────────────────────────

function TSAnalyticsGate({ slot }) {
  return (
    <div className="bg-gradient-to-r from-purple-900/40 to-amber-900/30 border-4 border-amber-400 rounded p-3 mb-4 flex items-start gap-3">
      <div className="text-2xl">🔒</div>
      <div className="flex-1 min-w-0">
        <div className="font-pixel-display text-[10px] tracking-widest text-amber-300 mb-1">
          ADVANCED STATS LOCKED
        </div>
        <div className="text-[13px] text-white font-pixel leading-snug mb-2">
          wOBA, wRC+, oWAR, FIP, xFIP, pWAR are hidden until you hire a <strong className="text-amber-200">Data Analytics Manager</strong>.
          Basic columns (AVG/OPS/ERA/WHIP/K-9) still work normally.
        </div>
        <Link
          to={`/gm/coaches?slot=${slot}`}
          className="inline-block bg-amber-400 text-[#1a1a2e] font-bold text-[11px] tracking-widest uppercase px-3 py-1.5 rounded hover:bg-amber-300 transition"
        >
          Hire Data Manager →
        </Link>
      </div>
    </div>
  )
}
