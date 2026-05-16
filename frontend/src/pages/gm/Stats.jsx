/**
 * Combined Stats page — three views, switched via ?view= query param:
 *   spring  — current spring season + per-year filter dropdown for archived
 *             years (reads state.statsArchive[year] for past seasons)
 *   fall    — fall scrimmage report (reads state.fallStats[year])
 *   career  — career-totals view by player, sums across every archived
 *             spring stat block
 */

import { useMemo, useState } from 'react'
import { useSearchParams, Navigate, Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty } from '../../gm/engine/save'
import { ensureUnifiedCalendar } from '../../gm/engine/gameYear'
import { displayPosition, displayClassYear } from '../../gm/engine/format'
import { leagueAverages, computeBatting, computePitching, fmtRate, fmt2, fmtWar } from '../../gm/engine/advancedStats'
import GMShell, { PixelCard } from '../../gm/components/GMShell'
import PixelHeadshot from '../../gm/components/PixelHeadshot'

const VIEWS = [
  { key: 'spring', label: 'Spring' },
  { key: 'fall',   label: 'Fall' },
  { key: 'career', label: 'Career' },
]

export default function Stats() {
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const view = params.get('view') || 'spring'
  const yearParam = parseInt(params.get('year') || '0', 10)
  const userId = user?.id || 'guest'

  const save = useMemo(() => {
    const s = loadDynasty(userId, slot)
    if (s) ensureUnifiedCalendar(s)
    return s
  }, [userId, slot])
  if (!save) return <Navigate to="/gm" replace />

  const school = save.schools[save.userSchoolId]
  const team = save.teams[save.userSchoolId]
  const accent = school.colors?.[0] || '#fbbf24'

  function setView(v) {
    const next = new URLSearchParams(params)
    next.set('view', v)
    next.delete('year')
    setParams(next, { replace: true })
  }
  function setYear(y) {
    const next = new URLSearchParams(params)
    if (y) next.set('year', String(y)); else next.delete('year')
    setParams(next, { replace: true })
  }

  // Years available in the spring archive (plus the current year if active)
  const archiveYears = Object.keys(save.statsArchive || {}).map(Number).sort((a, b) => b - a)
  const currentYear = save.calendar?.year
  const allSpringYears = currentYear ? [currentYear, ...archiveYears.filter(y => y !== currentYear)] : archiveYears
  const fallYears = Object.keys(save.fallStats || {}).map(Number).sort((a, b) => b - a)

  return (
    <GMShell schoolName={school.name} schoolColors={school.colors}>
      <div className="mb-4">
        <h1 className="font-pixel-display text-xl tracking-widest text-white mb-1">STATS</h1>
        <p className="font-pixel text-base text-[#a8a8c8]">
          {school.name} · season {currentYear}
        </p>
      </div>

      {/* View toggle */}
      <div className="flex gap-2 mb-4">
        {VIEWS.map(v => (
          <button
            key={v.key}
            onClick={() => setView(v.key)}
            className={
              'font-pixel-display text-[10px] tracking-widest px-3 py-2 border-4 transition ' +
              (view === v.key
                ? 'text-[#1a1a2e]'
                : 'border-[#3a3a5e] text-[#e8e8e8] hover:text-white')
            }
            style={view === v.key ? { backgroundColor: accent, borderColor: accent } : {}}
          >
            {v.label}
          </button>
        ))}
      </div>

      {view === 'spring' && (
        <SpringView
          save={save}
          team={team}
          year={yearParam || currentYear}
          allYears={allSpringYears}
          onYearChange={setYear}
          accent={accent}
          slot={slot}
        />
      )}
      {view === 'fall' && (
        <FallView
          save={save}
          team={team}
          year={yearParam || fallYears[0] || currentYear}
          allYears={fallYears}
          onYearChange={setYear}
          accent={accent}
          slot={slot}
        />
      )}
      {view === 'career' && (
        <CareerView save={save} team={team} accent={accent} slot={slot} />
      )}
    </GMShell>
  )
}

// ─── Spring view ──────────────────────────────────────────────────────────

function SpringView({ save, team, year, allYears, onYearChange, accent, slot }) {
  const isCurrent = year === save.calendar?.year
  const stats = isCurrent
    ? (save.playerStats || {})
    : (save.statsArchive?.[year] || {})
  const roster = team.rosterPlayerIds || []
  // For career-archived years, also union in players who may have left
  const allPlayerIds = new Set(roster)
  for (const key of Object.keys(stats)) {
    const pid = stats[key].playerId
    if (pid) allPlayerIds.add(pid)
  }
  const ids = [...allPlayerIds]

  const batters = []
  const pitchers = []
  for (const pid of ids) {
    const player = save.players[pid]
    if (!player) continue
    const bs = stats[`b_${pid}`]
    const ps = stats[`p_${pid}`]
    if (bs && bs.ab > 0) batters.push({ player, ...bs })
    if (ps && ps.ip > 0) pitchers.push({ player, ...ps })
  }

  return (
    <>
      <div className="flex items-center gap-2 mb-3 font-pixel">
        <span className="text-[#a8a8c8]">Season:</span>
        <select
          value={year || ''}
          onChange={e => onYearChange(parseInt(e.target.value, 10))}
          className="bg-[#23233d] border-4 border-[#3a3a5e] text-white px-2 py-1 text-base focus:outline-none focus:border-[var(--accent)]"
          style={{ '--accent': accent }}
        >
          {allYears.length === 0 && <option value={save.calendar?.year}>{save.calendar?.year} (current)</option>}
          {allYears.map(y => (
            <option key={y} value={y}>{y} {y === save.calendar?.year && '(current)'}</option>
          ))}
        </select>
        <span className="ml-3 text-sm text-[#a8a8c8]">
          {batters.length === 0 && pitchers.length === 0
            ? 'No spring stats logged for this year yet.'
            : `${batters.length} batters · ${pitchers.length} pitchers`}
        </span>
      </div>
      <BatterTable rows={batters} save={save} accent={accent} slot={slot} />
      <PitcherTable rows={pitchers} save={save} accent={accent} slot={slot} />
    </>
  )
}

// ─── Fall view ────────────────────────────────────────────────────────────

function FallView({ save, team, year, allYears, onYearChange, accent, slot }) {
  const stats = save.fallStats?.[year] || {}
  const roster = team.rosterPlayerIds || []
  const batters = []
  const pitchers = []
  for (const pid of roster) {
    const player = save.players[pid]
    if (!player) continue
    const bs = stats[`b_${pid}`]
    const ps = stats[`p_${pid}`]
    if (bs && bs.ab > 0) batters.push({ player, ...bs })
    if (ps && ps.ip > 0) pitchers.push({ player, ...ps })
  }

  return (
    <>
      <div className="flex items-center gap-2 mb-3 font-pixel">
        <span className="text-[#a8a8c8]">Fall year:</span>
        <select
          value={year || ''}
          onChange={e => onYearChange(parseInt(e.target.value, 10))}
          className="bg-[#23233d] border-4 border-[#3a3a5e] text-white px-2 py-1 text-base"
        >
          {allYears.length === 0 && <option value={save.calendar?.year}>{save.calendar?.year}</option>}
          {allYears.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>
      <p className="text-xs text-[#a8a8c8] italic mb-3 font-pixel">
        Fall scrimmage stats — kept separate from spring. Use these to evaluate who has earned a starting job heading into spring.
      </p>
      <BatterTable rows={batters} save={save} accent={accent} slot={slot} emptyMsg="No fall hitting yet." />
      <PitcherTable rows={pitchers} save={save} accent={accent} slot={slot} emptyMsg="No fall pitching yet." />
    </>
  )
}

// ─── Career view ──────────────────────────────────────────────────────────

function CareerView({ save, team, accent, slot }) {
  // Sum every archived spring year + the current year for each player
  const archive = save.statsArchive || {}
  const current = save.playerStats || {}
  const currentYear = save.calendar?.year
  const yearBlocks = [
    ...Object.entries(archive).map(([y, s]) => ({ year: Number(y), stats: s })),
    currentYear ? { year: currentYear, stats: current } : null,
  ].filter(Boolean)

  // Build per-player aggregates
  const batCareer = {}
  const pitchCareer = {}
  for (const { stats } of yearBlocks) {
    for (const key of Object.keys(stats)) {
      const s = stats[key]
      const pid = s.playerId
      if (!pid) continue
      if (key.startsWith('b_')) {
        if (!batCareer[pid]) batCareer[pid] = { playerId: pid, ab: 0, h: 0, d: 0, t: 0, hr: 0, bb: 0, k: 0, rbi: 0, pa: 0, years: 0 }
        for (const f of ['ab','h','d','t','hr','bb','k','rbi','pa']) batCareer[pid][f] += s[f] || 0
        batCareer[pid].years++
      } else if (key.startsWith('p_')) {
        if (!pitchCareer[pid]) pitchCareer[pid] = { playerId: pid, ip: 0, h: 0, bb: 0, k: 0, er: 0, pa: 0, years: 0 }
        for (const f of ['ip','h','bb','k','er','pa']) pitchCareer[pid][f] += s[f] || 0
        pitchCareer[pid].years++
      }
    }
  }

  const batters = Object.values(batCareer)
    .filter(s => s.ab > 0)
    .map(s => ({ ...s, player: save.players[s.playerId] }))
    .filter(s => s.player)
  const pitchers = Object.values(pitchCareer)
    .filter(s => s.ip > 0)
    .map(s => ({ ...s, player: save.players[s.playerId] }))
    .filter(s => s.player)

  return (
    <>
      <p className="text-sm text-[#a8a8c8] mb-3 font-pixel">
        Totals across {yearBlocks.length} season{yearBlocks.length === 1 ? '' : 's'} of play.
        New dynasty? Career totals build up as you sim through seasons.
      </p>
      <BatterTable rows={batters} save={save} accent={accent} slot={slot} careerMode emptyMsg="No career hitting yet." />
      <PitcherTable rows={pitchers} save={save} accent={accent} slot={slot} careerMode emptyMsg="No career pitching yet." />
    </>
  )
}

// ─── Tables ───────────────────────────────────────────────────────────────

function BatterTable({ rows, save, accent, slot, careerMode, emptyMsg }) {
  if (rows.length === 0) {
    return (
      <PixelCard accent={accent} title="HITTING">
        <div className="text-[#a8a8c8] italic text-base">{emptyMsg || 'No hitter ABs logged.'}</div>
      </PixelCard>
    )
  }
  const lg = useMemo(() => leagueAverages(save), [save])
  const enriched = rows.map(r => ({ r, adv: computeBatting(r, lg) }))
  const sorted = [...enriched].sort((a, b) => b.adv.wOBA - a.adv.wOBA)
  return (
    <PixelCard accent={accent} title="HITTING">
      <div className="overflow-x-auto">
        <table className="w-full text-base font-pixel">
          <thead>
            <tr className="text-[#a8a8c8] text-left font-pixel-display text-[10px] tracking-widest">
              <th className="py-1 pr-2">PLAYER</th>
              <th>POS</th><th>CL</th>
              {careerMode && <th>YRS</th>}
              <th>AB</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>RBI</th><th>BB</th><th>K</th>
              <th>AVG</th><th>OBP</th><th>SLG</th><th>OPS</th>
              <th>wOBA</th><th>wRC+</th><th>oWAR</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(({ r, adv }) => (
              <tr key={r.playerId} className="border-t border-[#3a3a5e]">
                <td className="py-1 pr-2">
                  <Link to={`/gm/player/${r.playerId}?slot=${slot}`} className="flex items-center gap-2 hover:text-white">
                    <PixelHeadshot playerId={r.playerId} size={20} />
                    <span>{r.player.firstName} {r.player.lastName}</span>
                  </Link>
                </td>
                <td>{displayPosition(r.player.primaryPosition)}</td>
                <td>{displayClassYear(r.player)}</td>
                {careerMode && <td>{r.years}</td>}
                <td>{r.ab || 0}</td><td>{r.h}</td><td>{r.d}</td><td>{r.t}</td><td>{r.hr}</td>
                <td>{r.rbi}</td><td>{r.bb}</td><td>{r.k}</td>
                <td className="font-bold">{fmtRate(adv.avg)}</td>
                <td>{fmtRate(adv.obp)}</td>
                <td>{fmtRate(adv.slg)}</td>
                <td className="font-bold">{fmtRate(adv.ops)}</td>
                <td>{fmtRate(adv.wOBA)}</td>
                <td className="font-bold">{adv.pa > 0 ? adv.wRCplus : '—'}</td>
                <td>{fmtWar(adv.oWAR)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PixelCard>
  )
}

function PitcherTable({ rows, save, accent, slot, careerMode, emptyMsg }) {
  if (rows.length === 0) {
    return (
      <PixelCard accent={accent} title="PITCHING">
        <div className="text-[#a8a8c8] italic text-base">{emptyMsg || 'No pitcher IP logged.'}</div>
      </PixelCard>
    )
  }
  const lg = useMemo(() => leagueAverages(save), [save])
  const enriched = rows.map(r => ({ r, adv: computePitching(r, lg) }))
  const sorted = [...enriched].sort((a, b) => a.adv.fip - b.adv.fip)
  return (
    <PixelCard accent={accent} title="PITCHING">
      <div className="overflow-x-auto">
        <table className="w-full text-base font-pixel">
          <thead>
            <tr className="text-[#a8a8c8] text-left font-pixel-display text-[10px] tracking-widest">
              <th className="py-1 pr-2">PLAYER</th>
              <th>CL</th>
              {careerMode && <th>YRS</th>}
              <th>IP</th><th>H</th><th>BB</th><th>K</th><th>ER</th>
              <th>ERA</th><th>WHIP</th><th>K/9</th>
              <th>FIP</th><th>xFIP</th><th>pWAR</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(({ r, adv }) => (
              <tr key={r.playerId} className="border-t border-[#3a3a5e]">
                <td className="py-1 pr-2">
                  <Link to={`/gm/player/${r.playerId}?slot=${slot}`} className="flex items-center gap-2 hover:text-white">
                    <PixelHeadshot playerId={r.playerId} size={20} />
                    <span>{r.player.firstName} {r.player.lastName}</span>
                  </Link>
                </td>
                <td>{displayClassYear(r.player)}</td>
                {careerMode && <td>{r.years}</td>}
                <td>{r.ip ? r.ip.toFixed(1) : '—'}</td>
                <td>{r.h}</td><td>{r.bb}</td><td>{r.k}</td><td>{r.er}</td>
                <td className="font-bold">{fmt2(adv.era)}</td>
                <td>{fmt2(adv.whip)}</td>
                <td>{adv.ip > 0 ? adv.kPer9.toFixed(1) : '—'}</td>
                <td className="font-bold">{fmt2(adv.fip)}</td>
                <td>{fmt2(adv.xfip)}</td>
                <td>{fmtWar(adv.pWAR)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PixelCard>
  )
}
