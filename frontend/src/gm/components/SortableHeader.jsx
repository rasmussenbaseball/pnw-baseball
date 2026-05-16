/**
 * SortableHeader + useTableSort — drop-in sortable table column headers
 * for any GM page table.
 *
 * Usage:
 *   const { sortKey, sortDir, toggleSort, sortRows } = useTableSort(
 *     'gpa',         // initial sort key
 *     'asc',         // initial direction
 *     {              // columnExtractors — getter fn per key
 *       gpa: r => r.gpa ?? 999,
 *       ovr: r => r._ovr,
 *       name: r => r.lastName.toLowerCase(),
 *     }
 *   )
 *
 *   <thead>
 *     <tr>
 *       <SortableHeader sortKey={sortKey} dir={sortDir} onSort={toggleSort} k="name" label="Name" />
 *       <SortableHeader ... k="gpa" label="GPA" align="right" />
 *     </tr>
 *   </thead>
 *   <tbody>
 *     {sortRows(rows).map(...)}
 *   </tbody>
 */

import { useMemo, useState } from 'react'

export default function SortableHeader({ sortKey, dir, onSort, k, label, align = 'left', className = '' }) {
  const active = sortKey === k
  const indicator = active ? (dir === 'asc' ? '▲' : '▼') : '↕'
  const alignClass = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'
  return (
    <th
      onClick={() => onSort(k)}
      className={
        'cursor-pointer select-none hover:text-white transition ' +
        alignClass + ' ' +
        (active ? 'text-amber-300 ' : 'text-[#a8a8c8] ') +
        className
      }
      title="Click to sort"
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className={'text-[9px] ' + (active ? 'opacity-100' : 'opacity-40')}>{indicator}</span>
      </span>
    </th>
  )
}

/**
 * Sort hook. Returns the current sort state plus a sortRows helper.
 *
 * @param {string} initialKey
 * @param {'asc'|'desc'} initialDir
 * @param {Object<string, (row: any) => any>} extractors  per-key value getters
 */
export function useTableSort(initialKey, initialDir = 'asc', extractors = {}) {
  const [sortKey, setSortKey] = useState(initialKey)
  const [sortDir, setSortDir] = useState(initialDir)

  function toggleSort(k) {
    if (k === sortKey) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(k)
      // First click goes desc for most stat columns (you want the BEST first);
      // but stays asc for name. Default to asc; caller can also set initialDir.
      setSortDir(k.toLowerCase().includes('name') ? 'asc' : 'desc')
    }
  }

  const sortRows = useMemo(() => {
    return function sortFn(rows) {
      const extractor = extractors[sortKey]
      if (!extractor) return rows
      const dirMult = sortDir === 'asc' ? 1 : -1
      const sorted = [...rows].sort((a, b) => {
        const av = extractor(a)
        const bv = extractor(b)
        if (av == null && bv == null) return 0
        if (av == null) return 1     // nulls always last
        if (bv == null) return -1
        if (typeof av === 'string' && typeof bv === 'string') {
          return dirMult * av.localeCompare(bv)
        }
        return dirMult * (av - bv)
      })
      return sorted
    }
  }, [sortKey, sortDir, extractors])

  return { sortKey, sortDir, toggleSort, sortRows }
}
