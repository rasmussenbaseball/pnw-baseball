/**
 * Calendar page — full year-at-a-glance.
 *
 * Shows every offseason week + every season week, with event markers for:
 *   - Postseason wrap events (budget review, draft, transfers, dev, portal)
 *   - Fall scrimmage Fridays
 *   - Prospect camp
 *   - Conference open / regular-season end / tournament / opening round / WS
 *   - Recruiting deadlines
 * Plus the user's own scheduled games for that week (icon + opponent).
 *
 * Each row links to where the user can take action: schedule, recruiting,
 * play page, etc.
 */

import { useMemo } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty } from '../../gm/engine/save'
import {
  offseasonPhase, offseasonWeekDate, formatShortDate, OFFSEASON_WEEKS,
} from '../../gm/engine/calendar'
import { OFFSEASON_EVENT_SCHEDULE, SEASON_EVENT_SCHEDULE, EVENT_TYPES } from '../../gm/engine/events'

const REG_SEASON_WEEKS = 13
const POSTSEASON_WEEKS = 3   // tournament + opening round + WS

export default function Calendar() {
  const { user } = useAuth()
  const [params] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'

  const save = useMemo(() => loadDynasty(userId, slot), [userId, slot])
  if (!save) return <Navigate to="/gm" replace />

  const cal = save.calendar
  const startYear = cal.startYear || cal.year
  const userSchoolId = save.userSchoolId

  // ── Build the calendar rows ──────────────────────────────────────────────
  const rows = []
  // Offseason
  for (let w = 1; w <= OFFSEASON_WEEKS; w++) {
    const eventKeys = OFFSEASON_EVENT_SCHEDULE[w] || []
    const date = offseasonWeekDate(startYear, w)
    rows.push({
      kind: 'offseason',
      week: w,
      label: `Offseason Wk ${w}`,
      phase: offseasonPhase(w),
      dateLabel: formatShortDate(date),
      year: date.getFullYear(),
      events: eventKeys,
      isCurrent: cal.mode === 'OFFSEASON' && cal.offseasonWeek === w,
      isPast: cal.mode === 'OFFSEASON' && cal.offseasonWeek > w,
    })
  }
  // Regular season
  for (let w = 1; w <= REG_SEASON_WEEKS; w++) {
    const eventKeys = SEASON_EVENT_SCHEDULE[w] || []
    const games = (save.schedule || []).filter(g =>
      g.seasonWeek === w
      && g.type !== 'BYE'
      && (g.homeId === userSchoolId || g.awayId === userSchoolId)
    )
    rows.push({
      kind: 'season',
      week: w,
      label: `Season Wk ${w}`,
      phase: w <= 3 ? 'Non-conference' : 'Conference',
      dateLabel: '',
      year: cal.year + 1,
      events: eventKeys,
      games,
      isCurrent: cal.mode === 'SEASON' && cal.seasonWeek === w,
      isPast: cal.mode === 'SEASON' && cal.seasonWeek > w,
    })
  }
  // Postseason
  for (let w = REG_SEASON_WEEKS + 1; w <= REG_SEASON_WEEKS + POSTSEASON_WEEKS; w++) {
    const eventKeys = SEASON_EVENT_SCHEDULE[w] || []
    rows.push({
      kind: 'postseason',
      week: w,
      label: `Season Wk ${w}`,
      phase: 'Postseason',
      dateLabel: '',
      year: cal.year + 1,
      events: eventKeys,
      isCurrent: cal.mode === 'POSTSEASON',
      isPast: false,
    })
  }

  return (
    <div className="max-w-5xl mx-auto py-8 px-4">
      <Link to={`/gm/dashboard?slot=${slot}`} className="text-sm text-pnw-green hover:underline">← Dashboard</Link>
      <h1 className="text-3xl font-bold text-pnw-slate mt-1">Calendar</h1>
      <p className="text-sm text-gray-600 mb-4">
        Year-at-a-glance — every offseason week, every game week, and what major
        event fires when. Use this to plan ahead and make sure nothing slips.
      </p>

      <div className="flex flex-wrap gap-2 mb-4 text-[10px]">
        <LegendChip color="bg-pnw-green" label="Today" />
        <LegendChip color="bg-pnw-cream border border-pnw-green/40" label="Phase boundary / event" textColor="text-pnw-slate" />
        <LegendChip color="bg-amber-100" label="Recruiting / camp" textColor="text-amber-900" />
        <LegendChip color="bg-blue-100" label="Game week" textColor="text-blue-900" />
        <LegendChip color="bg-red-100" label="Postseason" textColor="text-red-900" />
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="grid grid-cols-12 px-3 py-2 text-[10px] uppercase text-gray-500 bg-gray-50 border-b">
          <div className="col-span-2">Week</div>
          <div className="col-span-2">Phase</div>
          <div className="col-span-2">Date</div>
          <div className="col-span-6">Events / Games</div>
        </div>
        {rows.map((r, i) => <CalendarRow key={i} row={r} save={save} slot={slot} />)}
      </div>
    </div>
  )
}

function CalendarRow({ row, save, slot }) {
  const bg = row.isCurrent
    ? 'bg-pnw-green text-white'
    : row.isPast
      ? 'bg-gray-50 text-gray-400'
      : row.kind === 'postseason'
        ? 'bg-red-50/50'
        : row.kind === 'season'
          ? 'bg-blue-50/30'
          : row.events.length > 0
            ? 'bg-pnw-cream/40'
            : 'bg-white'

  return (
    <div className={'grid grid-cols-12 px-3 py-2 text-xs border-b last:border-b-0 ' + bg}>
      <div className="col-span-2 font-semibold">{row.label}</div>
      <div className="col-span-2">{row.phase}</div>
      <div className="col-span-2 text-gray-500">{row.dateLabel} {row.year && <span className="text-gray-400">{row.year}</span>}</div>
      <div className="col-span-6 flex flex-wrap gap-1.5 items-center">
        {row.events.map(k => (
          <EventChip key={k} eventKey={k} />
        ))}
        {row.games && row.games.length > 0 && (
          <GamesBadge games={row.games} userSchoolId={save.userSchoolId} save={save} slot={slot} />
        )}
        {row.events.length === 0 && (!row.games || row.games.length === 0) && (
          <span className="text-gray-300">—</span>
        )}
      </div>
    </div>
  )
}

function EventChip({ eventKey }) {
  const meta = EVENT_TYPES[eventKey]
  if (!meta) return null
  const isMarker = !RUN_EVENTS.has(eventKey)
  return (
    <span
      className={'inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold ' +
        (isMarker ? 'bg-amber-100 text-amber-900' : 'bg-pnw-cream text-pnw-slate border border-pnw-green/40')}
      title={meta.desc}
    >
      {meta.label}
    </span>
  )
}

const RUN_EVENTS = new Set([
  'BUDGET_REVIEW', 'END_OF_TERM_ACADEMICS', 'PLAYER_DEVELOPMENT',
  'MLB_DRAFT', 'HS_ATTRITION', 'PORTAL_OPEN',
  'OUTBOUND_TRANSFERS_MID', 'OUTBOUND_TRANSFERS_LATE',
])

function GamesBadge({ games, userSchoolId, save, slot }) {
  const count = games.length
  // Just count games + show first opponent label
  const first = games[0]
  const opp = first.homeId === userSchoolId ? first.awayId : first.homeId
  const oppName = save.schools[opp]?.name || (count > 1 ? 'series' : 'game')
  return (
    <Link
      to={`/gm/play?slot=${slot}`}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-100 text-blue-900 text-[10px] font-semibold hover:bg-blue-200"
    >
      ⚾ {count}-game vs {oppName}
    </Link>
  )
}

function LegendChip({ color, label, textColor = 'text-white' }) {
  return (
    <span className={'inline-flex items-center gap-1 px-2 py-0.5 rounded ' + color + ' ' + textColor + ' font-semibold uppercase tracking-wider'}>
      {label}
    </span>
  )
}
