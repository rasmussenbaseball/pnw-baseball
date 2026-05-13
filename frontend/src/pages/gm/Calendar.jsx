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
  shortDateLabel, seasonWeekForWeek, modeForWeek,
} from '../../gm/engine/gameYear'
import { WEEK_EVENT_SCHEDULE, EVENT_TYPES } from '../../gm/engine/events'

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
  const currentWeek = cal.weekOfYear ?? 1
  const year = cal.year

  // Group weeks into month-ish buckets for visual grouping
  const buckets = useMemo(() => {
    const groups = [
      { name: 'August — Setup', weeks: [1, 2, 3, 4] },
      { name: 'August–September — Fall Camp opens', weeks: [5, 6, 7, 8] },
      { name: 'September–October — Fall Camp + Scrimmages', weeks: [9, 10, 11, 12] },
      { name: 'November — Training', weeks: [13, 14, 15, 16] },
      { name: 'November–December — Training', weeks: [17, 18, 19, 20] },
      { name: 'December–January — Training', weeks: [21, 22, 23] },
      { name: 'January — Spring Practice', weeks: [24, 25, 26] },
      { name: 'February — Opening Day', weeks: [27, 28, 29] },
      { name: 'March — Conference', weeks: [30, 31, 32, 33] },
      { name: 'April — Conference', weeks: [34, 35, 36, 37] },
      { name: 'May — Conference + Postseason', weeks: [38, 39, 40] },
      { name: 'June — Postseason + Portal', weeks: [41, 42, 43, 44] },
      { name: 'June–July — Portal + Draft', weeks: [45, 46, 47, 48] },
      { name: 'July — Draft + Class Finalize', weeks: [49, 50, 51, 52] },
    ]
    return groups
  }, [])

  return (
    <div className="max-w-6xl mx-auto py-6 px-4">
      <Link to={`/gm/dashboard?slot=${slot}`} className="text-sm text-pnw-green hover:underline">← Dashboard</Link>
      <div className="flex justify-between items-end mt-1 mb-4">
        <div>
          <h1 className="text-3xl font-bold text-pnw-slate">Calendar — {year} Cycle</h1>
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
  )
}

function WeekCard({ save, slot, week, year, currentWeek, userSchoolId }) {
  const phase = phaseForWeek(week)
  const req = requiredActionForWeek(save, week)
  const events = WEEK_EVENT_SCHEDULE[week] || []
  const isToday = week === currentWeek
  const isPast = week < currentWeek
  const mode = modeForWeek(week)
  const games = (save.schedule || []).filter(g =>
    g.seasonWeek === seasonWeekForWeek(week)
    && g.type !== 'BYE'
    && (g.homeId === userSchoolId || g.awayId === userSchoolId)
  )
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
          ⚠ Required: {req.label}
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
            ⚾ {games.length} game{games.length === 1 ? '' : 's'}
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
