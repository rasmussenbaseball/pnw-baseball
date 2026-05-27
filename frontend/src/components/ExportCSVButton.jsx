import { useState, useRef, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useTier } from '../hooks/useTier'
import { tierMeets } from '../lib/tiers'

/**
 * ExportCSVButton — small tier-gated button that exports a stat table
 * to a CSV file the user can open in Excel, Google Sheets, R, Python,
 * or any other tool.
 *
 * Props:
 *   data       array of row objects (whatever the table is rendering).
 *              Used as a sync fallback when `fetchAll` isn't provided.
 *   fetchAll   optional async function that returns the full row set
 *              (not just the current page). Called on click. Lets
 *              paginated leaderboards export every qualifying player
 *              instead of only the 50 rows the table is showing.
 *   columns    column defs the table uses: { key, label, render?,
 *              csv?, exportable? }. If `csv` exists we use it; else
 *              if `render` returns a string/number we use that; else
 *              `row[key]`. Columns with `exportable: false` or
 *              `key: 'rank'` are dropped from the CSV (rank is
 *              implied by row order).
 *   filename   base filename (no extension). YYYY-MM-DD.csv appended.
 *   label      optional override for the button text. Default "Export CSV".
 *
 * Access:
 *   coach + dev tiers → button enabled
 *   everyone else     → button rendered as a locked pill with an
 *                       on-click upsell popover. Useful as advertising;
 *                       free users see the feature exists without being
 *                       able to use it.
 *
 * CSV is RFC 4180 compliant (CRLF line endings, fields containing
 * commas/quotes/newlines wrapped in double quotes with internal quotes
 * doubled), so Excel + Sheets + pandas import cleanly.
 */
export default function ExportCSVButton({
  data = [],
  fetchAll = null,
  columns = [],
  filename = 'nwbb_export',
  label = 'Export CSV',
  className = '',
}) {
  const { tier } = useTier()
  const [showLocked, setShowLocked] = useState(false)
  const [busy, setBusy] = useState(false)
  const lockedRef = useRef(null)

  // Click-away to close the locked popover
  useEffect(() => {
    if (!showLocked) return
    const onDown = (e) => {
      if (lockedRef.current && !lockedRef.current.contains(e.target)) {
        setShowLocked(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [showLocked])

  const unlocked = tierMeets(tier, 'coach') // coach or dev
  const noLocalData = !data || data.length === 0
  // We allow the button when fetchAll exists even if local `data` is
  // empty — paginated pages may want to export the full set ad-hoc.
  const empty = noLocalData && !fetchAll

  const handleExport = async () => {
    if (!unlocked) {
      setShowLocked(true)
      return
    }
    if (busy) return
    try {
      setBusy(true)
      let rows = data
      if (fetchAll) {
        const fetched = await fetchAll()
        if (Array.isArray(fetched) && fetched.length > 0) {
          rows = fetched
        }
      }
      if (!rows || rows.length === 0) return
      const csv = buildCSV(rows, columns)
      const date = new Date().toISOString().slice(0, 10)
      downloadCSV(csv, `${filename}_${date}.csv`)
    } catch (err) {
      // Surface a quick alert; nothing fancier needed for a coach-tier
      // utility. The browser console will have the full error.
      console.error('Export failed:', err)
      // eslint-disable-next-line no-alert
      alert('Export failed. Please try again or contact support.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`relative inline-block ${className}`} ref={lockedRef}>
      <button
        type="button"
        onClick={handleExport}
        disabled={(empty && unlocked) || busy}
        title={
          !unlocked
            ? 'Coach & Scout tier required'
            : busy
              ? 'Preparing download…'
              : empty
                ? 'No rows to export'
                : 'Download as CSV'
        }
        className={
          'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition ' +
          (unlocked
            ? 'border-teal-700 bg-teal-50 text-teal-800 hover:bg-teal-100 hover:border-teal-800 dark:border-teal-600 dark:bg-teal-950 dark:text-teal-200 dark:hover:bg-teal-900 disabled:opacity-50 disabled:cursor-not-allowed'
            : 'border-gray-300 bg-gray-50 text-gray-500 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400')
        }
      >
        {unlocked ? <DownloadIcon /> : <LockIcon />}
        {busy ? 'Exporting…' : label}
      </button>

      {showLocked && !unlocked && (
        <div className="absolute right-0 z-30 mt-2 w-72 rounded-lg border border-gray-200 bg-white p-3 text-sm shadow-lg dark:border-gray-700 dark:bg-gray-900">
          <div className="mb-1 font-semibold text-gray-900 dark:text-gray-100">
            Coach & Scout feature
          </div>
          <p className="mb-3 text-gray-600 dark:text-gray-400">
            Data exports (CSV downloads of any stat table) are part of
            the Coach & Scout tier — built for analysts, scouts, and
            coaches who want to slice the numbers their own way.
          </p>
          <div className="flex items-center justify-between gap-2">
            <Link
              to="/pricing"
              className="rounded-md bg-teal-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-800"
              onClick={() => setShowLocked(false)}
            >
              See plans
            </Link>
            <button
              type="button"
              onClick={() => setShowLocked(false)}
              className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// CSV building
// ──────────────────────────────────────────────────────────────

function buildCSV(rows, columns) {
  // Strip decorative columns the table uses for chrome (rank,
  // sticky-name link wrappers, etc.). A column counts as exportable
  // unless explicitly flagged `exportable: false`. Rank is also
  // dropped — CSV row order already carries that information.
  const exportable = columns.filter((c) => {
    if (c.exportable === false) return false
    if (c.key === 'rank') return false
    return true
  })

  const header = exportable.map((c) => csvEscape(c.label || c.key))
  const lines = [header.join(',')]

  for (const row of rows) {
    const cells = exportable.map((c) => csvEscape(cellValue(row, c)))
    lines.push(cells.join(','))
  }
  // RFC 4180 specifies CRLF line endings — Excel + Sheets + pandas
  // all read both \n and \r\n correctly, but CRLF is safest.
  return lines.join('\r\n')
}

function cellValue(row, col) {
  // Prefer the column's own `csv` extractor when supplied (lets a
  // page hand us a custom serializer for derived fields). Then fall
  // back to `render` (used for display) and finally the raw key.
  if (typeof col.csv === 'function') {
    return col.csv(row)
  }
  if (typeof col.render === 'function') {
    // Many render functions return JSX. Only use the rendered output
    // if it's a plain string or number; otherwise fall through to
    // the raw value.
    try {
      const out = col.render(row)
      if (typeof out === 'string' || typeof out === 'number') return out
    } catch (_) { /* fall through */ }
  }
  return row[col.key]
}

function csvEscape(v) {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'string' ? v : String(v)
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

function downloadCSV(csv, filename) {
  // Prepend a UTF-8 BOM so Excel on Windows detects encoding and
  // shows non-ASCII names (José, Núñez, etc.) correctly.
  const blob = new Blob(['﻿', csv], {
    type: 'text/csv;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Revoke after a tick to let the browser commit the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ──────────────────────────────────────────────────────────────
// Icons
// ──────────────────────────────────────────────────────────────

function DownloadIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M8 1.5v9m0 0L4.5 7M8 10.5L11.5 7M2 13.5h12"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function LockIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect
        x="3"
        y="7"
        width="10"
        height="7"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M5 7V5a3 3 0 016 0v2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}
