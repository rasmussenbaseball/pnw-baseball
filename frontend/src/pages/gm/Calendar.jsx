/**
 * Calendar page — full 52-week year-at-a-glance.
 *
 * The unified calendar (gameYear.js) is the spine of the game. This page is
 * the user-facing view of it: every week from Aug 1 to late July, with the
 * phase, the date, any scheduled events, and a chip for the user's own games
 * that week.
 *
 * Today's row is highlighted in pnw-green; past weeks ghosted; future weeks
 * tinted by phase (cream for tutorial/event weeks, blue for season, red for
 * postseason, amber for portal/draft).
 */

import { useMemo } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty } from '../../gm/engine/save'
import {
  WEEKS_PER_YEAR, phaseForWeek, requiredActionForWeek, ensureUnifiedCalendar,
  shortDateLabel, seasonWeekForWeek, modeForWeek, dateForWeek,
} from '../../gm/engine/gameYear'
import { WEEK_EVENT_SCHEDULE, EVENT_TYPES } from '../../gm/engine/events'
import GMShell from '../../gm/components/GMShell'

const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

export default function Calendar() {
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

  const cal = save.calendar
  const userSchoolId = save.userSchoolId
  const userSchool = save.schools[userSchoolId]
  const currentWeek = cal.weekOfYear ?? 1
  const year = cal.year

  // Group weeks by the ACTUAL month their start date falls in. Previously
  // these were hardcoded ranges that drifted off the real calendar (the
  // World Series was showing under June even though it's May 22).
  const buckets = useMemo(() => {
    const byMonth = new Map()    // monthIndex (0-11) { firstWeek, weeks: [] }
    for (let w = 1; w <= WEEKS_PER_YEAR; w++) {
      const d = dateForWeek(year, w)
      const m = d.getUTCMonth()
      if (!byMonth.has(m)) byMonth.set(m, { monthIndex: m, weeks: [] })
      byMonth.get(m).weeks.push(w)
    }
    // Preserve calendar order: Aug starts the dynasty year, so begin at month 7
    // and wrap through to July (month 6).
    const ordered = []
    for (let i = 0; i < 12; i++) {
      const m = (7 + i) % 12
      if (byMonth.has(m)) ordered.push(byMonth.get(m))
    }
    return ordered.map(b => {
      // Phase label derived from the dominant phase across the bucket
      const phases = b.weeks.map(w => phaseForWeek(w).label)
      const distinct = [...new Set(phases)]
      const title = distinct.length <= 2
        ? distinct.join(' + ')
        : `${distinct[0]} ${distinct[distinct.length - 1]}`
        return {
        name: `${MONTH_LONG[b.monthIndex]} — ${title}`,
        weeks: b.weeks,
      }
    })
  }, [year])

  return (
    <GMShell schoolName={userSchool?.name} schoolColors={userSchool?.colors}>
    <div className="max-w-6xl mx-auto">
      <div className="flex justify-between items-end mt-1 mb-4">
        <div>
          <h1 className="font-pixel-display text-xl tracking-widest text-white">CALENDAR · {year}</h1>
          <p className="text-sm text-gray-600">
            Full 52-week year. Currently at Week {currentWeek} · {phaseForWeek(currentWeek).label}.
          </p>
        </div>
        <div className="text-right text-xs text-gray-500">
          Hover events for details. Numbers in dark = today.
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-4 text-[10px]">
        <Legend color="bg-pnw-green text-white" label="Today" />
        <Legend color="bg-amber-100 text-amber-900" label="Required action" />
        <Legend color="bg-pnw-cream text-pnw-slate" label="Event week" />
        <Legend color="bg-blue-100 text-blue-900" label="Season" />
        <Legend color="bg-red-100 text-red-900" label="Postseason" />
        <Legend color="bg-purple-100 text-purple-900" label="Portal / Draft" />
        <Legend color="bg-gray-100 text-gray-500" label="Past" />
      </div>

      <div className="space-y-4">
        {buckets.map(b => (
          <div key={b.name}>
            <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-1">{b.name}</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
              {b.weeks.map(w => (
                <WeekCard key={w} save={save} slot={slot} week={w} year={year} currentWeek={currentWeek} userSchoolId={userSchoolId} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
    </GMShell>
  )
}

function WeekCard({ save, slot, week, year, currentWeek, userSchoolId }) {
  const phase = phaseForWeek(week)
  const req = requiredActionForWeek(save, week)
  const events = WEEK_EVENT_SCHEDULE[week] || []
  const isToday = week === currentWeek
  const isPast = week < currentWeek
  const mode = modeForWeek(week)
  // Match by seasonWeek (regular-season / postseason) OR weekOfYear (fall
  // scrimmages, which carry the unified-calendar tag). Old saves' fall
  // games are missing weekOfYear — fall back to the date-derived check.
  const sw = seasonWeekForWeek(week)
  const games = (save.schedule || []).filter(g => {
    if (g.type === 'BYE') return false
    if (g.awayId === '__BYE__') return false
    if (g.homeId !== userSchoolId && g.awayId !== userSchoolId) return false
    if (sw != null && g.seasonWeek === sw) return true
    if (g.weekOfYear === week) return true
    return false
  })
  // Color theme based on phase / state
  const isPortalWeek = week >= 43 && week <= 51
  const isDraftOrFinalize = week === 48 || week === 52
  const tint = isToday
    ? 'bg-pnw-green text-white'
    : isPast
      ? 'bg-gray-50 text-gray-400'
      : req
        ? 'bg-amber-100 text-amber-900 border border-amber-300'
        : mode === 'POSTSEASON'
          ? 'bg-red-50'
          : mode === 'SEASON'
            ? 'bg-blue-50'
            : (isPortalWeek || isDraftOrFinalize)
              ? 'bg-purple-50'
              : events.length > 0
                ? 'bg-pnw-cream'
                : 'bg-white border border-gray-200'

  return (
    <div className={'rounded-lg p-2.5 text-xs ' + tint + (isToday ? ' shadow-md' : '')}>
      <div className="flex justify-between items-baseline mb-1">
        <div className="font-bold">Wk {week}</div>
        <div className={'text-[10px] ' + (isToday ? 'text-white/80' : 'text-gray-500')}>
          {shortDateLabel(year, week)}
        </div>
      </div>
      <div className={'font-semibold mb-1 ' + (isToday ? '' : isPast ? '' : 'text-pnw-slate')}>
        {phase.label}
      </div>
      {req && (
        <div className={'text-[10px] mb-1 ' + (isToday ? 'text-white' : 'text-amber-800 font-semibold')}>
           Required: {req.label}
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        {events.map(ek => {
          const meta = EVENT_TYPES[ek]
          if (!meta) return null
          return (
            <span
              key={ek}
              title={meta.desc}
              className={'inline-block px-1 py-0.5 rounded text-[9px] font-semibold ' +
                (isToday ? 'bg-white/20' : isPast ? 'bg-gray-100 text-gray-400' : 'bg-white border border-gray-200 text-gray-700')}
            >
              {meta.label}
            </span>
          )
        })}
        {games.length > 0 && (
          <Link
            to={`/gm/play?slot=${slot}`}
            className={'inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold ' +
              (isToday ? 'bg-white text-pnw-green' : 'bg-blue-100 text-blue-900 hover:bg-blue-200')}
          >
             {games.length} game{games.length === 1 ? '' : 's'}
          </Link>
        )}
        {events.length === 0 && games.length === 0 && !req && (
          <span className={'text-[10px] ' + (isToday ? 'text-white/60' : 'text-gray-300')}>—</span>
        )}
      </div>
    </div>
  )
}

function Legend({ color, label }) {
  return (
    <span className={'inline-flex items-center px-2 py-0.5 rounded font-semibold uppercase tracking-wider ' + color}>
      {label}
    </span>
  )
}
