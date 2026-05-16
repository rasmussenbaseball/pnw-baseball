/**
 * Academics / GPA Tracker page.
 *
 * Surfaces:
 *   - Team GPA + counts by standing (eligible / probation / ineligible / dismissed)
 *   - AT-RISK list: players currently ineligible or on probation
 *   - Full roster GPA table sorted lowest-first
 *   - Eligibility rules explainer (so the user understands the cliff)
 *   - "What affects GPA" explainer (academic_aptitude, study hall, AP
 *     utilization, happiness, coach motivator)
 *   - Quick-link to Weekly Actions for study hall
 */

import { useMemo, useState } from 'react'
import { useSearchParams, Navigate, Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty } from '../../gm/engine/save'
import { ensureUnifiedCalendar } from '../../gm/engine/gameYear'
import { displayPosition, displayClassYear } from '../../gm/engine/format'
import { teamAcademicSummary, GPA_THRESHOLDS } from '../../gm/engine/academics'
import { playerOverall } from '../../gm/engine/playerRating'
import GMShell, { PixelCard } from '../../gm/components/GMShell'
import PixelHeadshot from '../../gm/components/PixelHeadshot'
import SortableHeader, { useTableSort } from '../../gm/components/SortableHeader'

export default function Academics() {
  const { user } = useAuth()
  const [params] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
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

  const players = useMemo(() => (team.rosterPlayerIds || [])
    .map(id => save.players[id])
    .filter(Boolean)
    .map(p => ({ ...p, _ovr: playerOverall(p) })), [team.rosterPlayerIds, save.players])

  const summary = teamAcademicSummary(players)
  const atRisk = players.filter(p => p.academicStanding === 'ineligible' || p.academicStanding === 'probation')
  const studyHallBonus = save.studyHall?.cumulativeBonus ?? 0

  // Per Nate's request, GPA only ticks during semesters
  const wk = save.calendar?.weekOfYear ?? 0
  const inFallSemester = wk >= 5 && wk <= 18
  const inSpringSemester = wk >= 23 && wk <= 42
  const inSemester = inFallSemester || inSpringSemester

  return (
    <GMShell schoolName={school.name} schoolColors={school.colors}>
      <div className="mb-4">
        <h1 className="font-pixel-display text-xl tracking-widest text-white mb-1">ACADEMICS</h1>
        <p className="font-pixel text-base text-[#a8a8c8]">
          {school.name} GPA tracker · Week {wk} {inSemester ? '(in session)' : '(no classes)'}
        </p>
      </div>

      {/* Team summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <SummaryTile label="Team GPA" value={summary.teamGpa.toFixed(2)} accent={accent}
          trend={save._lastTeamGpa != null && summary.teamGpa !== save._lastTeamGpa
            ? (summary.teamGpa > save._lastTeamGpa ? 'up' : 'down')
            : null}
        />
        <SummaryTile label="Eligible"   value={summary.eligible}    accent="#10b981" />
        <SummaryTile label="Probation"  value={summary.probation}   accent="#f59e0b" />
        <SummaryTile label="Ineligible" value={summary.ineligible}  accent="#ef4444" />
        <SummaryTile label="Dismissed"  value={summary.dismissed}   accent="#7f1d1d" />
      </div>

      {/* AT RISK section — pinned high when anyone is below the line */}
      {atRisk.length > 0 && (
        <PixelCard accent="#ef4444" title="AT RISK">
          <div className="text-[#fda4af] text-base mb-3">
            {summary.ineligible > 0 && (
              <span><strong>{summary.ineligible}</strong> player{summary.ineligible === 1 ? '' : 's'} ineligible for next semester. </span>
            )}
            {summary.probation > 0 && (
              <span><strong>{summary.probation}</strong> on probation (close to ineligible). </span>
            )}
            Mandate study hall in Weekly Actions to lift the team.
          </div>
          <AcademicsTable rows={atRisk} slot={slot} defaultSort="gpa" defaultDir="asc" />
        </PixelCard>
      )}

      {/* Two-column section: full roster + rules / explainer */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <div className="lg:col-span-2">
          <PixelCard accent={accent} title="FULL ROSTER">
            <div className="text-[#a8a8c8] text-sm mb-2">
              Click any column header to sort. Click a player name to view their full card.
            </div>
            <AcademicsTable rows={players} slot={slot} defaultSort="gpa" defaultDir="asc" />
          </PixelCard>
        </div>

        <div className="space-y-4">
          {/* Eligibility rules */}
          <PixelCard accent={accent} title="ELIGIBILITY RULES">
            <ul className="space-y-2 text-sm text-[#e8e8e8] font-pixel">
              <li className="flex items-start gap-2">
                <span className="inline-block w-3 h-3 rounded-full bg-emerald-400 mt-1 shrink-0"></span>
                <span><strong>GPA ≥ 2.25</strong> — eligible, good standing.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="inline-block w-3 h-3 rounded-full bg-amber-400 mt-1 shrink-0"></span>
                <span><strong>GPA 2.00 – 2.24</strong> — academic probation. Still eligible, but on warning.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="inline-block w-3 h-3 rounded-full bg-red-500 mt-1 shrink-0"></span>
                <span><strong>GPA &lt; 2.00</strong> — ineligible. Player can't compete the next semester.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="inline-block w-3 h-3 rounded-full bg-red-900 mt-1 shrink-0"></span>
                <span><strong>2 consecutive sub-2.0 semesters</strong> — dismissed from school. Auto-cut from the roster.</span>
              </li>
            </ul>
            <div className="mt-3 p-2 bg-[#3a3a5e] rounded text-[11px] text-[#a8a8c8]">
              The dismissal cut does NOT use your trust-tier cut allowance. It also doesn't damage your job security beyond the GPA hit you already took.
            </div>
          </PixelCard>

          {/* What affects GPA */}
          <PixelCard accent={accent} title="WHAT AFFECTS GPA">
            <ul className="space-y-2 text-sm text-[#e8e8e8] font-pixel">
              <li><strong>Academic aptitude (hidden)</strong> — each player's baseline GPA tier. Higher aptitude = naturally better grades.</li>
              <li><strong>Study Hall (Weekly Actions)</strong> — every week of study hall adds a small permanent boost to every player's end-of-term GPA. Stackable up to ~+0.20.</li>
              <li><strong>Weekly AP utilization</strong> — using your action points keeps team focused. Sitting on AP drifts GPA down ~0.01/week during semesters.</li>
              <li><strong>Team happiness</strong> — happier teams study better. Happy players' GPAs drift up ~0.01/week.</li>
              <li><strong>Coach motivator rating</strong> — high-motivator coaches give a small end-of-term GPA bump to every player.</li>
              <li><strong>Semester clock</strong> — GPA only moves Wks 5-18 (Fall) and Wks 23-42 (Spring). Summer and December breaks are dormant.</li>
            </ul>
            <Link
              to={`/gm/weekly?slot=${slot}`}
              className="block mt-3 text-center bg-emerald-700 hover:bg-emerald-600 text-white rounded py-2 text-sm font-bold uppercase tracking-wider transition"
            >
              Open Weekly Actions — Mandate Study Hall
            </Link>
            {studyHallBonus > 0 && (
              <div className="mt-2 text-[11px] text-emerald-300 text-center">
                Current term study-hall boost: <strong>+{studyHallBonus.toFixed(2)} GPA</strong>
              </div>
            )}
          </PixelCard>
        </div>
      </div>
    </GMShell>
  )
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function SummaryTile({ label, value, accent, trend }) {
  const arrow = trend === 'up' ? '↑' : trend === 'down' ? '↓' : null
  return (
    <div className="bg-[#23233d] border-l-4 rounded-lg px-3 py-2" style={{ borderColor: accent }}>
      <div className="text-[10px] uppercase tracking-wider text-[#a8a8c8] font-bold">{label}</div>
      <div className="text-2xl font-extrabold text-white tabular-nums">
        {value}
        {arrow && (
          <span className={'ml-1 text-base ' + (trend === 'up' ? 'text-emerald-400' : 'text-red-400')}>
            {arrow}
          </span>
        )}
      </div>
    </div>
  )
}

function AcademicsTable({ rows, slot, defaultSort = 'gpa', defaultDir = 'asc' }) {
  const STANDING_RANK = { dismissed: 4, ineligible: 3, probation: 2, eligible: 1 }
  const extractors = useMemo(() => ({
    name:     r => r.lastName.toLowerCase(),
    pos:      r => r.primaryPosition || '',
    cl:       r => ({ FR: 1, SO: 2, JR: 3, SR: 4 })[r.classYear] || 0,
    ovr:      r => r._ovr,
    gpa:      r => r.gpa ?? 4.0,
    streak:   r => r.belowTwoStreak || 0,
    standing: r => STANDING_RANK[r.academicStanding || 'eligible'] || 0,
  }), [])
  const { sortKey, sortDir, toggleSort, sortRows } = useTableSort(defaultSort, defaultDir, extractors)
  const sorted = sortRows(rows)
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-base font-pixel">
        <thead>
          <tr className="text-left font-pixel-display text-[10px] tracking-widest">
            <SortableHeader k="name"     sortKey={sortKey} dir={sortDir} onSort={toggleSort} label="PLAYER" className="py-1 pr-2" />
            <SortableHeader k="pos"      sortKey={sortKey} dir={sortDir} onSort={toggleSort} label="POS"    className="pr-2" />
            <SortableHeader k="cl"       sortKey={sortKey} dir={sortDir} onSort={toggleSort} label="CL"     className="pr-2" />
            <SortableHeader k="ovr"      sortKey={sortKey} dir={sortDir} onSort={toggleSort} label="OVR"    className="pr-2" />
            <SortableHeader k="gpa"      sortKey={sortKey} dir={sortDir} onSort={toggleSort} label="GPA"    className="pr-2" />
            <SortableHeader k="streak"   sortKey={sortKey} dir={sortDir} onSort={toggleSort} label="STREAK" className="pr-2" />
            <SortableHeader k="standing" sortKey={sortKey} dir={sortDir} onSort={toggleSort} label="STATUS" className="pr-2" />
          </tr>
        </thead>
        <tbody>
          {sorted.map(p => <PlayerRow key={p.id} player={p} slot={slot} />)}
        </tbody>
      </table>
    </div>
  )
}

function PlayerRow({ player, slot }) {
  const gpa = player.gpa ?? null
  const standing = player.academicStanding || 'eligible'
  const streak = player.belowTwoStreak || 0
  const ovr = player._ovr ?? playerOverall(player)
  const gpaColor = gpa == null ? 'text-gray-400'
    : gpa < 2.0 ? 'text-red-400 font-bold'
    : gpa < 2.25 ? 'text-amber-300 font-bold'
    : gpa < 3.0 ? 'text-[#e8e8e8]'
    : 'text-emerald-300'
  return (
    <tr className="border-t border-[#3a3a5e]">
      <td className="py-1 pr-2">
        <Link to={`/gm/player/${player.id}?slot=${slot}`} className="flex items-center gap-2 hover:text-white">
          <PixelHeadshot playerId={player.id} size={20} />
          <span>{player.firstName} {player.lastName}</span>
        </Link>
      </td>
      <td className="pr-2">{displayPosition(player.primaryPosition)}</td>
      <td className="pr-2">{displayClassYear(player)}</td>
      <td className="pr-2 font-mono tabular-nums">{ovr}</td>
      <td className={'pr-2 font-mono tabular-nums ' + gpaColor}>
        {gpa != null ? gpa.toFixed(2) : '—'}
      </td>
      <td className="pr-2 tabular-nums">
        {streak > 0 ? (
          <span className={streak >= 2 ? 'text-red-500 font-bold' : 'text-amber-300 font-bold'}>
            {streak} sem
          </span>
        ) : (
          <span className="text-gray-500">—</span>
        )}
      </td>
      <td className="pr-2">
        <StandingBadge standing={standing} />
      </td>
    </tr>
  )
}

function StandingBadge({ standing }) {
  const cfg = {
    eligible:   { color: 'bg-emerald-900/60 text-emerald-300', label: 'Eligible' },
    probation:  { color: 'bg-amber-900/60 text-amber-300',     label: 'Probation' },
    ineligible: { color: 'bg-red-900/70 text-red-300',         label: 'Ineligible' },
    dismissed:  { color: 'bg-red-950 text-red-400',            label: 'Dismissed' },
  }[standing] || { color: 'bg-gray-800 text-gray-400', label: standing }
  return (
    <span className={`${cfg.color} text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded`}>
      {cfg.label}
    </span>
  )
}
