// /summer/scoreboard — Scoreboard + Calendar tabs.
import { useState } from 'react'
import SummerPageShell from './SummerPageShell'
import { Scoreboard, ScheduleCalendar } from '../SummerHub'

export default function SummerScoreboardPage() {
  const [view, setView] = useState('list')
  return (
    <SummerPageShell
      title="WCL Scoreboard"
      subtitle="Recent + upcoming games. Click any game for the box score."
      headerExtra={
        <div className="inline-flex rounded-md border border-gray-300 dark:border-gray-600 overflow-hidden text-sm shrink-0">
          {[['list', 'Card list'], ['calendar', 'Calendar']].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setView(key)}
              className={`px-3 py-1.5 font-semibold transition ${
                view === key
                  ? 'bg-nw-teal text-white'
                  : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      }
    >
      {view === 'list' ? <Scoreboard /> : <ScheduleCalendar />}
    </SummerPageShell>
  )
}
