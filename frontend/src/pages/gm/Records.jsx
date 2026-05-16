/**
 * Records page — single-season bests, career bests, and MLB draft history.
 *
 * All data here is REAL — sourced from save.statsArchive (per-year snapshots
 * archived at end of season) + save.draftResults (per-year draft pick lists).
 * Empty until the user finishes their first season; the page handles that
 * with friendly placeholders.
 */

import { useMemo, useState } from 'react'
import { useSearchParams, Navigate, Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty } from '../../gm/engine/save'
import { ensureUnifiedCalendar } from '../../gm/engine/gameYear'
import { displayPosition } from '../../gm/engine/format'
import { leagueAverages, computeBatting, computePitching, fmtRate, fmt2 } from '../../gm/engine/advancedStats'
import GMShell, { PixelCard } from '../../gm/components/GMShell'
import PixelHeadshot from '../../gm/components/PixelHeadshot'

const TABS = [
  { key: 'single', label: 'Single Season' },
  { key: 'career', label: 'Career' },
  { key: 'draft',  label: 'MLB Draft' },
]

export default function Records() {
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'
  const tab = params.get('tab') || 'single'

  const save = useMemo(() => {
    const s = loadDynasty(userId, slot)
    if (s) ensureUnifiedCalendar(s)
    return s
  }, [userId, slot])
  if (!save) return <Navigate to="/gm" replace />

  const school = save.schools[save.userSchoolId]
  const team = save.teams[save.userSchoolId]
  const accent = school.colors?.[0] || '#fbbf24'

  function setTab(t) {
    const next = new URLSearchParams(params)
    next.set('tab', t)
    setParams(next, { replace: true })
  }

  return (
    <GMShell schoolName={school.name} schoolColors={school.colors}>
      <div className="mb-4">
        <h1 className="font-pixel-display text-xl tracking-widest text-white mb-1">PROGRAM RECORDS</h1>
        <p className="font-pixel text-base text-[#a8a8c8]">
          {school.name} all-time best performances
        </p>
      </div>

      <div className="flex gap-2 mb-4">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={
              'font-pixel-display text-[10px] tracking-widest px-3 py-2 border-4 transition ' +
              (tab === t.key
                ? 'text-[#1a1a2e]'
                : 'border-[#3a3a5e] text-[#e8e8e8] hover:text-white')
            }
            style={tab === t.key ? { backgroundColor: accent, borderColor: accent } : {}}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'single' && <SingleSeasonView save={save} team={team} accent={accent} slot={slot} />}
      {tab === 'career' && <CareerView save={save} team={team} accent={accent} slot={slot} />}
      {tab === 'draft'  && <DraftView  save={save} team={team} accent={accent} slot={slot} />}
    </GMShell>
  )
}

// ─── Single-season records ──────────────────────────────────────────────────

function SingleSeasonView({ save, team, accent, slot }) {
  // Walk every archived season + the current in-progress year. For each
  // player who has played for this team, find their best season totals.
  const archive = save.statsArchive || {}
  const archivedYears = Object.keys(archive).map(Number).sort()
  // Single-season records ONLY use COMPLETED seasons — drop the live current year.
  if (archivedYears.length === 0) {
    return (
      <PixelCard accent={accent} title="NO RECORDS YET">
        <div className="text-[#a8a8c8] text-base">
          Single-season records start populating after your first completed spring season.
          Come back at the end of {save.calendar?.year ? save.calendar.year + 1 : 'next'} season.
        </div>
      </PixelCard>
    )
  }

  // Collect every (player, year, stats) row across history
  const userRosterEver = collectAllProgramPlayerIds(save, team)
  const lg = useMemo(() => leagueAverages(save), [save])

  const battingRows = []
  const pitchingRows = []
  for (const year of archivedYears) {
    const yearStats = archive[year] || {}
    for (const pid of userRosterEver) {
      const player = save.players[pid]
      if (!player) continue
      const bRow = yearStats[`b_${pid}`]
      if (bRow && bRow.ab > 0) {
        battingRows.push({ year, pid, player, ...bRow, _adv: computeBatting(bRow, lg) })
      }
      const pRow = yearStats[`p_${pid}`]
      if (pRow && pRow.outs > 0) {
        pitchingRows.push({ year, pid, player, ...pRow, _adv: computePitching(pRow, lg) })
      }
    }
  }

  return (
    <div className="space-y-4">
      <RecordTable
        title="BEST HITTING SEASONS"
        accent={accent}
        slot={slot}
        rows={battingRows}
        columns={[
          { key: 'avg',     label: 'AVG',  pick: 'best', getValue: r => r._adv.avg,     fmt: fmtRate, qualGate: r => r.ab >= 80 },
          { key: 'h',       label: 'H',    pick: 'best', getValue: r => r.h,            fmt: v => String(v) },
          { key: 'hr',      label: 'HR',   pick: 'best', getValue: r => r.hr,           fmt: v => String(v) },
          { key: 'rbi',     label: 'RBI',  pick: 'best', getValue: r => r.rbi,          fmt: v => String(v) },
          { key: '2b',      label: '2B',   pick: 'best', getValue: r => r.d,            fmt: v => String(v) },
          { key: 'ops',     label: 'OPS',  pick: 'best', getValue: r => r._adv.ops,     fmt: fmtRate, qualGate: r => r.ab >= 80 },
          { key: 'wOBA',    label: 'wOBA', pick: 'best', getValue: r => r._adv.wOBA,    fmt: fmtRate, qualGate: r => r.ab >= 80 },
          { key: 'wRCplus', label: 'wRC+', pick: 'best', getValue: r => r._adv.wRCplus, fmt: v => String(v), qualGate: r => r.ab >= 80 },
        ]}
        emptyMsg="No hitting records yet."
      />
      <RecordTable
        title="BEST PITCHING SEASONS"
        accent={accent}
        slot={slot}
        rows={pitchingRows}
        columns={[
          { key: 'ip',   label: 'IP',   pick: 'best', getValue: r => r._adv.ip,    fmt: v => v.toFixed(1) },
          { key: 'k',    label: 'K',    pick: 'best', getValue: r => r.k,          fmt: v => String(v) },
          { key: 'era',  label: 'ERA',  pick: 'low',  getValue: r => r._adv.era,   fmt: fmt2, qualGate: r => r._adv.ip >= 20 },
          { key: 'whip', label: 'WHIP', pick: 'low',  getValue: r => r._adv.whip,  fmt: fmt2, qualGate: r => r._adv.ip >= 20 },
          { key: 'fip',  label: 'FIP',  pick: 'low',  getValue: r => r._adv.fip,   fmt: fmt2, qualGate: r => r._adv.ip >= 20 },
          { key: 'k9',   label: 'K/9',  pick: 'best', getValue: r => r._adv.kPer9, fmt: v => v.toFixed(1), qualGate: r => r._adv.ip >= 20 },
        ]}
        emptyMsg="No pitching records yet."
      />
    </div>
  )
}

// ─── Career records ─────────────────────────────────────────────────────────

function CareerView({ save, team, accent, slot }) {
  const archive = save.statsArchive || {}
  const archivedYears = Object.keys(archive).map(Number).sort()
  if (archivedYears.length === 0) {
    return (
      <PixelCard accent={accent} title="NO CAREER STATS YET">
        <div className="text-[#a8a8c8] text-base">
          Career totals accumulate as players complete seasons. The first career numbers will
          appear here after you finish your first spring season.
        </div>
      </PixelCard>
    )
  }

  const userRosterEver = collectAllProgramPlayerIds(save, team)
  const lg = useMemo(() => leagueAverages(save), [save])

  // Sum each player's stats across every archived year (excluding current)
  const careerBatting = []
  const careerPitching = []
  for (const pid of userRosterEver) {
    const player = save.players[pid]
    if (!player) continue
    const bTotal = { ab: 0, h: 0, d: 0, t: 0, hr: 0, bb: 0, ibb: 0, hbp: 0, sf: 0, sac: 0, k: 0, rbi: 0, pa: 0, gidp: 0, roe: 0, years: 0 }
    const pTotal = { outs: 0, h: 0, bb: 0, ibb: 0, k: 0, er: 0, hr: 0, hbp: 0, pa: 0, years: 0 }
    let hasBat = false
    let hasPit = false
    for (const year of archivedYears) {
      const ys = archive[year] || {}
      const b = ys[`b_${pid}`]
      if (b && b.ab > 0) {
        hasBat = true
        bTotal.years++
        for (const k of Object.keys(bTotal)) {
          if (k !== 'years' && k in b) bTotal[k] += (b[k] || 0)
        }
      }
      const p = ys[`p_${pid}`]
      if (p && p.outs > 0) {
        hasPit = true
        pTotal.years++
        for (const k of Object.keys(pTotal)) {
          if (k !== 'years' && k in p) pTotal[k] += (p[k] || 0)
        }
      }
    }
    if (hasBat) careerBatting.push({ pid, player, ...bTotal, _adv: computeBatting(bTotal, lg) })
    if (hasPit) careerPitching.push({ pid, player, ...pTotal, _adv: computePitching(pTotal, lg) })
  }

  return (
    <div className="space-y-4">
      <RecordTable
        title="CAREER HITTING LEADERS"
        accent={accent}
        slot={slot}
        rows={careerBatting}
        career
        columns={[
          { key: 'h',   label: 'H',   pick: 'best', getValue: r => r.h,           fmt: v => String(v) },
          { key: 'hr',  label: 'HR',  pick: 'best', getValue: r => r.hr,          fmt: v => String(v) },
          { key: 'rbi', label: 'RBI', pick: 'best', getValue: r => r.rbi,         fmt: v => String(v) },
          { key: '2b',  label: '2B',  pick: 'best', getValue: r => r.d,           fmt: v => String(v) },
          { key: 'bb',  label: 'BB',  pick: 'best', getValue: r => r.bb,          fmt: v => String(v) },
          { key: 'avg', label: 'AVG', pick: 'best', getValue: r => r._adv.avg,    fmt: fmtRate, qualGate: r => r.ab >= 200 },
          { key: 'ops', label: 'OPS', pick: 'best', getValue: r => r._adv.ops,    fmt: fmtRate, qualGate: r => r.ab >= 200 },
        ]}
        emptyMsg="No career hitting leaders yet."
      />
      <RecordTable
        title="CAREER PITCHING LEADERS"
        accent={accent}
        slot={slot}
        rows={careerPitching}
        career
        columns={[
          { key: 'k',    label: 'K',    pick: 'best', getValue: r => r.k,             fmt: v => String(v) },
          { key: 'ip',   label: 'IP',   pick: 'best', getValue: r => r._adv.ip,       fmt: v => v.toFixed(1) },
          { key: 'era',  label: 'ERA',  pick: 'low',  getValue: r => r._adv.era,      fmt: fmt2, qualGate: r => r._adv.ip >= 50 },
          { key: 'fip',  label: 'FIP',  pick: 'low',  getValue: r => r._adv.fip,      fmt: fmt2, qualGate: r => r._adv.ip >= 50 },
          { key: 'whip', label: 'WHIP', pick: 'low',  getValue: r => r._adv.whip,     fmt: fmt2, qualGate: r => r._adv.ip >= 50 },
        ]}
        emptyMsg="No career pitching leaders yet."
      />
    </div>
  )
}

// ─── MLB Draft view ─────────────────────────────────────────────────────────

function DraftView({ save, team, accent, slot }) {
  const draftResults = save.draftResults || {}
  const years = Object.keys(draftResults).map(Number).sort((a, b) => b - a)
  if (years.length === 0) {
    return (
      <PixelCard accent={accent} title="NO DRAFT HISTORY">
        <div className="text-[#a8a8c8] text-base">
          MLB Draft results appear after your seniors graduate and the draft runs each summer.
          Program draft picks accumulate here over the years.
        </div>
      </PixelCard>
    )
  }

  // Filter to picks from the USER's school only — this is a program records page
  const programPicks = []
  for (const year of years) {
    const picks = draftResults[year] || []
    for (const pk of picks) {
      if (pk.teamId !== save.userSchoolId) continue
      programPicks.push({ ...pk, year })
    }
  }

  if (programPicks.length === 0) {
    return (
      <PixelCard accent={accent} title="NO PROGRAM DRAFT PICKS YET">
        <div className="text-[#a8a8c8] text-base">
          {years.length} draft{years.length === 1 ? '' : 's'} run, but no {team?.schoolId ? save.schools[team.schoolId]?.name : 'program'} players selected yet.
          The biggest measure of a program's reach is how many alumni hear their name called — keep developing talent.
        </div>
      </PixelCard>
    )
  }

  return (
    <PixelCard accent={accent} title="MLB DRAFT PICKS">
      <div className="overflow-x-auto">
        <table className="w-full text-base font-pixel">
          <thead>
            <tr className="text-[#a8a8c8] text-left font-pixel-display text-[10px] tracking-widest">
              <th className="py-1 pr-2">YEAR</th>
              <th className="pr-2">RD</th>
              <th className="pr-2">PLAYER</th>
              <th className="pr-2">POS</th>
              <th className="pr-2">OVR</th>
              <th className="pr-2">NOTES</th>
            </tr>
          </thead>
          <tbody>
            {programPicks.map((pk, i) => {
              const player = save.players[pk.playerId]
              return (
                <tr key={`${pk.year}_${pk.playerId}_${i}`} className="border-t border-[#3a3a5e]">
                  <td className="py-1 pr-2 tabular-nums font-mono">{pk.year}</td>
                  <td className="pr-2 tabular-nums font-mono">
                    <span className={pk.round <= 5 ? 'text-amber-300 font-bold' : ''}>R{pk.round}</span>
                  </td>
                  <td className="pr-2">
                    {player ? (
                      <Link to={`/gm/player/${pk.playerId}?slot=${slot}`} className="flex items-center gap-2 hover:text-white">
                        <PixelHeadshot playerId={pk.playerId} size={20} />
                        <span>{pk.name}</span>
                      </Link>
                    ) : (
                      <span>{pk.name}</span>
                    )}
                  </td>
                  <td className="pr-2">{displayPosition(pk.pos)}</td>
                  <td className="pr-2 tabular-nums">{pk.ovr || pk.rawOvr || '—'}</td>
                  <td className="pr-2 text-[#a8a8c8] text-xs">
                    {pk.summerBuzz ? 'Summer-ball buzz boosted draft stock' : ''}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="text-[10px] text-[#a8a8c8] mt-2">
        {programPicks.length} pick{programPicks.length === 1 ? '' : 's'} across {new Set(programPicks.map(p => p.year)).size} draft{new Set(programPicks.map(p => p.year)).size === 1 ? '' : 's'}.
        Rounds 1–5 highlighted as premium picks.
      </div>
    </PixelCard>
  )
}

// ─── Generic record-table component ─────────────────────────────────────────

/**
 * Renders one column per category in `columns`, each column showing the
 * single record-holder for that category. Rows is the pool of (year,
 * player, stats) entries to pick from. `pick: 'best'|'low'` picks the
 * highest or lowest value; `qualGate` is an optional minimum-PA/IP filter.
 */
function RecordTable({ title, accent, slot, rows, columns, emptyMsg, career = false }) {
  if (rows.length === 0) {
    return (
      <PixelCard accent={accent} title={title}>
        <div className="text-[#a8a8c8] italic text-base">{emptyMsg}</div>
      </PixelCard>
    )
  }
  return (
    <PixelCard accent={accent} title={title}>
      <div className="overflow-x-auto">
        <table className="w-full text-base font-pixel">
          <thead>
            <tr className="text-[#a8a8c8] text-left font-pixel-display text-[10px] tracking-widest">
              <th className="py-1 pr-2">RECORD</th>
              <th className="pr-2">HOLDER</th>
              {!career && <th className="pr-2">YEAR</th>}
              <th className="pr-2">VALUE</th>
            </tr>
          </thead>
          <tbody>
            {columns.map(col => {
              const qualified = col.qualGate ? rows.filter(col.qualGate) : rows
              if (qualified.length === 0) return null
              const sorted = [...qualified].sort((a, b) => {
                const av = col.getValue(a)
                const bv = col.getValue(b)
                return col.pick === 'low' ? av - bv : bv - av
              })
              const holder = sorted[0]
              return (
                <tr key={col.key} className="border-t border-[#3a3a5e]">
                  <td className="py-1 pr-2 font-semibold">{col.label}</td>
                  <td className="pr-2">
                    <Link to={`/gm/player/${holder.pid}?slot=${slot}`} className="flex items-center gap-2 hover:text-white">
                      <PixelHeadshot playerId={holder.pid} size={20} />
                      <span>{holder.player.firstName} {holder.player.lastName}</span>
                    </Link>
                  </td>
                  {!career && <td className="pr-2 tabular-nums">{holder.year}</td>}
                  <td className="pr-2 font-mono font-bold">{col.fmt(col.getValue(holder))}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </PixelCard>
  )
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Walk save.statsArchive + current roster to collect every player ID that
 * EVER played for the user's program. Career records pull from this set so
 * graduated/cut players still appear in record books.
 */
function collectAllProgramPlayerIds(save, team) {
  const ids = new Set(team?.rosterPlayerIds || [])
  const archive = save.statsArchive || {}
  for (const year of Object.keys(archive)) {
    const ys = archive[year]
    for (const key of Object.keys(ys || {})) {
      const row = ys[key]
      if (!row?.playerId) continue
      // Only include players who appear on this team's all-time roster.
      // We can't perfectly recover "did they wear our jersey that year" from
      // playerStats alone, so include any pid whose player record links to
      // this school OR whose stats appeared in our archive.
      const p = save.players[row.playerId]
      if (!p) continue
      if (p.schoolId === team.schoolId) ids.add(row.playerId)
    }
  }
  return [...ids]
}
