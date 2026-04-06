import { useState, useEffect } from 'react'

const LEVEL_LABELS = {
  D1: 'NCAA D1',
  D2: 'NCAA D2',
  D3: 'NCAA D3',
  NAIA: 'NAIA',
  JUCO: 'JUCO',
}

function formatTimestamp(isoString) {
  const d = new Date(isoString)
  const now = new Date()
  const diffMs = now - d
  const diffHrs = Math.floor(diffMs / (1000 * 60 * 60))
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  const pacific = { timeZone: 'America/Los_Angeles' }
  const timeStr = d.toLocaleTimeString('en-US', {
    ...pacific,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
  const dateStr = d.toLocaleDateString('en-US', {
    ...pacific,
    month: 'short',
    day: 'numeric',
  })

  if (diffDays === 0) {
    if (diffHrs < 1) return `Updated just now`
    return `Updated today at ${timeStr}`
  } else if (diffDays === 1) {
    return `Updated yesterday at ${timeStr}`
  }
  return `Updated ${dateStr} at ${timeStr}`
}

/**
 * Shows when stats were last updated, per division level.
 *
 * Props:
 *  - levels: optional array like ['D1','D2'] to filter which levels to show.
 *            If omitted, shows all levels that have data.
 *  - className: optional extra classes for the wrapper
 */
export default function StatsLastUpdated({ levels, className = '' }) {
  const [data, setData] = useState(null)

  useEffect(() => {
    fetch('/api/v1/stats/last-updated')
      .then((r) => r.json())
      .then(setData)
      .catch(() => {})
  }, [])

  if (!data || Object.keys(data).length === 0) return null

  const entries = levels
    ? levels.filter((l) => data[l]).map((l) => [l, data[l]])
    : Object.entries(data)

  if (entries.length === 0) return null

  return (
    <div className={`flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-400 ${className}`}>
      {entries.map(([level, ts]) => (
        <span key={level} title={new Date(ts).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) + ' PT'}>
          <span className="font-medium text-gray-500">{LEVEL_LABELS[level] || level}:</span>{' '}
          {formatTimestamp(ts)}
        </span>
      ))}
    </div>
  )
}
